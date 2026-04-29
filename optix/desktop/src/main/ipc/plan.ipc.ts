import { ipcMain, BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { clearPlan, readPlan, savePlan } from '@main/storage/plan-store';
import type { StoredPlan } from '@shared/schemas';

// Validate the renderer-supplied save payload so a compromised
// renderer can't smuggle unexpected fields through to the persisted
// plan file or to the changed-broadcast (which fans out to every
// BrowserWindow).
const SavePlanRequestSchema = z.object({
  content: z.string().min(1),
  rationale: z.string().optional(),
  loopId: z.string().optional(),
});

/** Broadcast to every BrowserWindow so each renderer (widget +
 *  overlay) can refresh its plan state. The widget cares because the
 *  Plan button + plan view both read this; the overlay doesn't, but
 *  blanket-broadcasting is simpler than tracking targets. */
function broadcastPlanChanged(plan: StoredPlan | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.plan.changed, plan);
  }
}

export function registerPlanIpc(): void {
  ipcMain.handle(IPC.plan.read, async () => readPlan());

  ipcMain.handle(IPC.plan.save, async (_evt, raw: unknown) => {
    const arg = SavePlanRequestSchema.parse(raw);
    const plan = await savePlan(arg);
    broadcastPlanChanged(plan);
    return plan;
  });

  ipcMain.handle(IPC.plan.clear, async () => {
    await clearPlan();
    broadcastPlanChanged(null);
  });
}
