// Auto-update IPC. Only one renderer-callable channel
// (`updater:installNow`); the `downloaded` and `progress` channels are
// main → renderer broadcasts pushed from `main/updater.ts` directly.

import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { quitAndInstallUpdate } from '@main/updater';

export function registerUpdaterIpc(): void {
  ipcMain.handle(IPC.updater.installNow, async () => {
    // Await + propagate — quitAndInstallUpdate returns a Promise that
    // rejects on the `error` event from electron-updater (e.g. "no
    // staged update file") or on a 1.5s timeout. Letting the rejection
    // bubble through to the renderer's `invoke` means the banner can
    // re-enable its button + surface a real error message instead of
    // hanging on "Restarting…" forever.
    //
    // Successful path never reaches the resolution side — the app
    // process exits before the promise can settle.
    await quitAndInstallUpdate();
  });
}
