import { globalShortcut } from 'electron';
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
  }
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
