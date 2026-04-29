import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { captureForegroundHwnd } from '@main/automation/foreground';

// Tiny capture-side IPC. The pixel capture itself runs in the renderer
// via getDisplayMedia; main only contributes the foreground-HWND query
// the renderer uses to decide whether the cached screenshot is still
// representative of what the user is looking at.

export function registerCaptureIpc(): void {
  ipcMain.handle(IPC.capture.foregroundHwnd, async () => {
    return await captureForegroundHwnd();
  });
}
