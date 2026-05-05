// IPC bridge for the magic-link sign-in flow.
//
// Renderer drives the flow — it calls `startLoopback` to obtain an
// ephemeral port, embeds that port in the magic link's `continueUrl`,
// then waits for the `loopbackCallback` push event when the user's
// browser hits the local server. The actual Firebase `signInWithEmail
// Link` call happens in the renderer (the SDK keeps auth state there).

import { ipcMain, BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  isLoopbackActive,
  startLoopbackServer,
  stopLoopbackServer,
} from '@main/auth/loopback-server';

// Pending sign-in email — stashed in main-process memory between the
// user clicking 'Send link' and the loopback callback firing.
//
// Threat model: a single module-level `pendingSignInEmail` variable
// lets ANY renderer overwrite ANY other renderer's pending email. A
// compromised settings-popout (or future spawned window) could call
// `setPendingEmail('attacker@x')` mid-flow, causing the legitimate
// renderer's `consumePendingEmail` to return the attacker's address —
// the user then signs in as the attacker.
//
// Mitigation: per-sender slots keyed by `event.sender.id`. Each
// renderer has its own entry; one cannot overwrite another's. Reads
// only succeed when the consuming sender matches the setter, so a
// racing window can't pluck an email from someone else's slot. A
// 5-minute TTL caps the exposure window if a flow is abandoned, and
// destroyed-webContents listeners drop entries promptly.
type PendingEntry = { email: string; expiresAt: number };
const pendingEmails = new Map<number, PendingEntry>();

const PENDING_EMAIL_TTL_MS = 5 * 60 * 1000;

const setPendingEmailSchema = z.object({
  email: z
    .string()
    .min(1)
    .max(500)
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'email must look like an email address',
    }),
});

/** Drop expired entries lazily on every read. Keeps the map small even
 *  if a renderer abandons sign-in mid-flow without explicitly clearing. */
function purgeExpired(now: number): void {
  for (const [id, entry] of pendingEmails) {
    if (entry.expiresAt <= now) pendingEmails.delete(id);
  }
}

export function registerAuthIpc(): void {
  ipcMain.handle(IPC.auth.startLoopback, async (event) => {
    // Reject overlap — same guard `stripe.startCheckout` carries. The
    // loopback server is a single shared resource; starting a second
    // sign-in (or stepping on an in-flight checkout) would silently
    // tear the first down and leave whichever flow lost the race
    // broken. Surface the conflict instead.
    if (isLoopbackActive()) {
      throw new Error(
        'Another sign-in or checkout is already in progress. Finish or cancel it first.',
      );
    }

    // Identify the calling renderer so we push the callback URL only to
    // the window that initiated this sign-in. With a single widget this
    // is overkill, but it future-proofs us against a settings popout or
    // multiple windows down the line.
    const senderId = event.sender.id;
    const { port } = await startLoopbackServer((url) => {
      // The renderer that started the flow may have been closed by the
      // time the callback fires (user clicked the email link 5 minutes
      // later, after closing the widget). Look it up fresh by id.
      const win = BrowserWindow.fromId(senderId);
      if (!win || win.isDestroyed()) {
        console.warn(
          '[optix-auth] callback arrived but originating renderer is gone',
        );
        return;
      }
      win.webContents.send(IPC.auth.loopbackCallback, { url });
    });
    return { port };
  });

  ipcMain.handle(IPC.auth.stopLoopback, async () => {
    stopLoopbackServer();
  });

  ipcMain.handle(IPC.auth.setPendingEmail, async (event, payload: unknown) => {
    const { email } = setPendingEmailSchema.parse(payload);
    const senderId = event.sender.id;
    const now = Date.now();
    purgeExpired(now);
    pendingEmails.set(senderId, {
      email,
      expiresAt: now + PENDING_EMAIL_TTL_MS,
    });
    // Drop the entry when the renderer that set it goes away. Without
    // this, a webContents that crashes mid-flow would leave a stale
    // slot that nobody can consume but also doesn't auto-expire for up
    // to 5 minutes. `destroyed` fires once and is safe to register
    // multiple times across re-sets (same listener function dedupes).
    const wc = event.sender;
    const onDestroyed = (): void => {
      pendingEmails.delete(senderId);
    };
    // `once` so we don't accumulate listeners if the same renderer
    // re-sets repeatedly — Electron drops the prior `once` on its own
    // when re-added with the same target.
    wc.once('destroyed', onDestroyed);
  });

  ipcMain.handle(IPC.auth.consumePendingEmail, async (event) => {
    // One-shot read AND scoped to the originating renderer — a second
    // reader (a racing widget window, a stray re-fire of the loopback
    // callback) targeting a different sender's slot finds nothing.
    // The TTL check rejects abandoned slots so a stale entry can't be
    // picked up minutes later.
    const senderId = event.sender.id;
    const now = Date.now();
    purgeExpired(now);
    const entry = pendingEmails.get(senderId);
    if (!entry) return { email: null };
    pendingEmails.delete(senderId);
    if (entry.expiresAt <= now) return { email: null };
    return { email: entry.email };
  });

  ipcMain.handle(IPC.auth.clearPendingEmail, async (event) => {
    pendingEmails.delete(event.sender.id);
  });
}
