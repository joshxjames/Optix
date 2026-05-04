// Stripe checkout flow — main-process orchestration.
//
// The renderer can't open a browser window or run an HTTP server itself,
// so this file owns the parts that need privileged APIs:
//
//   1. Spin up a 127.0.0.1 loopback server (one-shot) so Stripe Checkout
//      has somewhere to redirect after success/cancel.
//   2. Call our `createCheckoutSession` Cloud Function with the user's
//      Firebase ID token to get a Checkout URL.
//   3. Open the Checkout URL in the user's default browser via
//      `shell.openExternal`.
//   4. Push the loopback hit back to the renderer so it can refresh the
//      subscription state from Firestore.
//
// Same pattern + same loopback infra as the magic-link sign-in flow.

import { ipcMain, BrowserWindow, shell } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  isLoopbackActive,
  startLoopbackServer,
  stopLoopbackServer,
  type LoopbackPathConfig,
} from '@main/auth/loopback-server';
import { isAllowedStripeUrl } from '@main/security/safe-url';

// Tracks whether the currently-active loopback (if any) was started by
// stripe.startCheckout — so cancelCheckout doesn't accidentally tear
// down a magic-link sign-in's loopback when the user dismisses a
// checkout dialog they never actually opened.
let stripeOwnsLoopback = false;

const CREATE_CHECKOUT_SESSION_URL =
  'https://us-central1-optix-22473.cloudfunctions.net/createCheckoutSession';
const UPDATE_SUBSCRIPTION_URL =
  'https://us-central1-optix-22473.cloudfunctions.net/updateSubscription';
const CREATE_PORTAL_SESSION_URL =
  'https://us-central1-optix-22473.cloudfunctions.net/createPortalSession';

const StartCheckoutRequestSchema = z
  .object({
    tier: z.enum(['starter', 'pro']),
    /** Firebase ID token, freshly minted by the renderer. The Cloud
     *  Function verifies it before creating the Stripe session. */
    // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
    authToken: z.string().min(100).max(5000),
  })
  .strict();

const OpenCustomerPortalRequestSchema = z
  .object({
    // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
    authToken: z.string().min(100).max(5000),
  })
  .strict();

const UpdateSubscriptionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('switchPlan'),
      tier: z.enum(['starter', 'pro']),
      // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
      authToken: z.string().min(100).max(5000),
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
      authToken: z.string().min(100).max(5000),
    })
    .strict(),
  z
    .object({
      action: z.literal('reactivate'),
      // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
      authToken: z.string().min(100).max(5000),
    })
    .strict(),
]);

/** Per-flow landing HTML — same visual frame as the magic-link page,
 *  different copy so the user knows what just happened. The browser
 *  closes itself manually; the widget continues from the IPC callback. */
const CHECKOUT_SUCCESS_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Subscription confirmed</title>
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
  <h1>Subscription confirmed</h1>
  <p>You can close this tab — Optix is unlocking your plan now.</p>
</div>
`;

const CHECKOUT_CANCEL_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Checkout cancelled</title>
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
  <h1>Checkout cancelled</h1>
  <p>No charge was made. You can close this tab and return to the widget.</p>
</div>
`;

export function registerStripeIpc(): void {
  ipcMain.handle(IPC.stripe.startCheckout, async (event, raw: unknown) => {
    const req = StartCheckoutRequestSchema.parse(raw);
    const senderId = event.sender.id;

    // Reject overlap. If a magic-link sign-in (or another checkout) is
    // already holding the loopback, kicking off a fresh one would tear
    // the first down silently and leave whichever flow lost the race
    // broken — better to surface the conflict to the user.
    if (isLoopbackActive()) {
      throw new Error(
        'Another sign-in or checkout is already in progress. Finish or cancel it first.',
      );
    }

    // Bind the loopback BEFORE the Checkout session is created so we
    // know the port to embed in the success/cancel URLs. Pre-binding
    // also catches local-port-conflict errors before the network call.
    const paths: LoopbackPathConfig[] = [
      { path: '/checkout-success', html: CHECKOUT_SUCCESS_HTML },
      { path: '/checkout-cancel', html: CHECKOUT_CANCEL_HTML },
    ];
    const { port } = await startLoopbackServer((url) => {
      // Push the hit back to the originating renderer. We pass the full
      // URL — the renderer parses the path to distinguish success vs
      // cancel, then refreshes Firestore-derived state.
      const win = BrowserWindow.fromId(senderId);
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.stripe.checkoutCallback, { url });
    }, { paths });
    // Mark ownership only after the server is actually up — if the
    // bind threw, the auth flow may already own the loopback and we
    // mustn't claim it.
    stripeOwnsLoopback = true;

    const successUrl = `http://127.0.0.1:${port}/checkout-success`;
    const cancelUrl = `http://127.0.0.1:${port}/checkout-cancel`;

    // Call our Cloud Function. Bearer the user's ID token; the function
    // verifies and creates the Stripe Checkout session. Network failures
    // here leave the loopback running — the renderer surfaces the error
    // and the watchdog tears the server down after the timeout.
    let checkoutUrl: string;
    try {
      const res = await fetch(CREATE_CHECKOUT_SESSION_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${req.authToken}`,
        },
        body: JSON.stringify({
          tier: req.tier,
          successUrl,
          cancelUrl,
        }),
      });
      if (!res.ok) {
        // Log the full body server-side so an operator can diagnose,
        // but don't propagate Cloud Function internals to the renderer
        // (which would surface them in a user-facing error toast).
        const errBody = await res.text();
        console.error(
          `[stripe] createCheckoutSession failed (HTTP ${res.status}): ${errBody}`,
        );
        throw new Error(
          `createCheckoutSession failed (HTTP ${res.status}). See main process logs for details.`,
        );
      }
      const json = (await res.json()) as { checkoutUrl?: string };
      if (!json.checkoutUrl) {
        throw new Error('createCheckoutSession returned no URL.');
      }
      checkoutUrl = json.checkoutUrl;
    } catch (err) {
      // Tear down the loopback we just started — and clear ownership
      // so a subsequent cancelCheckout no-ops correctly.
      stopLoopbackServer();
      stripeOwnsLoopback = false;
      throw err;
    }

    // Defense-in-depth: the Cloud Function only ever returns Stripe URLs,
    // but validate the hostname + scheme before opening. A compromised
    // relay shouldn't be able to redirect the user's browser anywhere
    // off-Stripe. Tear the loopback down on rejection so the flow
    // doesn't leak a server into the next attempt.
    if (!isAllowedStripeUrl(checkoutUrl)) {
      stopLoopbackServer();
      stripeOwnsLoopback = false;
      throw new Error(
        'Refusing to open checkout URL: not a Stripe-hosted https endpoint.',
      );
    }

    // Hand off to the user's default browser. Stripe's hosted Checkout
    // page handles cards, Apple/Google Pay, 3DS — all the parts a
    // desktop app shouldn't reimplement. The user comes back via the
    // loopback redirect when they're done.
    void shell.openExternal(checkoutUrl);

    return { checkoutUrl };
  });

  ipcMain.handle(IPC.stripe.cancelCheckout, async () => {
    // No-op if no checkout is active — an unconditional stop here
    // would tear down a concurrent magic-link sign-in's loopback (the
    // two flows share the same single-server resource). The ownership
    // flag tells us the loopback is ours to stop.
    if (!stripeOwnsLoopback) return;
    stopLoopbackServer();
    stripeOwnsLoopback = false;
  });

  ipcMain.handle(IPC.stripe.updateSubscription, async (_event, raw: unknown) => {
    const req = UpdateSubscriptionRequestSchema.parse(raw);
    // Strip the auth token from the body — it goes in the Authorization
    // header, not the JSON payload. The Cloud Function rejects unknown
    // fields cleanly, but no reason to send it twice.
    const { authToken, ...payload } = req;
    const res = await fetch(UPDATE_SUBSCRIPTION_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // Log the full body server-side so an operator can diagnose,
      // but don't propagate Cloud Function internals to the renderer.
      const errBody = await res.text();
      console.error(
        `[stripe] updateSubscription failed (HTTP ${res.status}): ${errBody}`,
      );
      throw new Error(
        `updateSubscription failed (HTTP ${res.status}). See main process logs for details.`,
      );
    }
    // Stripe webhook will fire customer.subscription.updated and the
    // user's Firestore profile flips to reflect the change — the
    // renderer's onSnapshot listener picks it up. We just wait for
    // the network call to ack and return success.
    return { success: true as const };
  });

  ipcMain.handle(IPC.stripe.openCustomerPortal, async (_event, raw: unknown) => {
    // Stripe Customer Portal — hosted page where the user can update
    // their card, view invoices, cancel/reactivate. We just hand off
    // the URL to the user's default browser; no loopback needed since
    // any state changes propagate via webhooks (`customer.updated`,
    // `customer.subscription.updated`) which our handler already
    // reflects to Firestore.
    const req = OpenCustomerPortalRequestSchema.parse(raw);
    const res = await fetch(CREATE_PORTAL_SESSION_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.authToken}`,
      },
      // Empty body is fine — the Cloud Function pulls the customer
      // from Firestore using the verified uid. We could pass a
      // returnUrl pointing at our loopback for a smoother "back to
      // widget" UX, but Stripe's "Return" button is optional and the
      // user usually just closes the tab.
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error(
        `[stripe] createPortalSession failed (HTTP ${res.status}): ${errBody}`,
      );
      // 404 = no customer yet. Surface a specific message so the
      // renderer can show "subscribe first" instead of a generic
      // failure toast.
      if (res.status === 404) {
        throw new Error(
          'No saved payment method yet. Subscribe to a plan first.',
        );
      }
      throw new Error(
        `Could not open billing portal (HTTP ${res.status}). See main process logs for details.`,
      );
    }
    const json = (await res.json()) as { portalUrl?: string };
    if (!json.portalUrl) {
      throw new Error('Billing portal session returned no URL.');
    }
    // Defense-in-depth: same hostname/scheme check as startCheckout. The
    // Cloud Function only returns Stripe URLs in normal operation; this
    // guards against a relay bug or compromise redirecting elsewhere.
    if (!isAllowedStripeUrl(json.portalUrl)) {
      throw new Error(
        'Refusing to open billing portal URL: not a Stripe-hosted https endpoint.',
      );
    }
    void shell.openExternal(json.portalUrl);
    return { portalUrl: json.portalUrl };
  });
}
