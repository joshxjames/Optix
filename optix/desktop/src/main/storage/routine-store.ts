// Routine persistence — one JSON file per recorded routine at
// <userData>/routines/<id>.json. Lazy-listed for the list view, fully
// loaded only when the user opens detail or runs a routine.
//
// Multi-file (rather than one big array) so:
//  • Edits to one routine don't risk overwriting another.
//  • The list view can summarise without parsing entire action arrays
//    when there are dozens of routines.
//  • Future deletion is just unlinking a file.

import { app } from 'electron';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  RoutineSchema,
  type RecordedAction,
  type Routine,
  type RoutineSummary,
} from '@shared/schemas';

function getRoutinesDir(): string {
  return path.join(app.getPath('userData'), 'routines');
}

function fileFor(id: string): string {
  return path.join(getRoutinesDir(), `${id}.json`);
}

/** Atomic write of a routine's JSON. Writes to `<id>.json.tmp` first
 *  then renames into place so a crash mid-write leaves the previous
 *  file intact rather than half-truncating it. */
async function writeRoutineFileAtomic(routine: Routine): Promise<void> {
  const target = fileFor(routine.id);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(routine, null, 2), 'utf8');
  await rename(tmp, target);
}

/** Derive a clean default name from the user's original prompt. The
 *  user can rename later; we just need something readable for the
 *  list view + slash menu. */
function nameFromPrompt(prompt: string, max = 50): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1).trimEnd() + '…';
}

/** Read every routine on disk, returning the parsed bodies. Used by
 *  the list endpoint AND by the OA-number assignment on save (need
 *  to know the current max). Errors per file are silently dropped
 *  so a single corrupt JSON doesn't break the whole listing. */
async function readAllRoutines(): Promise<Routine[]> {
  const dir = getRoutinesDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const out: Routine[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(path.join(dir, f), 'utf8');
      const parsed = RoutineSchema.safeParse(JSON.parse(raw));
      if (parsed.success) out.push(parsed.data);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Compute the next sequential OA number — max existing + 1, or 1
 *  if there are no routines yet. */
function nextOaNumber(existing: Routine[]): number {
  let max = 0;
  for (const r of existing) {
    if (typeof r.oaNumber === 'number' && r.oaNumber > max) max = r.oaNumber;
  }
  return max + 1;
}

/** Lazy-migrate any routines saved before `oaNumber` existed. Sorts
 *  by createdAt so older routines get lower numbers, then writes the
 *  newly-numbered bodies back to disk. Idempotent — routines with an
 *  existing number are left alone. */
async function backfillOaNumbers(routines: Routine[]): Promise<Routine[]> {
  const numbered = routines.filter((r) => typeof r.oaNumber === 'number');
  const unnumbered = routines.filter((r) => typeof r.oaNumber !== 'number');
  if (unnumbered.length === 0) return routines;
  unnumbered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let next = nextOaNumber(numbered);
  for (const r of unnumbered) {
    r.oaNumber = next++;
    try {
      await writeRoutineFileAtomic(r);
    } catch {
      /* best-effort migration */
    }
  }
  return [...numbered, ...unnumbered];
}

/** Persist a freshly-recorded run as a new routine. The recording
 *  pipeline calls this on loop completion when the Record toggle was
 *  active. Fails silently (returns null) on any write error so a
 *  failed save doesn't break the loop's own teardown. */
export async function saveNewRoutine(opts: {
  originalPrompt: string;
  actions: RecordedAction[];
  providerId: string;
  modelId: string;
  /** Optional caller-supplied name; defaults to a trimmed prompt. */
  name?: string;
  /** Number of agent turns the recording spanned (renderer-tracked). */
  turnCount?: number;
  /** Total API cost (USD) for the recording run, summed by the
   *  renderer using `costForTurns`. */
  estimatedCostUsd?: number;
  /** Initial screenshot dimensions at record time. */
  imageWidth?: number;
  imageHeight?: number;
}): Promise<Routine | null> {
  if (opts.actions.length === 0) return null;
  const id = randomUUID();
  const now = new Date().toISOString();
  const existing = await readAllRoutines();
  const routine: Routine = {
    id,
    oaNumber: nextOaNumber(existing),
    name: opts.name ?? nameFromPrompt(opts.originalPrompt),
    originalPrompt: opts.originalPrompt,
    actions: opts.actions,
    createdAt: now,
    updatedAt: now,
    providerId: opts.providerId,
    modelId: opts.modelId,
    turnCount: opts.turnCount,
    estimatedCostUsd: opts.estimatedCostUsd,
    imageWidth: opts.imageWidth,
    imageHeight: opts.imageHeight,
  };
  try {
    await mkdir(getRoutinesDir(), { recursive: true });
    await writeRoutineFileAtomic(routine);
    return routine;
  } catch (err) {
    console.warn(
      '[optix-routines] save failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function listRoutines(): Promise<RoutineSummary[]> {
  const all = await readAllRoutines();
  const migrated = await backfillOaNumbers(all);
  return migrated
    .map(
      (r): RoutineSummary => ({
        id: r.id,
        oaNumber: r.oaNumber,
        name: r.name,
        originalPrompt: r.originalPrompt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        actionCount: r.actions.length,
        turnCount: r.turnCount,
        estimatedCostUsd: r.estimatedCostUsd,
        imageWidth: r.imageWidth,
        imageHeight: r.imageHeight,
        providerId: r.providerId,
        modelId: r.modelId,
      }),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Read a routine by its sequential OA number. Used by the slash-
 *  menu submit flow which carries `/OA-{n}` tokens — the renderer
 *  only knows the number, this helper resolves to the file. */
export async function readRoutineByOaNumber(n: number): Promise<Routine | null> {
  const all = await readAllRoutines();
  return all.find((r) => r.oaNumber === n) ?? null;
}

export async function readRoutine(id: string): Promise<Routine | null> {
  // Validate id shape — `randomUUID` output, no slashes — to prevent
  // a malicious/buggy renderer from reading other files.
  if (!/^[a-f0-9-]+$/i.test(id)) return null;
  try {
    const raw = await readFile(fileFor(id), 'utf8');
    const parsed = RoutineSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Overwrite an existing routine with edited fields. Only `name`,
 *  `originalPrompt`, and `actions` are user-editable; the rest stays
 *  pinned to the original recording. `updatedAt` is bumped. */
export async function updateRoutine(
  id: string,
  patch: { name?: string; originalPrompt?: string; actions?: RecordedAction[] },
): Promise<Routine | null> {
  const existing = await readRoutine(id);
  if (!existing) return null;
  const updated: Routine = {
    ...existing,
    name: patch.name ?? existing.name,
    originalPrompt: patch.originalPrompt ?? existing.originalPrompt,
    actions: patch.actions ?? existing.actions,
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeRoutineFileAtomic(updated);
    return updated;
  } catch (err) {
    console.warn(
      '[optix-routines] update failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function deleteRoutine(id: string): Promise<boolean> {
  if (!/^[a-f0-9-]+$/i.test(id)) return false;
  try {
    await rm(fileFor(id), { force: true });
    return true;
  } catch {
    return false;
  }
}
