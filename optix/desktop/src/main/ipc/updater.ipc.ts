// Auto-update IPC. Only one renderer-callable channel
// (`updater:installNow`); the `downloaded` and `progress` channels are
// main → renderer broadcasts pushed from `main/updater.ts` directly.

import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { quitAndInstallUpdate } from '@main/updater';

export function registerUpdaterIpc(): void {
  ipcMain.handle(IPC.updater.installNow, async () => {
    // Fire-and-forget — `quitAndInstall` tears down the app within a
    // few hundred ms, so the renderer's awaited promise will never
    // resolve in practice. That's fine; we resolve the handler
    // synchronously to keep TypeScript happy on the bridge side.
    quitAndInstallUpdate();
  });
}
