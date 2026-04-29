import { BrowserWindow, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { IPC } from '@shared/ipc';
import type { OverlayRenderPayload } from '@shared/api';
import { safeOpenExternal } from '@main/security/safe-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.js');

let overlayWindow: BrowserWindow | null = null;

function createOverlayWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    // Window stays "shown" at the OS level so we never trigger Windows'
    // DWM appear/scale animation. Visibility is controlled via setOpacity
    // (instant, no animation). We start at opacity 0 — invisible until
    // showOverlay flips it to 1.
    show: true,
    opacity: 0,
    // Never steal focus — the user is interacting with the app *behind* the
    // overlay. focusable:false prevents OS focus on click/show; combined with
    // setIgnoreMouseEvents this makes the overlay truly passive.
    focusable: false,
    // Always-on-top at 'screen-saver' level so we float above full-screen
    // apps like presentations or media players.
    alwaysOnTop: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Click-through: pointer events fall through the overlay to the window
  // beneath. `forward: true` still delivers mouse-move events to the overlay
  // renderer for hover-driven UI (e.g. label highlighting) without consuming
  // the click.
  win.setIgnoreMouseEvents(true, { forward: true });

  // Hide from screen capture so the overlay's own boxes never feed back into
  // the next analysis frame.
  win.setContentProtection(true);

  // Hard-deny any external navigation or new windows from the renderer.
  // Only http(s) URLs reach the OS; all other schemes are dropped by
  // `safeOpenExternal`.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/overlay/index.html'));
  }

  win.on('closed', () => {
    if (overlayWindow === win) {
      overlayWindow = null;
    }
  });

  return win;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}

export async function showOverlay(payload: OverlayRenderPayload): Promise<void> {
  // Reuse path: window already exists. Push the payload, wait one frame for
  // React to commit so the boxes are positioned correctly BEFORE we make
  // the window visible, then opacity → 1. setOpacity is instant and skips
  // Windows' DWM "window appear" animation that show() triggers.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(IPC.overlay.render, payload);
    await new Promise<void>((resolve) => setTimeout(resolve, 32));
    if (!overlayWindow.isDestroyed()) {
      overlayWindow.setOpacity(1);
      // Re-assert content protection — Electron has a known bug where
      // WDA_EXCLUDEFROMCAPTURE on transparent windows occasionally drops.
      overlayWindow.setContentProtection(true);
    }
    return;
  }

  // Cold path: create the window (already shown at opacity 0), wait for the
  // renderer to load, push the payload, then opacity → 1. Sending render
  // before did-finish-load would race the preload bridge.
  const win = createOverlayWindow();
  overlayWindow = win;

  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.overlay.render, payload);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setOpacity(1);
      win.setContentProtection(true);
    }, 32);
  });
}

export function hideOverlay(): void {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Opacity 0 instead of hide() — same reasoning as show: avoid OS-level
    // window appearance animations on the next show. Then clear renderer
    // state so a future show starts from a clean slate.
    overlayWindow.setOpacity(0);
    overlayWindow.webContents.send(IPC.overlay.render, null);
  }
}
