import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { list, clear } from '@main/session/history';

export function registerHistoryIpc(): void {
  ipcMain.handle(IPC.history.list, async () => list());
  ipcMain.handle(IPC.history.clear, async () => clear());
}
