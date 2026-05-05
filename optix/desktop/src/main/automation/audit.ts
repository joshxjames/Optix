import { app } from 'electron';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentAction, PlanToolAction, ProviderId } from '@shared/schemas';
import { describeComputerAction, describeLabelAction } from '@main/automation/executor';
import { describeFileAction } from '@main/automation/file-executor';
import { describeShellAction } from '@main/automation/shell-executor';

/** First non-blank line of the plan, capped at 60 chars — keeps the
 *  audit row tight while still hinting at what the plan covered. */
function describePlanAction(a: PlanToolAction): string {
  const head = a.content.split('\n').find((l) => l.trim().length > 0) ?? '';
  const trimmed = head.length > 60 ? head.slice(0, 57) + '…' : head;
  return trimmed ? `Proposed plan: ${trimmed}` : 'Proposed plan';
}

// One JSON file per loop, written on every event so a crash mid-task still
// leaves a usable record. Files live in <userData>/audit/loops/. The settings
// "Open audit folder" button opens this directory in the OS file manager.

// Round 9.2: explicit undefined for exactOptionalPropertyTypes
export type AuditActionRecord = {
  toolUseId: string;
  action: AgentAction;
  description: string;
  ok: boolean;
  errorText?: string | undefined;
  resultKind: 'screenshot' | 'text' | 'error' | 'none';
  durationMs: number;
};

// Round 9.2: explicit undefined for exactOptionalPropertyTypes
export type AuditTurnRecord = {
  turnIndex: number;
  startedAt: string;
  apiMs: number;
  stopReason?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  modelText?: string | undefined;
  actions: AuditActionRecord[];
};

export type AuditOutcome = 'done' | 'aborted' | 'capped' | 'error' | 'abandoned';

/** One user-submitted message inside a loop. With option-A
 *  conversation-mode continuity, a single loop may have many of
 *  these — message #1 starts the loop, follow-ups are appended via
 *  `appendUserMessageToLoop`. The viewer groups turns under the
 *  message that triggered them so multi-message conversations read
 *  as separate sections instead of a flat 50-turn list. */
export type AuditUserMessage = {
  /** 0-based index — message #0 is the loop's initial prompt. */
  index: number;
  prompt: string;
  startedAt: string;
  /** Index of the first turn that belongs to this message. Subsequent
   *  turns up to (but not including) the next message's
   *  `firstTurnIndex` are part of THIS message's response. */
  firstTurnIndex: number;
};

// Round 9.2: explicit undefined for exactOptionalPropertyTypes
export type AuditLog = {
  loopId: string;
  startedAt: string;
  endedAt?: string | undefined;
  providerId: ProviderId;
  modelId: string;
  /** First user prompt — kept for backwards compatibility with old
   *  audit JSON. New code should iterate `userMessages` instead. */
  prompt: string;
  imageWidth: number;
  imageHeight: number;
  /** Every user message in order, including the initial prompt. */
  userMessages: AuditUserMessage[];
  turns: AuditTurnRecord[];
  finalText?: string | undefined;
  outcome?: AuditOutcome | undefined;
  errorMessage?: string | undefined;
  estimatedCostUsd?: number | undefined;
};

const audits = new Map<string, AuditLog>();

function getAuditDir(): string {
  return path.join(app.getPath('userData'), 'audit', 'loops');
}

export function getAuditDirectoryPath(): string {
  return getAuditDir();
}

function fileNameFor(log: AuditLog): string {
  // Timestamp first so files sort chronologically in any explorer.
  const ts = log.startedAt.replace(/[:.]/g, '-');
  return `${ts}-${log.loopId.slice(0, 8)}.json`;
}

// Both persist paths use a tmp-write + rename so a crash mid-write can
// never produce a half-flushed JSON. Rename is atomic on POSIX and on
// Windows ReFS/NTFS, so the only states a reader can observe are "old
// file" or "new file" — never a truncated one. Concurrent-write note:
// if two writes for the SAME loop file race, the second `rename`
// overwrites the first. That's fine — audit logs grow monotonically so
// last-write-wins for the same loop is the desired behaviour.
// Different loops write to different filenames so they cannot conflict.
//
// Orphaned `.tmp` files (left if the process died between writeFile and
// rename) are implicitly ignored: `listAuditLogs` filters by `.json`
// extension below, so `.tmp` orphans never appear in the UI and harm
// nothing besides occupying a few KB until the directory is cleared.

/** Synchronous persist — used from `before-quit` where the process is
 *  about to exit and async writes wouldn't flush in time. Best-effort:
 *  every step (mkdirSync, writeFileSync, renameSync) can fail at quit
 *  time (disk full, permissions, antivirus locking the tmp file), and
 *  we'd rather lose the audit than block process exit. The outer
 *  `before-quit` handler also catches, but defending here means audit
 *  shutdown stays best-effort regardless of where it's called from. */
function persistSync(log: AuditLog): void {
  try {
    const dir = getAuditDir();
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, fileNameFor(log));
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(log, null, 2), 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    console.error(
      '[optix-audit] sync persist failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Async persist — used for every in-flight audit event (recordTurn,
 *  recordAction, etc.). Async because the loop calls this on every
 *  fast-path event and we don't want to block the main thread; sync
 *  is reserved for the shutdown path above where we have no choice. */
async function persist(log: AuditLog): Promise<void> {
  try {
    const dir = getAuditDir();
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, fileNameFor(log));
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(log, null, 2), 'utf8');
    await rename(tmp, target);
  } catch (err) {
    // Audit writes are best-effort — never throw into the loop.
    console.warn('[optix-audit] persist failed:', err instanceof Error ? err.message : err);
  }
}

export function startAudit(opts: {
  loopId: string;
  providerId: ProviderId;
  modelId: string;
  prompt: string;
  imageWidth: number;
  imageHeight: number;
}): void {
  const startedAt = new Date().toISOString();
  const log: AuditLog = {
    loopId: opts.loopId,
    startedAt,
    providerId: opts.providerId,
    modelId: opts.modelId,
    prompt: opts.prompt,
    imageWidth: opts.imageWidth,
    imageHeight: opts.imageHeight,
    userMessages: [
      {
        index: 0,
        prompt: opts.prompt,
        startedAt,
        firstTurnIndex: 0,
      },
    ],
    turns: [],
  };
  audits.set(opts.loopId, log);
  void persist(log);
}

/**
 * Mark a loop's audit as "agent finished" without tearing the loop
 * state down. Used after every turn that ends with `done = true`,
 * so the on-disk audit shows `outcome: 'done'` and `finalText`
 * immediately — even when the loop stays alive in memory waiting for
 * a follow-up user message (option-A conversation continuity).
 *
 * If the loop is later aborted or errors, those paths overwrite the
 * outcome via `finalizeAudit`, which is the right precedence.
 */
export function markLoopDone(loopId: string, finalText: string | undefined): void {
  const log = audits.get(loopId);
  if (!log) return;
  log.outcome = 'done';
  // Most recent done's `finalText` wins — multi-message conversations
  // overwrite the prior message's wrap-up, which matches user
  // expectations (the latest agent reply is the "current" wrap-up).
  if (finalText) log.finalText = finalText;
  log.endedAt = new Date().toISOString();
  log.estimatedCostUsd = estimateCost(log);
  void persist(log);
}

/**
 * Record a follow-up user message in an existing audit. Called from
 * `appendUserMessageToLoop` when the user submits a new message into
 * a paused conversation-mode loop. Without this, follow-up prompts
 * are invisible in the audit log — the top-level `prompt` only
 * captures message #0.
 */
export function recordUserMessage(
  loopId: string,
  prompt: string,
  firstTurnIndex: number,
): void {
  const log = audits.get(loopId);
  if (!log) return;
  log.userMessages.push({
    index: log.userMessages.length,
    prompt,
    startedAt: new Date().toISOString(),
    firstTurnIndex,
  });
  void persist(log);
}

export function recordTurn(
  loopId: string,
  turn: Omit<AuditTurnRecord, 'actions' | 'startedAt'> & { startedAt?: string },
): void {
  const log = audits.get(loopId);
  if (!log) return;
  log.turns.push({
    ...turn,
    startedAt: turn.startedAt ?? new Date().toISOString(),
    actions: [],
  });
  void persist(log);
}

export function recordAction(
  loopId: string,
  turnIndex: number,
  record: Omit<AuditActionRecord, 'description'>,
): void {
  const log = audits.get(loopId);
  if (!log) return;
  const turn = log.turns.find((t) => t.turnIndex === turnIndex);
  if (!turn) return;
  turn.actions.push({
    ...record,
    description:
      record.action.tool === 'computer'
        ? describeComputerAction(record.action.data)
        : record.action.tool === 'file'
          ? describeFileAction(record.action.data)
          : record.action.tool === 'label'
            ? describeLabelAction(record.action.data)
            : record.action.tool === 'plan'
              ? describePlanAction(record.action.data)
              : record.action.tool === 'shell'
                ? describeShellAction(record.action.data)
                : `Asked user: ${record.action.data.question}`,
  });
  void persist(log);
}

export function finalizeAudit(
  loopId: string,
  outcome: AuditOutcome,
  finalText?: string,
  errorMessage?: string,
  /** When true, write synchronously — used from `before-quit` where the
   *  process may exit before async writes flush. Otherwise async. */
  sync = false,
): void {
  const log = audits.get(loopId);
  if (!log) return;
  log.endedAt = new Date().toISOString();
  log.outcome = outcome;
  log.finalText = finalText;
  log.errorMessage = errorMessage;
  log.estimatedCostUsd = estimateCost(log);
  if (sync) {
    persistSync(log);
  } else {
    void persist(log);
  }
  audits.delete(loopId);
}

// Cost estimate. The pricing table + per-turn calculation lives in
// `@main/storage/pricing` so the chat-history module can compute Ask
// costs from the same source of truth — keeping rates in one place
// avoids drift when providers change prices.

import { costForTurns } from '@shared/pricing';

function estimateCost(log: AuditLog): number {
  return costForTurns(
    log.turns.map((t) => ({
      modelId: log.modelId,
      usage: {
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheCreationInputTokens: t.cacheCreationInputTokens,
        cacheReadInputTokens: t.cacheReadInputTokens,
      },
    })),
  );
}

export function getEstimatedCost(loopId: string): number | undefined {
  const log = audits.get(loopId);
  if (!log) return undefined;
  return estimateCost(log);
}

// ---------------------------------------------------------------------------
// Audit log reading — used by the in-app viewer in Settings. We read directly
// from disk rather than maintain an in-memory cache: the renderer opens the
// list infrequently and old runs are persisted, not held in memory.
// ---------------------------------------------------------------------------

// Round 9.2: explicit undefined for exactOptionalPropertyTypes
export type AuditLogSummary = {
  filename: string;
  loopId: string;
  startedAt: string;
  endedAt?: string | undefined;
  /** First user message — used as the row's headline. */
  prompt: string;
  outcome?: AuditOutcome | undefined;
  modelId: string;
  providerId: ProviderId;
  /** Total user messages in the run. >1 means a multi-message
   *  conversation-mode session; single-message runs render without
   *  the message-count icon to keep the list tight. */
  messageCount: number;
  turnCount: number;
  actionCount: number;
  estimatedCostUsd?: number | undefined;
};

/** List all audit logs newest-first, returning lightweight summaries for the
 *  list view. We open and parse each file (cheap — they're small JSON), then
 *  return a tight summary for rendering. */
export async function listAuditLogs(): Promise<AuditLogSummary[]> {
  const dir = getAuditDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  // `.json` filter also implicitly skips any `.tmp` orphans left behind
  // by a crash mid-rename in `persist` / `persistSync`.
  const jsons = files.filter((f) => f.endsWith('.json'));
  // `Promise.allSettled` not `Promise.all`: a single corrupt or
  // unreadable file shouldn't blank the whole list view. Rejected reads
  // are logged so the user has a breadcrumb, but the list still
  // renders the surviving entries.
  const settled = await Promise.allSettled(
    jsons.map(async (f): Promise<AuditLogSummary> => {
      const raw = await readFile(path.join(dir, f), 'utf8');
      const log = JSON.parse(raw) as AuditLog;
      // Backwards-compat for old audit JSON without `userMessages`.
      const messageCount = Array.isArray(log.userMessages)
        ? log.userMessages.length
        : 1;
      return {
        filename: f,
        loopId: log.loopId,
        startedAt: log.startedAt,
        endedAt: log.endedAt,
        prompt: log.prompt,
        outcome: log.outcome,
        modelId: log.modelId,
        providerId: log.providerId,
        messageCount,
        turnCount: log.turns.length,
        actionCount: log.turns.reduce((n, t) => n + t.actions.length, 0),
        estimatedCostUsd: log.estimatedCostUsd,
      };
    }),
  );
  const summaries: AuditLogSummary[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      summaries.push(r.value);
    } else {
      console.warn(
        `[optix-audit] skipping unreadable log ${jsons[i] ?? '?'}:`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  });
  return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Delete a single audit log by filename. Same filename validation as
 *  `readAuditLog` to prevent directory traversal. Best-effort: returns
 *  true on success, false if the file didn't exist or couldn't be
 *  removed (the latter logs a warning). */
export async function deleteAuditLog(filename: string): Promise<boolean> {
  // No colon in the allowed set — on Windows / NTFS it's part of the
  // alternate-data-stream syntax (`file.json:hidden`) and drive-letter
  // syntax (`C:foo`), which can interact unexpectedly with `path.join`
  // and the OS file APIs. Our `fileNameFor` already normalises ISO
  // timestamp colons to `-`, so colons should never appear in a
  // legitimately-written audit filename.
  if (!/^[a-zA-Z0-9_\-]+\.json$/.test(filename)) return false;
  const dir = getAuditDir();
  try {
    await rm(path.join(dir, filename), { force: true });
    return true;
  } catch (err) {
    console.warn(
      '[optix-audit] delete failed:',
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Read a single audit log by filename. Validates the filename to prevent
 *  directory traversal (the renderer is untrusted from main's perspective). */
export async function readAuditLog(filename: string): Promise<AuditLog | null> {
  // No colon — see `deleteAuditLog` for the Windows ADS / drive-letter
  // rationale. `fileNameFor` already strips colons from the timestamp.
  if (!/^[a-zA-Z0-9_\-]+\.json$/.test(filename)) return null;
  const dir = getAuditDir();
  try {
    const raw = await readFile(path.join(dir, filename), 'utf8');
    const log = JSON.parse(raw) as AuditLog;
    // Backwards-compat: audits written before per-message tracking
    // existed have no `userMessages`. Synthesize a single entry from
    // the legacy top-level `prompt` so the viewer renders consistently.
    if (!Array.isArray(log.userMessages)) {
      log.userMessages = [
        {
          index: 0,
          prompt: log.prompt,
          startedAt: log.startedAt,
          firstTurnIndex: 0,
        },
      ];
    }
    return log;
  } catch {
    return null;
  }
}
