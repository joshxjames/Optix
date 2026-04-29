import { ipcMain, BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC } from '@shared/ipc';
import {
  RecordedActionSchema,
} from '@shared/schemas';
import {
  deleteRoutine,
  listRoutines,
  readRoutine,
  readRoutineByOaNumber,
  saveNewRoutine,
  updateRoutine,
} from '@main/storage/routine-store';

const SaveRequestSchema = z.object({
  originalPrompt: z.string().min(1),
  actions: z.array(RecordedActionSchema).min(1),
  providerId: z.string(),
  modelId: z.string(),
  name: z.string().optional(),
  turnCount: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
});

const UpdateRequestSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  originalPrompt: z.string().optional(),
  actions: z.array(RecordedActionSchema).optional(),
});

/** Broadcast routine changes so list views in any window refresh. */
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(IPC.routines.changed);
  }
}

export function registerRoutinesIpc(): void {
  ipcMain.handle(IPC.routines.list, async () => listRoutines());

  ipcMain.handle(IPC.routines.read, async (_evt, raw: unknown) => {
    const { id } = z.object({ id: z.string() }).parse(raw);
    return readRoutine(id);
  });

  ipcMain.handle(IPC.routines.readByOaNumber, async (_evt, raw: unknown) => {
    const { n } = z.object({ n: z.number().int().positive() }).parse(raw);
    return readRoutineByOaNumber(n);
  });

  ipcMain.handle(IPC.routines.save, async (_evt, raw: unknown) => {
    const req = SaveRequestSchema.parse(raw);
    const saved = await saveNewRoutine(req);
    if (saved) broadcastChanged();
    return saved;
  });

  ipcMain.handle(IPC.routines.update, async (_evt, raw: unknown) => {
    const req = UpdateRequestSchema.parse(raw);
    const { id, ...patch } = req;
    const updated = await updateRoutine(id, patch);
    if (updated) broadcastChanged();
    return updated;
  });

  ipcMain.handle(IPC.routines.delete, async (_evt, raw: unknown) => {
    const { id } = z.object({ id: z.string() }).parse(raw);
    const ok = await deleteRoutine(id);
    if (ok) broadcastChanged();
    return ok;
  });
}
