import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { ProposedActionSchema } from '@shared/schemas';
import { executeAction } from '@main/automation/executor';

// Renderer-supplied payload — validated server-side because the renderer is
// untrusted from main's perspective. ProposedActionSchema is reused from
// the model-response schema so the renderer can pass through actions the
// model proposed without re-shaping.
const ExecuteRequestSchema = z.object({
  action: ProposedActionSchema,
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
});

export function registerActionIpc(): void {
  ipcMain.handle(IPC.action.execute, async (_event, raw: unknown) => {
    const req = ExecuteRequestSchema.parse(raw);
    return executeAction(req.action, {
      imageWidth: req.imageWidth,
      imageHeight: req.imageHeight,
    });
  });
}
