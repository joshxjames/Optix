// Centralised URL gatekeeping for `shell.openExternal` and friends.
//
// Why this exists: Electron's `shell.openExternal` will happily launch
// `file://`, `javascript:`, custom-scheme URIs, etc. — anything the OS
// has a handler for. A prompt-injected agent or compromised search
// result could craft URLs that phish, leak data, or execute scripts.
// The whitelist below is conservative: only HTTP and HTTPS get through.

import { shell } from 'electron';

/** True iff `url` parses cleanly and uses an HTTP(S) scheme. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Defense-in-depth check for the URLs returned by our Stripe Cloud
 *  Functions before we hand them to `shell.openExternal`. The Cloud
 *  Function only ever returns Stripe-hosted URLs, but a misbehaving
 *  relay (or a future bug there) shouldn't be able to redirect the
 *  user's browser to an arbitrary domain. We require https + a
 *  *.stripe.com hostname.
 *
 *  Allowlist semantics:
 *  - scheme MUST be https (no http, no data:, no javascript:)
 *  - hostname MUST be `stripe.com` or a subdomain thereof. The regex
 *    `(^|\.)stripe\.com$` matches `stripe.com`, `checkout.stripe.com`,
 *    `billing.stripe.com`, etc., but NOT `stripe.com.evil.example` or
 *    `notstripe.com` (the leading anchor is `.` or start-of-string).
 *
 *  Residual risk: subdomain takeover. If Stripe ever leaves a CNAME
 *  pointing at an unclaimed cloud resource, an attacker could in
 *  principle host content at `*.stripe.com`. We accept this risk —
 *  Stripe's security posture is the bar; we trust the apex domain
 *  unconditionally. Tightening to a specific subdomain (e.g. only
 *  `checkout.stripe.com`) would break legitimate redirects between
 *  Stripe's own hosted pages. */
export function isAllowedStripeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)stripe\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Open an external URL via the OS handler, only if it's HTTP(S).
 *  Returns true on success, false if the URL was blocked or
 *  `shell.openExternal` rejected. Logs blocked attempts so a
 *  prompt-injection probe is visible in the audit trail. */
export async function safeOpenExternal(url: string): Promise<boolean> {
  if (!isSafeExternalUrl(url)) {
    console.warn(
      '[optix-security] blocked openExternal for non-http(s) URL:',
      url.length > 200 ? url.slice(0, 200) + '…' : url,
    );
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.warn(
      '[optix-security] openExternal threw:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
