import { BrowserWindow, globalShortcut } from 'electron';
import { IPC } from '@shared/ipc';
import { getSettings } from '@main/storage/settings-store';
import { toggleWidget } from '@main/windows/widget-window';

// Track the accelerator we currently hold. Used to support the
// "register new before unregistering old" swap below — `unregisterAll`
// would briefly leave the user with no hotkey if `register` then fails.
let activeAccelerator: string | null = null;

// If the very first registerHotkeys() at startup fails, no renderer is
// listening yet for the broadcast. Stash it so the widget can query
// once it finishes loading. Cleared on a subsequent successful register.
let lastRegistrationFailure: string | null = null;

function broadcastFailure(binding: string): void {
  // Broadcast to every renderer so the widget can surface a banner —
  // a silent registration failure leaves the user wondering why the
  // hotkey doesn't work. Renderer-side listener lives outside this
  // module; we only fire the event.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.widget.hotkeyRegistrationFailed, { binding });
    } catch {
      // best-effort — a destroyed/closing webContents shouldn't block
      // the rest of the broadcast.
    }
  }
}

export function registerHotkeys(): void {
  const { hotkeyToggleWidget } = getSettings();

  // No hotkey configured → release any prior binding and bail.
  if (!hotkeyToggleWidget) {
    if (activeAccelerator) {
      try {
        globalShortcut.unregister(activeAccelerator);
      } catch {
        // ignore — teardown path
      }
      activeAccelerator = null;
    }
    lastRegistrationFailure = null;
    return;
  }

  // No-op if the requested binding is already live.
  if (activeAccelerator === hotkeyToggleWidget) {
    return;
  }

  // Atomic-ish swap: try to claim the new accelerator FIRST. If it
  // fails (another app has it, OS rejects the combo) we keep the old
  // one in place — better a stale hotkey than no hotkey at all.
  let ok = false;
  try {
    ok = globalShortcut.register(hotkeyToggleWidget, () => {
      toggleWidget();
    });
  } catch (err) {
    console.error('[optix] globalShortcut.register threw:', err);
    ok = false;
  }

  if (!ok) {
    console.warn(
      `[optix] Failed to register hotkey ${hotkeyToggleWidget}. It may be in use by another app.`,
    );
    lastRegistrationFailure = hotkeyToggleWidget;
    broadcastFailure(hotkeyToggleWidget);
    // Leave activeAccelerator untouched — the previous binding (if any)
    // is still functional.
    return;
  }

  // New accelerator is live. Release the old one (if any) and update
  // tracking. Do this AFTER success so we never have a window where
  // the user has no hotkey at all.
  if (activeAccelerator && activeAccelerator !== hotkeyToggleWidget) {
    try {
      globalShortcut.unregister(activeAccelerator);
    } catch (err) {
      // The OS-level registration may have already lapsed; swallow.
      console.warn('[optix] unregister of previous hotkey threw:', err);
    }
  }
  activeAccelerator = hotkeyToggleWidget;
  lastRegistrationFailure = null;
}

/** Returns the binding string of the most recent failed registration,
 *  or null if the current binding is live. Consumed by the widget once
 *  its window finishes loading so a startup-time failure (which had no
 *  renderer to receive the broadcast) is still surfaced to the user.
 *  TODO: src/main/windows/widget-window.ts (or src/main/index.ts) should
 *  query this on `did-finish-load` and forward via
 *  `IPC.widget.hotkeyRegistrationFailed` if non-null. */
export function getLastRegistrationFailure(): string | null {
  return lastRegistrationFailure;
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
  activeAccelerator = null;
}
