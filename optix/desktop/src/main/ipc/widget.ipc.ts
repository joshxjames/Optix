import { dialog, ipcMain } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
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
    // Structured per-file rejection — never includes raw paths or syscall
    // text. The renderer renders a friendly message off the `reason` code;
    // raw errors are only logged main-side for diagnosis.
    const errors: Array<{
      filename: string;
      reason: 'read_failed' | 'too_large' | 'unsupported_type';
    }> = [];
    for (const fp of result.filePaths) {
      const filename = path.basename(fp);
      const mimeType = mimeFromExt(fp);
      if (!mimeType || !ALLOWED_MIME.has(mimeType)) {
        errors.push({ filename, reason: 'unsupported_type' });
        continue;
      }
      try {
        const buf = await readFile(fp);
        if (buf.byteLength > MAX_PER_FILE_BYTES) {
          errors.push({ filename, reason: 'too_large' });
          continue;
        }
        if (total + buf.byteLength > MAX_TOTAL_BYTES) {
          errors.push({ filename, reason: 'too_large' });
          continue;
        }
        total += buf.byteLength;
        out.push({ filename, mimeType, bytes: new Uint8Array(buf) });
      } catch (err) {
        // OS paths and syscall details (EACCES, EPERM, etc.) leak the
        // user's filesystem layout — log internally, return a generic
        // shape to the renderer.
        console.warn(
          `[optix-widget] pickImages read failed for "${fp}": ${err instanceof Error ? err.message : String(err)}`,
        );
        errors.push({ filename, reason: 'read_failed' });
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
          // Round 9.2: conditional spread for exactOptionalPropertyTypes
          ...(current !== undefined ? { defaultPath: current } : {}),
        })
      : await dialog.showOpenDialog({
          title: 'Choose workspace folder',
          properties: ['openDirectory', 'createDirectory'],
          // Round 9.2: conditional spread for exactOptionalPropertyTypes
          ...(current !== undefined ? { defaultPath: current } : {}),
        });
    if (result.canceled || result.filePaths.length === 0) return null;
    // Realpath the picked folder so a symlink can't quietly route the
    // workspace scope to somewhere outside the user's intent. This is
    // a soft check: we don't reject (the user may have a legitimately
    // symlinked workspace, e.g. ~/code → /mnt/data/code) — just warn
    // to the main-process log when the resolved path leaves the home
    // dir or lands in a system location.
    const picked = result.filePaths[0];
    if (!picked) return null;
    let canonical = picked;
    try {
      canonical = await realpath(picked);
    } catch {
      // Unresolvable — return as-is and let downstream handle.
    }
    const home = homedir();
    const lower = canonical.toLowerCase();
    const outsideHome = !canonical.startsWith(home);
    const systemRoots = ['c:\\windows', 'c:\\program files', '/etc', '/usr', '/var', '/system'];
    const inSystem = systemRoots.some((r) => lower.startsWith(r));
    if (outsideHome || inSystem) {
      console.warn(
        `[optix-widget] workspace folder "${picked}" resolves to "${canonical}" — outside home dir or system path`,
      );
    }
    // Return the chosen path; the renderer persists + broadcasts via
    // `settings.set` so the change-listener fires and the UI updates.
    return canonical;
  });
}
