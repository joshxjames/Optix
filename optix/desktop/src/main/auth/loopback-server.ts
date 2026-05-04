// Localhost loopback HTTP server for the magic-link sign-in callback.
//
// Why this exists: Firebase Auth's email-link flow sends the user a link
// containing `?oobCode=...`. They click it in their default browser. We
// need that URL back inside the widget so the renderer can call
// `signInWithEmailLink(...)` to complete the sign-in. The standard
// desktop-app pattern is a one-shot HTTP server bound to 127.0.0.1 on an
// ephemeral port — the magic link's `continueUrl` points at it, the
// browser hits it, we read the URL, then shut the server down.
//
// Lifecycle: started when the renderer asks for a port (right before it
// calls `sendSignInLinkToEmail`), stopped on callback OR on timeout OR on
// app quit. The server NEVER accepts requests from anywhere except
// 127.0.0.1, and it only matches `/callback` — anything else gets a 404.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// 10-minute hard limit. Magic links have a long-ish TTL but if the user
// abandons the flow we don't want a stray server hanging around. Each
// successful callback short-circuits this; the timeout only fires for
// abandoned attempts.
const TIMEOUT_MS = 10 * 60 * 1000;

// One server at a time. If the user clicks "Send sign-in link" a second
// time mid-flow, we tear down the first server before opening a new one.
let active: {
  server: Server;
  port: number;
  timeoutHandle: NodeJS.Timeout;
} | null = null;

/** HTML factory for the page the user's browser sees after the redirect.
 *  Single function so all loopback flows share a consistent visual style;
 *  the only thing that varies is the heading and the body text. */
function renderLandingPage(heading: string, message: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>${heading}</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, Segoe UI, sans-serif;
         margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0e0f12; color: #e6e7eb; }
  .card { padding: 28px 36px; max-width: 420px; text-align: center;
          background: #15171c; border-radius: 14px; border: 1px solid #2a2c34; }
  h1 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
  p { margin: 0; opacity: 0.75; }
</style>
<div class="card">
  <h1>${heading}</h1>
  <p>${message}</p>
</div>
`;
}

/** Default Firebase magic-link landing page. */
const AUTH_SUCCESS_HTML = renderLandingPage(
  'Signed in to Optix Cloud',
  'You can close this tab and return to the widget.',
);

export type StartLoopbackResult = { port: number };

/** Per-path response config — lets each flow customise the HTML the
 *  browser sees after the redirect. `accepted` is the path itself; the
 *  callback fires only for these. Anything else 404s. */
export type LoopbackPathConfig = {
  path: string;
  html?: string;
};

/**
 * Start a fresh loopback server. Resolves once the listener is bound and
 * returns the chosen port. `onCallback` fires exactly once with the full
 * URL the user's browser hit — the caller decides what to do based on
 * the URL's pathname (e.g. distinguish checkout success vs cancel).
 *
 * The default `paths` config keeps the original auth flow working: a
 * single `/callback` route showing the magic-link landing page. Other
 * flows pass their own paths + HTML.
 *
 * If a previous server is still running, it is silently shut down — we
 * only ever have one in-flight loopback at a time across the app.
 */
export async function startLoopbackServer(
  onCallback: (url: string) => void,
  options: { paths?: LoopbackPathConfig[] } = {},
): Promise<StartLoopbackResult> {
  const paths: LoopbackPathConfig[] =
    options.paths && options.paths.length > 0
      ? options.paths
      : [{ path: '/callback', html: AUTH_SUCCESS_HTML }];
  // Tear down any prior server. Don't fire its callback — the user has
  // moved on. Avoid logging noise; this is normal during retries.
  if (active) stopLoopbackServer();

  const server = createServer((req, res) => {
    // Defense-in-depth: even though we bind to 127.0.0.1, a WSL bridge
    // or misbehaving local proxy could surface non-loopback peers.
    // Reject anything that isn't an explicit loopback address.
    const remote = req.socket.remoteAddress ?? '';
    const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
    if (!LOOPBACK.has(remote)) {
      console.warn(
        `[optix-auth] rejected non-loopback connection from ${remote}`,
      );
      res.removeHeader('Server');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
      req.socket.destroy();
      return;
    }

    // Match the request path against our configured set. Anything else
    // 404s — protects against probes from other local processes and
    // accidental hits from the user's browser history.
    const reqPath = (req.url ?? '').split('?')[0] ?? '';
    const matched = paths.find((p) => p.path === reqPath);
    if (!matched) {
      res.removeHeader('Server');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    // Reconstruct the absolute URL the browser hit so the renderer
    // can pass it verbatim into Firebase's `signInWithEmailLink`. The
    // Firebase SDK validates the URL's query params (oobCode, apiKey,
    // mode, lang, continueUrl) — we don't parse them ourselves.
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    const fullUrl = `http://127.0.0.1:${port}${req.url ?? ''}`;

    // Invoke onCallback FIRST so we can surface app-side failure to the
    // user's browser tab. If it throws, the success page would lie about
    // a working sign-in; show a graceful error message instead.
    let callbackOk = true;
    try {
      onCallback(fullUrl);
    } catch (err) {
      callbackOk = false;
      console.error('[optix-auth] onCallback threw:', err);
    }

    res.removeHeader('Server');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (callbackOk) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(matched.html ?? AUTH_SUCCESS_HTML);
    } else {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        renderLandingPage(
          'Sign-in could not complete',
          'You can close this tab — but the app reported an error. ' +
            'Please return to Optix and try again.',
        ),
      );
    }

    // One-shot: this listener has done its job. Tear down the server
    // immediately so port + watchdog timer are released.
    stopLoopbackServer();
  });

  // Bind to 127.0.0.1 explicitly. Without this Node defaults to all
  // interfaces (`::`) which would expose the callback URL on the LAN —
  // an unnecessary attack surface for a short-lived auth listener.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo | null)?.port ?? 0;
  if (port === 0) {
    server.close();
    throw new Error('Loopback server failed to acquire a port.');
  }

  // Watchdog: if the user never clicks the email link (or clicks an
  // older one), don't leak a listener. 10 minutes is generous; magic
  // links live longer than this server, so timing out doesn't break the
  // flow — the user just clicks "Send link" again.
  const timeoutHandle = setTimeout(() => {
    console.log('[optix-auth] loopback timed out waiting for callback');
    stopLoopbackServer();
  }, TIMEOUT_MS);

  active = { server, port, timeoutHandle };
  console.log(`[optix-auth] loopback listening on 127.0.0.1:${port}`);
  return { port };
}

/** Whether a loopback server is currently bound. Callers use this to
 *  reject overlapping flows (e.g. a checkout attempt while a magic-link
 *  sign-in is mid-flight) instead of silently tearing the first one
 *  down — the alternative would break whichever flow lost the race. */
export function isLoopbackActive(): boolean {
  return active !== null;
}

/** Stop the running loopback server, if any. Idempotent. */
export function stopLoopbackServer(): void {
  if (!active) return;
  const { server, timeoutHandle } = active;
  clearTimeout(timeoutHandle);
  // close() refuses new connections + waits for existing ones to drain.
  // We don't await — drain takes ~0ms because no long-lived connections
  // are expected to a one-shot callback endpoint.
  server.close();
  active = null;
}
