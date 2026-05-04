import { BrowserWindow, screen } from 'electron';
import type { Display, Rectangle } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { IPC } from '@shared/ipc';
import type { OverlayRenderPayload } from '@shared/api';
import type { TargetRegion } from '@shared/schemas';
import { safeOpenExternal } from '@main/security/safe-url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.js');

let overlayWindow: BrowserWindow | null = null;

/** A region rectangle expressed in absolute screen coordinates — the
 *  bounds of where the overlay-renderer will eventually paint it.
 *  Used internally to figure out which displays a payload spans. */
type ScreenRect = { x: number; y: number; width: number; height: number };

/** Convert a region (in screenshot pixels) to its on-screen rectangle on
 *  the primary display's logical coordinate space. This is a *rough*
 *  pre-check used only to pick which displays the overlay should span;
 *  the actual transform happens in the renderer with the full
 *  `displayX/Y/scaleFactor` context. */
function regionToScreenRect(
  region: TargetRegion,
  imageWidth: number,
  imageHeight: number,
  display: Display,
): ScreenRect {
  const sx = display.bounds.width / imageWidth;
  const sy = display.bounds.height / imageHeight;
  return {
    x: display.bounds.x + region.x * sx,
    y: display.bounds.y + region.y * sy,
    width: region.width * sx,
    height: region.height * sy,
  };
}

function rectsIntersect(a: ScreenRect, b: Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Compute the union bounds of every display that has at least one
 *  region inside it. If only the primary display is involved this
 *  returns the primary's bounds unchanged (preserving legacy
 *  behaviour). Also picks the "dominant" display — the one containing
 *  the most regions — for scaleFactor purposes. */
function computeOverlayPlacement(
  regions: TargetRegion[],
  imageWidth: number,
  imageHeight: number,
): { bounds: Rectangle; dominant: Display } {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  // Score each display by how many regions land inside it. We assume the
  // screenshot was taken from the primary display for the purposes of
  // mapping image-space → screen-space; this matches the current capture
  // path which always grabs the primary display.
  const counts = new Map<number, number>();
  for (const region of regions) {
    const rect = regionToScreenRect(region, imageWidth, imageHeight, primary);
    for (const d of displays) {
      if (rectsIntersect(rect, d.bounds)) {
        counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
      }
    }
  }

  const involved = displays.filter((d) => (counts.get(d.id) ?? 0) > 0);
  // If we couldn't place any region (empty regions array, or all fall
  // outside every display's bounds), fall back to the primary so the
  // overlay still renders something sensible.
  if (involved.length === 0) {
    return { bounds: primary.bounds, dominant: primary };
  }

  // Single-display fast path — keep behaviour identical to pre-multi-
  // display code.
  if (involved.length === 1) {
    const only = involved[0]!;
    return { bounds: only.bounds, dominant: only };
  }

  // Multi-display: union the bounds of every involved display.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let dominant = involved[0]!;
  let dominantCount = -1;
  for (const d of involved) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
    const c = counts.get(d.id) ?? 0;
    if (c > dominantCount) {
      dominantCount = c;
      dominant = d;
    }
  }

  return {
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    dominant,
  };
}

function createOverlayWindow(bounds: Rectangle): BrowserWindow {
  const { x, y, width, height } = bounds;

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
  // Windows-only API; no-op on macOS/Linux but worth the explicit guard so
  // future Electron versions can't surprise us with new behaviour.
  if (process.platform === 'win32') {
    win.setContentProtection(true);
  }

  // Hard-deny any external navigation or new windows from the renderer.
  // Only http(s) URLs reach the OS; all other schemes are dropped by
  // `safeOpenExternal`.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // Without this, an HMR-reloaded overlay can come up showing stale
  // regions because React rehydrates with no payload. Push an explicit
  // null clear on every load so the renderer always boots from a clean
  // slate.
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.overlay.render, null);
  });

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
  // Recompute placement on every show — the user may have moved windows
  // between displays, plugged a monitor, etc. since the last call.
  const { bounds, dominant } = computeOverlayPlacement(
    payload.regions,
    payload.imageWidth,
    payload.imageHeight,
  );

  // Surface the chosen frame + DPI in the payload so the renderer-side
  // transform knows what canvas it's drawing into. displayWidth/Height
  // override the values the IPC layer set from the primary display
  // alone — when we span multiple monitors those would be wrong.
  const enriched: OverlayRenderPayload = {
    ...payload,
    displayWidth: bounds.width,
    displayHeight: bounds.height,
    displayX: bounds.x,
    displayY: bounds.y,
    scaleFactor: dominant.scaleFactor,
  };

  // Reuse path: window already exists. Push the payload, wait one frame for
  // React to commit so the boxes are positioned correctly BEFORE we make
  // the window visible, then opacity → 1. setOpacity is instant and skips
  // Windows' DWM "window appear" animation that show() triggers.
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // Reposition/resize if the placement has changed since last show
    // (display added, regions moved to a different monitor, etc.).
    const current = overlayWindow.getBounds();
    if (
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height
    ) {
      overlayWindow.setBounds(bounds);
    }
    overlayWindow.webContents.send(IPC.overlay.render, enriched);
    await new Promise<void>((resolve) => setTimeout(resolve, 32));
    if (!overlayWindow.isDestroyed()) {
      overlayWindow.setOpacity(1);
      // Re-assert content protection — Electron has a known bug where
      // WDA_EXCLUDEFROMCAPTURE on transparent windows occasionally drops.
      // Windows-only API; no-op on macOS/Linux but worth the explicit guard
      // so future Electron versions can't surprise us with new behaviour.
      if (process.platform === 'win32') {
        overlayWindow.setContentProtection(true);
      }
    }
    return;
  }

  // Cold path: create the window (already shown at opacity 0), wait for the
  // renderer to load, push the payload, then opacity → 1. Sending render
  // before did-finish-load would race the preload bridge.
  const win = createOverlayWindow(bounds);
  overlayWindow = win;

  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send(IPC.overlay.render, enriched);
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setOpacity(1);
      // Windows-only API; no-op on macOS/Linux but worth the explicit guard
      // so future Electron versions can't surprise us with new behaviour.
      if (process.platform === 'win32') {
        win.setContentProtection(true);
      }
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
