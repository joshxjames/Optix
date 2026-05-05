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

// Threat: a previous version of this schema accepted `actions:
// RecordedAction[]` on update — meaning a compromised renderer could swap
// the saved action body for arbitrary file ops, shell commands, or
// synthesized OS clicks that would later be replayed *without* fresh
// per-action approval (replay reuses the persisted body verbatim). We
// now only accept structural edits — rename, re-prompt, delete-by-index,
// reorder — and the handler applies them against the saved routine on
// disk. Raw `actions[]` payloads are rejected by `.strict()`.
//
// `deleteIndices`: indices into the saved actions array to remove.
//   Validated against the saved length in the handler.
// `reorder`: a permutation of the saved indices; the new actions array
//   is `reorder.map(i => saved.actions[i])`. Must reference each
//   surviving index exactly once.
//
// TODO(renderer): RoutinesViewer.tsx currently sends the full
//   `actions: r.actions` array on save. Update it to send `deleteIndices`
//   / `reorder` when actions are edited locally; the schema below will
//   reject any payload carrying `actions`.
const UpdateRequestSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    originalPrompt: z.string().optional(),
    deleteIndices: z.array(z.number().int().nonnegative()).optional(),
    reorder: z.array(z.number().int().nonnegative()).optional(),
  })
  .strict();

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
    const { id, name, originalPrompt, deleteIndices, reorder } = req;

    // Apply structural edits against the saved actions — never trust
    // an action body off the wire. Look up the existing routine first
    // so the deletes/reorders operate on the persisted truth.
    const existing = await readRoutine(id);
    if (!existing) return null;

    let nextActions = existing.actions;
    if (deleteIndices && deleteIndices.length > 0) {
      const drop = new Set(deleteIndices);
      // Reject any out-of-range index — a malformed payload that asks
      // to delete index 999 of a 3-action routine is a programming
      // error or a tampering attempt; either way, fail closed.
      for (const i of drop) {
        if (i >= nextActions.length) {
          throw new Error(
            `routines.update: deleteIndices contains out-of-range index ${i}`,
          );
        }
      }
      nextActions = nextActions.filter((_, i) => !drop.has(i));
    }
    if (reorder && reorder.length > 0) {
      // The reorder array must be a permutation of [0, nextActions.length).
      // No duplicates, no missing indices, no out-of-range entries —
      // otherwise an attacker could drop or duplicate steps via reorder.
      if (reorder.length !== nextActions.length) {
        throw new Error(
          'routines.update: reorder length does not match action count',
        );
      }
      const seen = new Set<number>();
      for (const i of reorder) {
        if (i >= nextActions.length || seen.has(i)) {
          throw new Error('routines.update: reorder is not a valid permutation');
        }
        seen.add(i);
      }
      // Bind the source array so the closure picks up the validated
      // length; `noUncheckedIndexedAccess` would otherwise widen the
      // indexed access to `T | undefined` despite the bounds check above.
      const src = nextActions;
      nextActions = reorder.map((i) => {
        const a = src[i];
        if (!a) {
          // Should be impossible after the validation above — guard
          // for the type narrowing rather than runtime correctness.
          throw new Error('routines.update: reorder index resolved to nothing');
        }
        return a;
      });
    }

    const updated = await updateRoutine(id, {
      name,
      originalPrompt,
      // Only pass `actions` to the store when we actually mutated them;
      // otherwise the store's `patch.actions ?? existing.actions` keeps
      // the saved body untouched.
      actions:
        deleteIndices?.length || reorder?.length ? nextActions : undefined,
    });
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
