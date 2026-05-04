import { ipcMain, screen } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { TargetRegionSchema } from '@shared/schemas';
import { showOverlay, hideOverlay } from '@main/windows/overlay-window';

// Validate the renderer payload against the same TargetRegion shape
// the rest of the app uses. Caps `regions` at a generous-but-bounded
// length so a buggy or compromised renderer can't push thousands of
// rectangles through to the overlay paint loop.
//
// `superRefine` rejects regions that overflow the image bounds — a
// model occasionally returns x+width > imageWidth (or y+height >
// imageHeight) which would render boxes off the edge of the screen
// and confuse the overlay's coord transform. We log and reject the
// whole show request so the caller knows something's wrong rather
// than silently clipping.
const OverlayShowRequestSchema = z
  .object({
    regions: z.array(TargetRegionSchema).max(64),
    imageWidth: z.number().int().positive().max(10_000),
    imageHeight: z.number().int().positive().max(10_000),
  })
  .superRefine((req, ctx) => {
    for (let i = 0; i < req.regions.length; i++) {
      const r = req.regions[i]!;
      if (r.x + r.width > req.imageWidth || r.y + r.height > req.imageHeight) {
        console.warn(
          '[overlay.ipc] rejecting show request: region overflows image bounds',
          {
            index: i,
            label: r.label,
            region: { x: r.x, y: r.y, width: r.width, height: r.height },
            image: { width: req.imageWidth, height: req.imageHeight },
          },
        );
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regions', i],
          message: `Region overflows image bounds: ${r.x}+${r.width} > ${req.imageWidth} or ${r.y}+${r.height} > ${req.imageHeight}`,
        });
      }
    }
  });

export function registerOverlayIpc(): void {
  ipcMain.handle(IPC.overlay.show, async (_event, raw: unknown) => {
    const req = OverlayShowRequestSchema.parse(raw);
    // Display dimensions are resolved here in main rather than the widget so
    // the overlay renderer always gets an authoritative size. `showOverlay`
    // may override these when the regions span multiple displays — these
    // values are the single-display fallback the type contract requires.
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
