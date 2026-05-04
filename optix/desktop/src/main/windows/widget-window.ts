import { BrowserWindow, screen } from 'electron';
import Store from 'electron-store';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { safeOpenExternal } from '@main/security/safe-url';
import { getLastRegistrationFailure } from '@main/hotkeys/register';
import { IPC } from '@shared/ipc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.js');

const WIDGET_WIDTH = 400;
const WIDGET_HEIGHT = 520;
const EDGE_GAP = 24;

// Separate electron-store from the shared `settings` store: widget bounds
// are pure window-state, not user-config, and keeping them out of the
// Settings schema avoids round-tripping geometry through the renderer's
// settings IPC. Lazy init for the same reason the settings store is —
// `app.getPath('userData')` only resolves after `app.whenReady()`.
type WidgetState = {
  bounds: { x: number; y: number; width: number; height: number } | null;
};
let widgetStateInstance: Store<WidgetState> | null = null;
function widgetStateStore(): Store<WidgetState> {
  if (!widgetStateInstance) {
    widgetStateInstance = new Store<WidgetState>({
      name: 'widget-state',
      defaults: { bounds: null },
      clearInvalidConfig: true,
    });
  }
  return widgetStateInstance;
}

/**
 * Pick a startup position for the widget. Prefers persisted bounds if they
 * still intersect a currently-attached display (handles laptop-undocked /
 * monitor-disconnected) and otherwise falls back to the bottom-right of
 * the primary display.
 */
function pickStartupBounds(): { x: number; y: number; width: number; height: number } {
  const saved = widgetStateStore().get('bounds');
  if (saved) {
    // Treat the saved bounds as "still valid" if any currently-attached
    // display contains the saved center point. A pure intersect test
    // against `display.bounds` would also work but checking the center
    // matches Electron's own getDisplayMatching heuristic.
    const cx = saved.x + saved.width / 2;
    const cy = saved.y + saved.height / 2;
    const onAttached = screen.getAllDisplays().some((d) => {
      const b = d.bounds;
      return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
    });
    if (onAttached) {
      return { ...saved, width: WIDGET_WIDTH, height: WIDGET_HEIGHT };
    }
    // Saved bounds reference a display that's no longer attached —
    // fall through to the primary-display default below.
  }
  const primary = screen.getPrimaryDisplay();
  return {
    x: primary.workArea.x + primary.workArea.width - WIDGET_WIDTH - EDGE_GAP,
    y: primary.workArea.y + primary.workArea.height - WIDGET_HEIGHT - EDGE_GAP,
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
  };
}

let widgetWindow: BrowserWindow | null = null;

export function createWidgetWindow(): BrowserWindow {
  // Restore last-known position when possible. `pickStartupBounds` falls
  // back to the primary display's bottom-right when the persisted bounds
  // reference a display that's no longer attached (laptop-undocked,
  // monitor unplugged) so the widget can never land off-screen.
  const startup = pickStartupBounds();
  const x = startup.x;
  const y = startup.y;

  // Cross-platform note on `alwaysOnTop: true` + `setAlwaysOnTop(.., 'floating')`:
  //   - Windows: DWM honours always-on-top under most full-screen apps,
  //     including borderless-fullscreen games and presentations. Exclusive
  //     full-screen DirectX/Vulkan apps that take ownership of the display
  //     can still occlude us — there's no Win32 escape hatch from that.
  //   - macOS: 'floating' window level sits below the menubar but above
  //     normal windows. Modern macOS (Mission Control, Spaces, full-screen
  //     Spaces) may occlude floating windows when the user enters a per-app
  //     full-screen Space — behaviour varies by OS version. `visibleOnFullScreen`
  //     mitigates this when Spaces is in play but is not a guarantee.
  //   - Linux: WM-dependent; most tiling WMs ignore always-on-top hints
  //     unless explicitly configured.
  widgetWindow = new BrowserWindow({
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    x,
    y,
    frame: false,
    resizable: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  widgetWindow.setAlwaysOnTop(true, 'floating');
  widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Hide the widget from screen capture — including our own `desktopCapturer`
  // call. Uses DWM affinity on Windows (SetWindowDisplayAffinity /
  // WDA_EXCLUDEFROMCAPTURE) and NSWindowSharingNone on macOS. Otherwise the
  // model ends up analysing a screenshot that contains our own UI overlaying
  // whatever the user was asking about.
  // Windows-only API; no-op on macOS/Linux but worth the explicit guard so
  // future Electron versions can't surprise us with new behaviour.
  if (process.platform === 'win32') {
    widgetWindow.setContentProtection(true);
  }

  // Hard-deny any external navigation or new windows from the renderer.
  // Pass the URL through `safeOpenExternal` so only http(s) URLs are
  // ever launched — `javascript:`, `file://`, custom schemes are
  // silently dropped.
  widgetWindow.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url);
    return { action: 'deny' };
  });
  widgetWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void widgetWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/widget/index.html`);
  } else {
    void widgetWindow.loadFile(path.join(__dirname, '../renderer/widget/index.html'));
  }

  // Replay any startup-time hotkey registration failure once the renderer
  // is alive. registerHotkeys() runs before any window exists (so its
  // broadcast hits zero listeners), and a silent failure leaves the user
  // wondering why the hotkey doesn't work. The register module stashes
  // the offending binding; we replay it as soon as the widget can show
  // the banner.
  widgetWindow.webContents.once('did-finish-load', () => {
    const failedBinding = getLastRegistrationFailure();
    if (failedBinding && widgetWindow && !widgetWindow.isDestroyed()) {
      try {
        widgetWindow.webContents.send(IPC.widget.hotkeyRegistrationFailed, {
          binding: failedBinding,
        });
      } catch {
        // best-effort — destroyed/closing webContents shouldn't crash startup.
      }
    }
  });


  // F12 toggles DevTools so main-process logs (timing, errors) and renderer
  // console are inspectable on demand. Dev-only convenience.
  // Gate on ELECTRON_RENDERER_URL — that env var is only set by the dev
  // harness (see loadURL above), so packaged builds can't accidentally
  // expose DevTools to end users via an F12 keystroke.
  if (process.env.ELECTRON_RENDERER_URL) {
    widgetWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        widgetWindow?.webContents.toggleDevTools();
      }
    });
  }

  // Track which display the widget currently sits on so we can detect
  // cross-monitor drags and re-anchor when DPI / work-area changes. The
  // widget is non-resizable (logical px), so Electron handles the visual
  // DPI rescale automatically on the new display — but the docked
  // bottom-right anchor needs recomputing against the new work area or
  // the widget can end up half-off the secondary screen.
  let currentDisplayId = screen.getDisplayMatching(widgetWindow.getBounds()).id;
  widgetWindow.on('moved', () => {
    if (!widgetWindow || widgetWindow.isDestroyed()) return;
    // Skip while a compact-toggle animation is in flight — those
    // setBounds calls fire `moved` events and we don't want to fight
    // the animation.
    if (compactAnimTimer !== null) return;
    const bounds = widgetWindow.getBounds();
    // Persist on every move (cheap — electron-store batches writes) so the
    // next launch can restore where the user left it. Skip persisting
    // compact-mode bounds; we want to come back to the full-size widget.
    if (savedFullHeight === null) {
      widgetStateStore().set('bounds', bounds);
    }
    const display = screen.getDisplayMatching(bounds);
    if (display.id === currentDisplayId) return;
    currentDisplayId = display.id;
    // Re-clamp into the new display's work area. If the user dragged the
    // widget onto a smaller secondary monitor where part of it would
    // overflow the right/bottom edges, snap it back inside. Don't move
    // it if it already fits — the user just placed it where they wanted.
    const wa = display.workArea;
    const fitsX = bounds.x >= wa.x && bounds.x + bounds.width <= wa.x + wa.width;
    const fitsY = bounds.y >= wa.y && bounds.y + bounds.height <= wa.y + wa.height;
    if (fitsX && fitsY) return;
    const nextX = Math.max(
      wa.x + EDGE_GAP,
      Math.min(wa.x + wa.width - bounds.width - EDGE_GAP, bounds.x),
    );
    const nextY = Math.max(
      wa.y + EDGE_GAP,
      Math.min(wa.y + wa.height - bounds.height - EDGE_GAP, bounds.y),
    );
    widgetWindow.setBounds({
      x: nextX,
      y: nextY,
      width: bounds.width,
      height: bounds.height,
    });
  });

  widgetWindow.once('ready-to-show', () => {
    widgetWindow?.show();
    // Re-assert content protection after show. Electron has a known bug
    // where WDA_EXCLUDEFROMCAPTURE set before show doesn't stick on
    // transparent windows — re-setting after the HWND is visible forces
    // DWM to honour it. Some Windows DWM transitions can drop the
    // affinity flag across show/hide, so re-applying is essential.
    // Windows-only API; no-op on macOS/Linux but worth the explicit guard
    // so future Electron versions can't surprise us with new behaviour.
    if (process.platform === 'win32') {
      widgetWindow?.setContentProtection(true);
    }
  });
  widgetWindow.on('close', () => {
    // Last-chance persistence: if the user closes mid-drag we want the
    // most-recent bounds saved. Skip when in compact mode for the same
    // reason as the `moved` handler — restore should come back to the
    // expanded size.
    if (widgetWindow && !widgetWindow.isDestroyed() && savedFullHeight === null) {
      try {
        widgetStateStore().set('bounds', widgetWindow.getBounds());
      } catch {
        // Best-effort — store write failures shouldn't block shutdown.
      }
    }
  });
  widgetWindow.on('closed', () => {
    widgetWindow = null;
  });

  return widgetWindow;
}

export function getWidgetWindow(): BrowserWindow | null {
  return widgetWindow;
}

/**
 * Temporarily disable keyboard focus on the widget. Used during the Computer
 * Use loop so robotjs `typeString` / `keyTap` calls go to the foreground
 * application (Notepad, Run, etc.) instead of the widget itself, which would
 * otherwise steal focus on every React re-render.
 *
 * Call with `false` at loop start, `true` on completion / abort / error.
 */
export function setWidgetFocusable(focusable: boolean): void {
  if (!widgetWindow) return;
  widgetWindow.setFocusable(focusable);
  if (!focusable) {
    // Push focus away NOW so the next robotjs action lands on the foreground
    // app. blur() on Windows transfers activation to the next-most-recently
    // active window, which is where the user's task lives.
    widgetWindow.blur();
  }
}

// HWND of the user's target app, captured at the moment we begin a text
// input session. We restore foreground to this HWND when the session ends
// so the next robotjs action lands in the right place.
let savedForegroundHwnd: string | null = null;

/**
 * Begin a text-input session: capture the current foreground window so we
 * can restore it later, then make the widget focusable + focus it so the
 * user can type into our textarea.
 *
 * Use case: per-action approval mode's "Type something" feedback box. The
 * widget is non-focusable for the rest of the loop so robotjs lands keys on
 * the user's target app — but for the moment they want to type a correction,
 * we briefly switch focus and then put it right back.
 */
export async function beginWidgetTextInput(): Promise<void> {
  if (!widgetWindow) return;
  // Lazy-load to keep the long-lived PowerShell child off the boot path.
  const { captureForegroundHwnd } = await import('@main/automation/foreground');
  savedForegroundHwnd = await captureForegroundHwnd();
  widgetWindow.setFocusable(true);
  widgetWindow.focus();
}

// Compact-mode bookkeeping. When the user clicks the minimize button we
// shrink the widget down to just the header strip AND snap it to the
// bottom-right corner of whichever display it currently sits on, so the
// minimised widget always docks to a predictable spot regardless of
// where the expanded version was dragged. Expanding from compact then
// keeps the bottom edge anchored, which leaves the expanded widget at
// the bottom-right too.
let savedFullHeight: number | null = null;
const COMPACT_HEIGHT = 50;
const COMPACT_ANIM_MS = 180;
const COMPACT_ANIM_FRAME_MS = 16; // ~60 fps

// Outstanding compact-toggle animation. A new toggle pre-empts the
// previous one so rapid clicks don't queue up overlapping animations.
let compactAnimTimer: ReturnType<typeof setTimeout> | null = null;

/** Step the widget's bounds from current → target with ease-out cubic.
 *  Electron's `setBounds(..., animate=true)` is macOS-only, so on
 *  Windows we drive the animation manually one frame at a time. */
function animateWidgetBounds(
  win: BrowserWindow,
  target: { x: number; y: number; width: number; height: number },
): void {
  if (compactAnimTimer) {
    clearTimeout(compactAnimTimer);
    compactAnimTimer = null;
  }
  const start = win.getBounds();
  const startTime = Date.now();
  // Ease-out cubic — slows as it approaches the target, which reads
  // more "settled into place" than a linear ramp.
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);

  const tick = (): void => {
    if (!widgetWindow || widgetWindow.isDestroyed()) {
      compactAnimTimer = null;
      return;
    }
    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / COMPACT_ANIM_MS);
    const e = ease(t);
    widgetWindow.setBounds({
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e),
    });
    if (t < 1) {
      compactAnimTimer = setTimeout(tick, COMPACT_ANIM_FRAME_MS);
    } else {
      compactAnimTimer = null;
    }
  };
  tick();
}

export function setWidgetCompact(compact: boolean): void {
  if (!widgetWindow) return;
  const bounds = widgetWindow.getBounds();
  if (compact) {
    if (savedFullHeight !== null) return; // already compact
    savedFullHeight = bounds.height;
    // Snap to the bottom-right of the display the widget currently
    // sits on (multi-monitor friendly — minimising on a secondary
    // display keeps it on that display's bottom-right rather than
    // teleporting to the primary).
    const display = screen.getDisplayMatching(bounds);
    animateWidgetBounds(widgetWindow, {
      x: display.workArea.x + display.workArea.width - WIDGET_WIDTH - EDGE_GAP,
      y: display.workArea.y + display.workArea.height - COMPACT_HEIGHT - EDGE_GAP,
      width: WIDGET_WIDTH,
      height: COMPACT_HEIGHT,
    });
  } else {
    if (savedFullHeight === null) return;
    const target = savedFullHeight;
    savedFullHeight = null;
    animateWidgetBounds(widgetWindow, {
      x: bounds.x,
      y: bounds.y - (target - bounds.height),
      width: bounds.width,
      height: target,
    });
  }
}

/**
 * End a text-input session: revert focusability and force the previously-
 * captured HWND back to the foreground via the AttachThreadInput trick so
 * Windows' SetForegroundWindow restrictions don't strand us.
 */
export async function endWidgetTextInput(): Promise<void> {
  if (!widgetWindow) return;
  widgetWindow.setFocusable(false);
  widgetWindow.blur();
  if (savedForegroundHwnd) {
    const { captureForegroundHwnd, setForegroundWindow } = await import(
      '@main/automation/foreground'
    );
    // Race guard: between beginWidgetTextInput and endWidgetTextInput the
    // user may have manually switched apps (Alt+Tab, clicked a different
    // window). If the current foreground is no longer the HWND we saved,
    // silently skip the restore — yanking them back to a stale window
    // would be more disruptive than just leaving focus where they put it.
    const currentFg = await captureForegroundHwnd();
    if (currentFg && currentFg === savedForegroundHwnd) {
      await setForegroundWindow(savedForegroundHwnd);
    }
    savedForegroundHwnd = null;
  }
}

export function toggleWidget(): void {
  const win = widgetWindow ?? createWidgetWindow();
  if (win.isVisible()) {
    win.hide();
    return;
  }
  // On Windows, calling `focus()` immediately after `show()` on a
  // transparent always-on-top window makes DWM re-evaluate Z-order — the
  // window briefly disappears and re-appears (the flicker). show() already
  // gives keyboard focus on the first paint; re-asserting alwaysOnTop and
  // skipping the redundant focus() avoids the flicker. Re-assert content
  // protection too — Electron sometimes drops the WDA_EXCLUDEFROMCAPTURE
  // flag across show/hide cycles on transparent windows.
  win.show();
  win.setAlwaysOnTop(true, 'floating');
  // Windows-only API; no-op on macOS/Linux but worth the explicit guard so
  // future Electron versions can't surprise us with new behaviour. Re-apply
  // after show — some Windows DWM transitions drop the affinity flag.
  if (process.platform === 'win32') {
    win.setContentProtection(true);
  }
}
