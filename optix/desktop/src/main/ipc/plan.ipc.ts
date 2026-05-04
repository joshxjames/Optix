import { ipcMain, BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import { clearPlan, readPlan, savePlan } from '@main/storage/plan-store';
import type { StoredPlan } from '@shared/schemas';

// Validate the renderer-supplied save payload so a compromised
// renderer can't smuggle unexpected fields through to the persisted
// plan file or to the changed-broadcast (which fans out to every
// BrowserWindow).
// 1 MB cap on plan content — plans are Markdown bullet lists; anything
// larger is almost certainly a bug or a compromised renderer trying to
// blow up the persisted file. Without this bound, a huge string would
// be written to disk and broadcast to every BrowserWindow on every
// save.
const SavePlanRequestSchema = z.object({
  content: z.string().min(1).max(1_000_000),
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

  // Failure-signal contract — `plan.save` deliberately does NOT catch
  // disk-write errors. The renderer's plan-tool dispatch calls this
  // IPC and forwards the result back to the agent as `ok: true` /
  // `ok: false`. Swallowing the error here would let the agent
  // believe the plan persisted when in fact the file write blew up
  // (disk full, permission denied, antivirus quarantine), and the
  // next turn would see a stale or missing plan with no breadcrumb
  // to explain why. Letting the rejection propagate through IPC
  // means the renderer's `await window.optix.plan.save(...)` rejects,
  // its catch block returns `ok: false`, and the agent learns to
  // retry or ask the user.
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
