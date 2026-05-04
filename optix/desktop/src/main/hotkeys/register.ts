import { BrowserWindow, globalShortcut } from 'electron';
import { IPC } from '@shared/ipc';
import { getSettings } from '@main/storage/settings-store';
import { toggleWidget } from '@main/windows/widget-window';

export function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const { hotkeyToggleWidget } = getSettings();
  if (!hotkeyToggleWidget) return;

  const ok = globalShortcut.register(hotkeyToggleWidget, () => {
    toggleWidget();
  });
  if (!ok) {
    console.warn(`[optix] Failed to register hotkey ${hotkeyToggleWidget}. It may be in use by another app.`);
    // Broadcast to every renderer so the widget can surface a banner —
    // a silent registration failure leaves the user wondering why the
    // hotkey doesn't work. Renderer-side listener lives outside this
    // module; we only fire the event.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IPC.widget.hotkeyRegistrationFailed, {
          binding: hotkeyToggleWidget,
        });
      } catch {
        // best-effort — a destroyed/closing webContents shouldn't block
        // the rest of the broadcast.
      }
    }
  }
}

export function unregisterHotkeys(): void {
  // Wrap in try/catch — `will-quit` runs during shutdown and a throw here
  // would crash the teardown sequence and leave OS-level hotkeys orphaned
  // (still claimed by our process slot until the next reboot/explorer
  // restart on Windows).
  try {
    globalShortcut.unregisterAll();
  } catch (err) {
    console.error('[optix] globalShortcut.unregisterAll() threw:', err);
  }
}
