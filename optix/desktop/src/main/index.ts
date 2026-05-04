import { app, screen, session } from 'electron';
import { createWidgetWindow, toggleWidget } from '@main/windows/widget-window';

// In electron-vite dev mode, main-process stdout/stderr is piped to the
// watcher. If the watcher's read end stalls or closes, the next console.log
// throws EPIPE and Electron's default uncaughtException dialog kills the app.
// These writes are diagnostic only — swallow EPIPE so they can't crash us.
process.stdout.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err;
});
process.stderr.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'EPIPE') throw err;
});
process.on('uncaughtException', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') return;
  // Last-resort handler — specific catches still belong at call sites.
  // Without this, Electron pops a bare crash dialog and exits with no
  // breadcrumb; logging first means a user investigating "why did
  // Optix vanish?" has something to grep for in the console.
  console.error('[optix] uncaught exception:', err);
  process.exit(1);
});
import { getPrimarySource, invalidateSourceIdCache } from '@main/capture/screen';
import { getWorker as getOcrWorker, terminateOcrWorker } from '@main/capture/ocr';
import { registerProviderIpc } from '@main/ipc/provider.ipc';
import { registerSettingsIpc } from '@main/ipc/settings.ipc';
import { registerHistoryIpc } from '@main/ipc/history.ipc';
import { registerWidgetIpc } from '@main/ipc/widget.ipc';
import { registerOverlayIpc } from '@main/ipc/overlay.ipc';
import { registerActionIpc } from '@main/ipc/action.ipc';
import { registerComputerIpc } from '@main/ipc/computer.ipc';
import { registerAuditIpc } from '@main/ipc/audit.ipc';
import { registerChatHistoryIpc } from '@main/ipc/chat-history.ipc';
import { registerPlanIpc } from '@main/ipc/plan.ipc';
import { registerRoutinesIpc } from '@main/ipc/routines.ipc';
import { registerCaptureIpc } from '@main/ipc/capture.ipc';
import { registerAuthIpc } from '@main/ipc/auth.ipc';
import { registerStripeIpc } from '@main/ipc/stripe.ipc';
import { stopLoopbackServer } from '@main/auth/loopback-server';
import { registerHotkeys, unregisterHotkeys } from '@main/hotkeys/register';
import { getSettings, setSettings } from '@main/storage/settings-store';
import { finalizeAllPendingLoops } from '@main/automation/computer-loop';
import { reapAllShellChildren } from '@main/automation/shell-executor';
import { wipeAllCachedKeys } from '@main/security/keychain';

// Single-instance lock: second launch focuses the existing widget instead of
// opening a second app.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Log before exiting — silent quit was a debugging dead-end for
  // users wondering "why won't Optix open?". A console breadcrumb is
  // less intrusive than a dialog but still leaves a trail.
  console.warn('[optix] another instance is already running — exiting');
  app.quit();
}

app.on('second-instance', () => {
  // If already running, just toggle the widget into view.
  toggleWidget();
});

// Drain any paused Computer Use loops to disk before the process exits.
// Conversation-mode keeps loop state alive across user submits; without
// this hook, closing the app mid-conversation would leave the audit
// JSON on disk without `endedAt` / `outcome` / cost — i.e. permanently
// "in-progress" in the run-history view. Synchronous so it completes
// before Electron tears down the process.
//
// Each cleanup is wrapped individually so an early failure (e.g. audit
// write fails on a full disk) doesn't skip later cleanup (loopback
// socket leak, OCR worker stranded, orphaned shell children).
app.on('before-quit', () => {
  try {
    finalizeAllPendingLoops();
  } catch (err) {
    console.error('[optix] loop finalize failed:', err);
  }
  try {
    // Tear down any in-flight magic-link loopback server so we don't
    // leak a listening socket past process exit.
    stopLoopbackServer();
  } catch (err) {
    console.error('[optix] loopback stop failed:', err);
  }
  try {
    terminateOcrWorker();
  } catch (err) {
    console.error('[optix] ocr worker terminate failed:', err);
  }
  try {
    reapAllShellChildren();
  } catch (err) {
    console.error('[optix] shell reaper failed:', err);
  }
  try {
    // Drop the keychain in-memory cache before exit. JS strings are immutable
    // so this can't truly zero them, but dropping references promptly limits
    // exposure to memory dumps captured post-quit.
    wipeAllCachedKeys();
  } catch (err) {
    console.error('[optix] keychain wipe failed:', err);
  }
});

app.whenReady().then(() => {
  // The agent workspace folder is intentionally session-only — it should
  // never persist across launches because it grants in-scope agent access
  // without per-action prompts. Force-clear at startup so every launch
  // begins with no scope set.
  setSettings({ agentWorkspaceFolder: null });

  registerProviderIpc();
  registerSettingsIpc();
  registerHistoryIpc();
  registerWidgetIpc();
  registerOverlayIpc();
  registerActionIpc();
  registerComputerIpc();
  registerAuditIpc();
  registerChatHistoryIpc();
  registerPlanIpc();
  registerRoutinesIpc();
  registerCaptureIpc();
  registerAuthIpc();
  registerStripeIpc();

  // Intercept navigator.mediaDevices.getDisplayMedia calls from any renderer.
  // We auto-select the primary display source — no system picker, no prompt.
  // This routes screen capture through Chromium's modern pipeline (WGC on
  // Windows 10 2004+), which honours WDA_EXCLUDEFROMCAPTURE set via
  // `setContentProtection(true)` on the widget. Net effect: the widget is
  // truly invisible in its own captures, no hide/show flicker needed.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const { privacyPaused } = getSettings();
        if (privacyPaused) {
          // Passing an empty object rejects the getDisplayMedia promise in the
          // renderer, which surfaces as a capture error.
          callback({});
          return;
        }
        const source = await getPrimarySource();
        callback({ video: source });
      } catch (err) {
        console.warn('[optix] display-media handler failed:', err);
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  createWidgetWindow();
  registerHotkeys();

  // Pre-warm the screen-source ID cache. `desktopCapturer.getSources` takes
  // ~2–3s on Windows. Running it at startup means the user's first capture
  // doesn't pay this cost — the cached ID hits immediately when the widget's
  // prewarm opens its MediaStream.
  void getPrimarySource().catch((err) => {
    console.warn('[optix] source-id pre-warm failed:', err);
  });

  // Pre-warm the tesseract.js OCR worker. Cold init is ~2–3s (WASM bring-up
  // + ~10MB language data fetch). Firing it here means the user's first
  // overlay-snapping prompt skips that cost. Errors are swallowed — if the
  // pre-warm fails the cache resets itself (see ocr.ts), so the on-demand
  // path will retry the load when a prompt actually needs OCR.
  void getOcrWorker().catch(() => {});

  // Displays can be reconfigured mid-session (monitor plugged/unplugged).
  // Invalidate the cached source ID so the next capture re-enumerates fresh.
  screen.on('display-added', invalidateSourceIdCache);
  screen.on('display-removed', invalidateSourceIdCache);
  // DPI changes (Win+P, dock/undock) need cache reset too — bounds change
  // but the source ID becomes stale. display-metrics-changed catches
  // resolution / scale-factor / work-area shifts that display-added
  // and display-removed don't.
  screen.on('display-metrics-changed', invalidateSourceIdCache);
});

app.on('will-quit', () => {
  unregisterHotkeys();
});

// Subscribing to this event (with any handler) is enough to prevent Electron's
// default "quit when last window closes" behavior. We want the app to stay
// resident so the global hotkey can bring the widget back.
app.on('window-all-closed', () => {
  // Intentionally no-op.
});

