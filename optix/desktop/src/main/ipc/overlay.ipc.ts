import { ipcMain, screen } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { TargetRegionSchema } from '@shared/schemas';
import { showOverlay, hideOverlay } from '@main/windows/overlay-window';

// Validate the renderer payload against the same TargetRegion shape
// the rest of the app uses. Caps `regions` at a generous-but-bounded
// length so a buggy or compromised renderer can't push thousands of
// rectangles through to the overlay paint loop.
const OverlayShowRequestSchema = z.object({
  regions: z.array(TargetRegionSchema).max(64),
  imageWidth: z.number().int().positive().max(10_000),
  imageHeight: z.number().int().positive().max(10_000),
});

export function registerOverlayIpc(): void {
  ipcMain.handle(IPC.overlay.show, async (_event, raw: unknown) => {
    const req = OverlayShowRequestSchema.parse(raw);
    // Display dimensions are resolved here in main rather than the widget so
    // the overlay renderer always gets the authoritative primary-display
    // size — the widget's own DOM viewport doesn't reflect the full screen.
    const { width: displayWidth, height: displayHeight } =
      screen.getPrimaryDisplay().bounds;
    await showOverlay({
      regions: req.regions,
      imageWidth: req.imageWidth,
      imageHeight: req.imageHeight,
      displayWidth,
      displayHeight,
    });
  });

  ipcMain.handle(IPC.overlay.hide, async () => {
    hideOverlay();
  });
}
