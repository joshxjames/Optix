import { dialog, ipcMain } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  beginWidgetTextInput,
  endWidgetTextInput,
  getWidgetWindow,
  setWidgetCompact,
  setWidgetFocusable,
} from '@main/windows/widget-window';
import { getSettings } from '@main/storage/settings-store';

const MAX_PER_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function mimeFromExt(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return null;
  }
}

const SetFocusableRequest = z.object({ focusable: z.boolean() });
const SetCompactRequest = z.object({ compact: z.boolean() });

export function registerWidgetIpc(): void {
  ipcMain.handle(IPC.widget.hide, async () => {
    getWidgetWindow()?.hide();
  });

  ipcMain.handle(IPC.widget.setFocusable, async (_event, raw: unknown) => {
    const { focusable } = SetFocusableRequest.parse(raw);
    setWidgetFocusable(focusable);
    if (focusable) {
      // Bring focus to the widget so the textarea autoFocus actually lands.
      getWidgetWindow()?.focus();
    }
  });

  ipcMain.handle(IPC.widget.beginTextInput, async () => {
    await beginWidgetTextInput();
  });
  ipcMain.handle(IPC.widget.endTextInput, async () => {
    await endWidgetTextInput();
  });

  ipcMain.handle(IPC.widget.setCompact, async (_event, raw: unknown) => {
    const { compact } = SetCompactRequest.parse(raw);
    setWidgetCompact(compact);
  });

  ipcMain.handle(IPC.widget.pickImages, async () => {
    const widget = getWidgetWindow();
    const result = widget
      ? await dialog.showOpenDialog(widget, {
          title: 'Attach images',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        })
      : await dialog.showOpenDialog({
          title: 'Attach images',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
        });
    if (result.canceled || result.filePaths.length === 0) return [];

    const out: Array<{ filename: string; mimeType: string; bytes: Uint8Array }> = [];
    let total = 0;
    const errors: string[] = [];
    for (const fp of result.filePaths) {
      const filename = path.basename(fp);
      const mimeType = mimeFromExt(fp);
      if (!mimeType || !ALLOWED_MIME.has(mimeType)) {
        errors.push(`${filename}: unsupported format`);
        continue;
      }
      try {
        const buf = await readFile(fp);
        if (buf.byteLength > MAX_PER_FILE_BYTES) {
          errors.push(`${filename}: exceeds 10 MB`);
          continue;
        }
        if (total + buf.byteLength > MAX_TOTAL_BYTES) {
          errors.push(`${filename}: total attachments would exceed 20 MB`);
          continue;
        }
        total += buf.byteLength;
        out.push({ filename, mimeType, bytes: new Uint8Array(buf) });
      } catch (err) {
        errors.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { images: out, errors };
  });

  ipcMain.handle(IPC.widget.chooseWorkspaceFolder, async () => {
    const widget = getWidgetWindow();
    const current = getSettings().agentWorkspaceFolder ?? undefined;
    const result = widget
      ? await dialog.showOpenDialog(widget, {
          title: 'Choose workspace folder',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: current,
        })
      : await dialog.showOpenDialog({
          title: 'Choose workspace folder',
          properties: ['openDirectory', 'createDirectory'],
          defaultPath: current,
        });
    if (result.canceled || result.filePaths.length === 0) return null;
    // Return the chosen path; the renderer persists + broadcasts via
    // `settings.set` so the change-listener fires and the UI updates.
    return result.filePaths[0];
  });
}
