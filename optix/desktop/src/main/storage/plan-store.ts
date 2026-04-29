// Single global plan persistence. The agent's plan tool writes to one
// JSON file at <userData>/plans/current.json — a new approved
// set_plan call overwrites it in place. The renderer reads this on
// startup so the plan button can light up if a stored plan survives
// from a previous session, and the runLoop reads it before each turn
// so the saved plan stays in conversation context.

import { app } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { StoredPlanSchema, type StoredPlan } from '@shared/schemas';

function getPlanFilePath(): string {
  return path.join(app.getPath('userData'), 'plans', 'current.json');
}

/** Read the saved plan, or null if nothing has been saved yet (or the
 *  on-disk JSON is corrupt — we treat unreadable as "no plan" rather
 *  than throwing into the renderer). */
export async function readPlan(): Promise<StoredPlan | null> {
  try {
    const raw = await readFile(getPlanFilePath(), 'utf8');
    const parsed = StoredPlanSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Overwrite the plan file with the agent's new content. `createdAt`
 *  is preserved across updates so the user can see how long they've
 *  been working from this plan; `updatedAt` is bumped each save. */
export async function savePlan(opts: {
  content: string;
  rationale?: string;
  loopId?: string;
}): Promise<StoredPlan> {
  const file = getPlanFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  const existing = await readPlan();
  const now = new Date().toISOString();
  const plan: StoredPlan = {
    content: opts.content,
    rationale: opts.rationale,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    loopId: opts.loopId,
  };
  await writeFile(file, JSON.stringify(plan, null, 2), 'utf8');
  return plan;
}

/** Synchronous read for use during system-prompt construction (which
 *  happens inside an adapter's `init`, not an async context). Returns
 *  null when no plan is saved or the file is unreadable — the prompt
 *  builder treats that as "no active plan" rather than throwing. */
export function readPlanSync(): StoredPlan | null {
  try {
    const raw = readFileSync(getPlanFilePath(), 'utf8');
    const parsed = StoredPlanSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Drop the saved plan. Called when the user explicitly clears it
 *  from the plan view, or when a fresh task warrants starting over. */
export async function clearPlan(): Promise<void> {
  try {
    await rm(getPlanFilePath(), { force: true });
  } catch {
    // best-effort
  }
}
