import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { safeOpenExternal } from '@main/security/safe-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.js');

const WIDGET_WIDTH = 400;
const WIDGET_HEIGHT = 520;
const EDGE_GAP = 24;

let widgetWindow: BrowserWindow | null = null;

export function createWidgetWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const x = primary.workArea.x + primary.workArea.width - WIDGET_WIDTH - EDGE_GAP;
  const y = primary.workArea.y + primary.workArea.height - WIDGET_HEIGHT - EDGE_GAP;

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
  widgetWindow.setContentProtection(true);

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


  // F12 toggles DevTools so main-process logs (timing, errors) and renderer
  // console are inspectable on demand. Dev-only convenience.
  widgetWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      widgetWindow?.webContents.toggleDevTools();
    }
  });

  widgetWindow.once('ready-to-show', () => {
    widgetWindow?.show();
    // Re-assert content protection after show. Electron has a known bug
    // where WDA_EXCLUDEFROMCAPTURE set before show doesn't stick on
    // transparent windows — re-setting after the HWND is visible forces
    // DWM to honour it.
    widgetWindow?.setContentProtection(true);
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
    const { setForegroundWindow } = await import('@main/automation/foreground');
    await setForegroundWindow(savedForegroundHwnd);
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
  win.setContentProtection(true);
}
