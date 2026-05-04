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
  startLoopbackServer,
  stopLoopbackServer,
} from '@main/auth/loopback-server';

// Pending sign-in email — stashed only in main-process memory between the
// user clicking 'Send link' and the loopback callback firing. Renderer
// can SET it (initiating sign-in) and CLEAR it (cancelling) via IPC, but
// cannot READ it directly — only `consumePendingEmail` returns it, and
// that handler clears state in the same call so it's one-shot. The
// one-shot semantics defend against another widget window racing to
// read the email and complete the sign-in for a different account.
// Pre-fix this lived in renderer `localStorage`, where any malicious JS
// running in the renderer (compromised npm dep, future XSS) could
// overwrite it mid-flow.
let pendingSignInEmail: string | null = null;

const setPendingEmailSchema = z.object({
  email: z
    .string()
    .min(1)
    .max(500)
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), {
      message: 'email must look like an email address',
    }),
});

export function registerAuthIpc(): void {
  ipcMain.handle(IPC.auth.startLoopback, async (event) => {
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

  ipcMain.handle(IPC.auth.setPendingEmail, async (_event, payload: unknown) => {
    const { email } = setPendingEmailSchema.parse(payload);
    pendingSignInEmail = email;
  });

  ipcMain.handle(IPC.auth.consumePendingEmail, async () => {
    // One-shot read — clear in the same call so a second reader (a
    // racing widget window, a stray re-fire of the loopback callback)
    // can't pick up the email and complete sign-in as the wrong user.
    const email = pendingSignInEmail;
    pendingSignInEmail = null;
    return { email };
  });

  ipcMain.handle(IPC.auth.clearPendingEmail, async () => {
    pendingSignInEmail = null;
  });
}
