// Provider-agnostic Computer Use loop driver.
//
// What lives here:
//   - In-flight loop bookkeeping (the `loops` Map, turn count, cost cap)
//   - Audit logging (recordTurn / recordAction / finalizeAudit)
//   - Widget focus juggling so robotjs typing lands on the user's app
//   - Abort plumbing
//
// What does NOT live here (delegated to the per-provider adapter):
//   - Conversation format and message history
//   - Tool definitions and their input schemas
//   - API call, response parsing, prompt caching
//   - Provider-specific error / retry handling
//
// The adapter lookup happens via `getAgentProvider(providerId)` — the
// settings-store decides which provider is active, the loop driver just
// delegates.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ComputerLoopTurnSchema,
  ComputerToolResultSchema,
  type ComputerLoopAppendRequest,
  type ComputerLoopContinueRequest,
  type ComputerLoopStartRequest,
  type ComputerLoopTurn,
} from '@shared/schemas';
import { costForTurn } from '@shared/pricing';
import { setWidgetFocusable } from '@main/windows/widget-window';
import {
  finalizeAudit,
  getEstimatedCost,
  markLoopDone,
  recordAction,
  recordTurn,
  recordUserMessage,
  startAudit,
} from '@main/automation/audit';
import {
  getAgentProvider,
  hasAgentSupport,
} from '@main/automation/agent-providers/registry';
import type {
  AgentProviderAdapter,
  AgentToolResult,
} from '@main/automation/agent-providers/types';
import type { ProviderId } from '@shared/schemas';

// Soft turn cap — generous on purpose. The user can hit Stop at any time,
// so the cap exists only to break a model that's truly stuck in a no-progress
// loop (e.g. re-screenshotting the same state forever).
const MAX_TURNS = 100;

// Soft input-token ceiling per turn. Conversation-mode loops accumulate
// messages without bound (each turn appends a screenshot + tool_result);
// 100 turns × ~50 messages × image bytes can OOM the renderer or get the
// provider to reject the request as "context window exceeded". Anthropic
// Sonnet/Opus support 200K; we keep a safety margin so the provider's own
// limit isn't what trips us. When the projected total crosses this, the
// adapter's message history is truncated (see `maybeTruncateHistory`).
const TOKEN_SOFT_CAP = 150_000;
// Rough heuristic — bytes / 4 ≈ tokens for English + base64 images. Image
// blocks are the dominant cost; we estimate via the JSON.stringify byte
// length of the message array.
const BYTES_PER_TOKEN_ESTIMATE = 4;
// Truncation policy: keep the system-equivalent first 2 turns (the
// initial user prompt + the model's first reply), the most recent
// 20 turns, and drop everything in the middle. A "turn" here is one
// message in Anthropic's user/assistant array.
const KEEP_FIRST_TURNS = 2;
const KEEP_LAST_TURNS = 20;

type LoopState = {
  loopId: string;
  providerId: ProviderId;
  modelId: string;
  adapter: AgentProviderAdapter<unknown>;
  // Adapter's opaque state — passed back on every step / appendResults.
  adapterState: unknown;
  // Index of the turn we are *about* to run (0 = first model call after
  // the initial user message). Incremented on every successful continue.
  turnIndex: number;
  // Audit cache: tool_use ids + their parsed actions for the most recent
  // turn, so `appendResults` can record each one's outcome with the
  // correct action shape.
  pendingActions: Map<string, import('@shared/schemas').AgentAction>;
  // Flag — set true after `step()` returns toolUses, cleared in
  // `appendResults`. The protocol invariant is that every assistant turn
  // with tool_uses MUST be answered with matching tool_results in the
  // very next user turn before a fresh user message can be appended.
  // Without this guard, a renderer that mistakenly calls
  // `appendUserTurn` while results are still pending would produce a
  // malformed conversation (missing tool_result for tool_use ids), which
  // every adapter rejects with a 400 from the provider.
  awaitingResults: boolean;
  abortController: AbortController;
  startedAt: number;
  // Snapshot of the cost ceiling at loop start. We deliberately do NOT
  // re-read this from settings on every step: behaviour stays
  // deterministic for the lifetime of the loop (even if the user opens
  // settings mid-run and bumps the ceiling, the new value won't take
  // effect until the next startComputerLoop). If you want live updates
  // in the future, the safer pattern is `Math.min(snapshot, current)`
  // so the user can lower but not raise the cap mid-run.
  costCeilingUsd: number | null;
  workspaceFolder: string | null;
};

// Schema for the tool_result array a renderer passes back via IPC. We
// re-use the shared ComputerToolResultSchema directly. Kept inline so a
// failure here surfaces a typed error to the IPC caller rather than
// crashing later in the adapter when an unexpected field shape blows up
// `appendResults`.
const ToolResultArraySchema = z.array(ComputerToolResultSchema);

/** Roughly estimate tokens for a provider state object. We don't have
 *  visibility into the provider-native message shape (each adapter holds
 *  its own opaque state), so we serialise to JSON and divide by 4. This
 *  over-estimates slightly for base64 images (which compress better than
 *  4:1 in token space) — that's fine, we'd rather truncate a bit early
 *  than blow the actual context window. */
function estimateStateBytes(state: unknown): number {
  try {
    return JSON.stringify(state, (_k, v) => {
      // Uint8Array / Buffer → use byteLength so images cost what they
      // cost rather than printing a huge JSON-ified array of integers.
      if (v instanceof Uint8Array) return `<${v.byteLength}b>`;
      return v;
    }).length;
  } catch {
    return 0;
  }
}

/** Truncate the adapter's message history when projected input tokens
 *  approach the soft cap. The policy is intentionally simple — keep the
 *  first KEEP_FIRST_TURNS messages (initial prompt + first assistant
 *  reply, which carry the task framing) and the last KEEP_LAST_TURNS
 *  (recent context the model needs to make its next decision); drop the
 *  middle. Provider adapters store their messages on a `messages` array
 *  field on the opaque state object — we duck-type that here rather
 *  than threading a new API method through every adapter. */
function maybeTruncateHistory(state: LoopState): void {
  const bytes = estimateStateBytes(state.adapterState);
  const tokens = Math.floor(bytes / BYTES_PER_TOKEN_ESTIMATE);
  if (tokens < TOKEN_SOFT_CAP) return;
  // Formal interface method (Round 8). Each adapter knows its own
  // history shape — Anthropic/Kimi use `messages`, Gemini uses
  // `contents`, OpenAI uses `input`. Pre-Round-8 this duck-typed
  // `state.messages` and silently no-op'd for the latter two — the
  // loop just kept growing until the provider returned a context-
  // overflow error. Now we delegate to the adapter.
  if (state.adapter.truncateHistory) {
    state.adapter.truncateHistory(state.adapterState);
    console.warn(
      `[optix-cu] history truncate triggered: estimated ${tokens} tokens > cap ${TOKEN_SOFT_CAP}`,
    );
  }
}

const loops = new Map<string, LoopState>();

export { hasAgentSupport };

/** Run one provider-side step + record it to the audit. Returns the turn
 *  payload the renderer needs to drive execution.
 *
 *  Cost-ceiling invariant: the user is never billed for a turn that crosses
 *  the ceiling — if a turn would cross it, we record the audit (so the run
 *  is debuggable) but tell the user it was capped before the next call goes
 *  out. The check has to happen BEFORE the loop sends another adapter call,
 *  not after; otherwise the just-finished turn's cost is already paid past
 *  the cap. We compute the post-turn estimate by adding this turn's
 *  `costForTurn` to the existing `getEstimatedCost(loopId)` value (which
 *  reads from the audit log, so the order matters: the audit must NOT yet
 *  contain this turn when we read it). If the projected total exceeds the
 *  ceiling, finalise with outcome='capped' (turn included so it's
 *  auditable) and return a synthetic capped turn. Edge case: the very
 *  first turn alone exceeds the cap — still persisted (audit shows what
 *  burned the budget) then immediately capped. */
async function stepAndRecord(state: LoopState): Promise<ComputerLoopTurn> {
  const result = await state.adapter.step(state.adapterState, state.abortController.signal);

  // Project the post-turn cost BEFORE writing the audit row. `getEstimatedCost`
  // reads from the in-memory audit log (which does not yet include this
  // turn), so adding `costForTurn(...)` for the just-returned usage gives
  // the accurate post-this-turn total. Doing the cap check after
  // `recordTurn` would already have committed the over-budget row to disk
  // before the user could be told.
  //
  // `state.costCeilingUsd` was snapshotted at loop start (see LoopState
  // doc) — if the user changes the setting mid-run it does NOT affect
  // the in-flight loop. This is deliberate: deterministic billing
  // behaviour beats cleverness, and "I started a $5 run, then dropped
  // the cap to $2 in settings, then it kept going past $2" is the kind
  // of surprise we'd rather avoid.
  const projectedCost =
    state.costCeilingUsd != null
      ? (getEstimatedCost(state.loopId) ?? 0) +
        costForTurn(state.modelId, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
        })
      : null;
  const overCeiling =
    state.costCeilingUsd != null &&
    projectedCost != null &&
    projectedCost > state.costCeilingUsd;

  // Always record the model's text on every turn, including the final
  // `done` one. Originally the wrap-up text was kept aside for
  // `finalizeAudit(log.finalText)` instead — but option-A continuity
  // keeps the loop alive on done and never finalizes, so that text
  // would be lost from the audit. Storing it on the turn itself means
  // the viewer renders it under the last "Turn N" entry whether or not
  // the loop is later torn down.
  //
  // We still record the over-ceiling turn into the audit so the run is
  // debuggable — the user just doesn't get charged for any further calls.
  recordTurn(state.loopId, {
    turnIndex: state.turnIndex,
    apiMs: result.apiMs,
    stopReason: result.stopReason,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
    modelText: result.finalText,
  });

  // Cache the parsed actions so `appendResults` (and audit) can attribute
  // each result to its action. Parse-error ids are NOT cached here — the
  // adapter handles the synthetic is_error tool_result internally.
  state.pendingActions = new Map(result.toolUses.map((tu) => [tu.id, tu.action]));
  // Track whether the next valid mutation is `appendResults` (results
  // pending) or `appendUserTurn` (turn complete). Mismatch is a protocol
  // violation — see the field comment on LoopState.
  state.awaitingResults = result.toolUses.length > 0;

  console.log(
    `[optix-cu] turn=${state.turnIndex} provider=${state.providerId} api=${result.apiMs}ms ` +
      `stop=${result.stopReason ?? '?'} toolUses=${result.toolUses.length} ` +
      `parseErrors=${result.parseErrorIds.length} ` +
      `cache_create=${result.cacheCreationInputTokens ?? 0} cache_read=${result.cacheReadInputTokens ?? 0}`,
  );

  if (overCeiling) {
    const msg = `(stopped — estimated cost $${projectedCost!.toFixed(4)} exceeded ceiling $${state.costCeilingUsd!.toFixed(2)})`;
    loops.delete(state.loopId);
    setWidgetFocusable(true);
    // finalizeAudit runs AFTER recordTurn so the persisted audit reflects
    // the actual tokens burned (matching `projectedCost`), then stamps
    // outcome='capped'. Even if the model returned `done: true` on this
    // same turn we still report `capped: true` to the renderer because
    // the run was halted by the ceiling, not by the agent finishing.
    finalizeAudit(state.loopId, 'capped', msg);
    return {
      loopId: state.loopId,
      toolUses: [],
      done: true,
      finalText: '(stopped — estimated cost would exceed ceiling)',
      turnIndex: state.turnIndex,
      capped: true,
    };
  }

  // When the agent reaches end_turn, stamp the audit with outcome='done'
  // and the wrap-up text right now. Option-A continuity keeps the loop
  // alive so finalizeAudit may never fire — without this the on-disk
  // audit is stuck with no outcome (renders as UNKNOWN) until/unless the
  // user explicitly tears the loop down.
  if (result.done) {
    markLoopDone(state.loopId, result.finalText);
  }

  return ComputerLoopTurnSchema.parse({
    loopId: state.loopId,
    toolUses: result.toolUses,
    done: result.done,
    finalText: result.finalText,
    turnIndex: state.turnIndex,
    capped: false,
    // Forward usage so the renderer can accumulate cost during
    // Automate recordings — the audit log stores its own copy
    // independently for the Access Logs view.
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheCreationInputTokens: result.cacheCreationInputTokens,
    cacheReadInputTokens: result.cacheReadInputTokens,
  });
}

export async function startComputerLoop(
  req: ComputerLoopStartRequest,
  apiKey: string,
  modelId: string,
  costCeilingUsd: number | null,
  workspaceFolder: string | null,
  providerId: ProviderId,
): Promise<ComputerLoopTurn> {
  const adapter = getAgentProvider(providerId);
  const loopId = randomUUID();
  const adapterState = adapter.init({
    apiKey,
    modelId,
    prompt: req.prompt,
    imageBytes: req.imageBytes,
    imageMimeType: req.imageMimeType,
    imageWidth: req.imageWidth,
    imageHeight: req.imageHeight,
    workspaceFolder,
    imageAttachments: req.imageAttachments,
  });

  const state: LoopState = {
    loopId,
    providerId,
    modelId,
    adapter: adapter as AgentProviderAdapter<unknown>,
    adapterState,
    turnIndex: 0,
    pendingActions: new Map(),
    awaitingResults: false,
    abortController: new AbortController(),
    startedAt: Date.now(),
    costCeilingUsd,
    workspaceFolder,
  };
  loops.set(loopId, state);

  startAudit({
    loopId,
    providerId,
    modelId,
    prompt: req.prompt,
    imageWidth: req.imageWidth,
    imageHeight: req.imageHeight,
  });

  // Take focus away from the widget for the lifetime of the loop so
  // robotjs typeString / keyTap calls land on the user's actual app, not
  // on our own UI. Restored on done / abort / error.
  setWidgetFocusable(false);

  try {
    const turn = await stepAndRecord(state);
    if (turn.done) {
      // The agent finished its current task, but we keep `state` in
      // `loops` so a follow-up user message can resume the same
      // conversation (option-A continuity). The renderer decides when
      // to call `endComputerLoop` for explicit teardown — typically
      // when the user starts a new conversation or toggles
      // conversationMode off. Widget focus is restored so the user
      // can interact with our UI while the loop is paused.
      //
      // (Cost-cap is handled inside `stepAndRecord` — if the just-
      // finished turn pushed the total over the ceiling it returns
      // `capped: true` already finalised, so we never reach here for
      // an over-ceiling run.)
      setWidgetFocusable(true);
    }
    return turn;
  } catch (err) {
    // Abort FIRST so any adapter awaiting `signal` (e.g. an in-flight
    // fetch in the Anthropic SDK) unwinds rather than hanging
    // indefinitely. Without this, swallowed errors leave the
    // AbortController in its initial state and the next adapter call
    // can race against an orphaned promise.
    state.abortController.abort();
    loops.delete(loopId);
    setWidgetFocusable(true);
    finalizeAudit(
      loopId,
      'error',
      undefined,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

export async function continueComputerLoop(
  req: ComputerLoopContinueRequest,
): Promise<ComputerLoopTurn> {
  const state = loops.get(req.loopId);
  if (!state) throw new Error(`Unknown loopId: ${req.loopId}`);

  // Optix Cloud only: swap in the fresh ID token before this turn so
  // the relay never sees an expired Bearer. No-op for adapters that
  // don't expose `refreshCredential`.
  if (req.authToken && state.adapter.refreshCredential) {
    state.adapter.refreshCredential(state.adapterState, req.authToken);
  }

  // Defensive parse — `req.results` is typed `AgentToolResult[]` at the
  // TypeScript level, but the IPC boundary erases types and a malformed
  // payload (wrong field shapes, non-string ids, oversized blobs) would
  // otherwise propagate into `appendResults` and crash the adapter. The
  // outer IPC validator already runs the request schema, but the array
  // members are validated here to keep the loop self-defending if a
  // caller updates one schema without the other.
  const parsed = ToolResultArraySchema.safeParse(req.results);
  if (!parsed.success) {
    throw new Error(
      `Invalid tool_result payload: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  const validatedResults = parsed.data as AgentToolResult[];

  // Validate that every parsed-action id has a renderer-supplied result.
  // The adapter handles parse-error ids internally during appendResults.
  const provided = new Set(validatedResults.map((r) => r.toolUseId));
  for (const [id] of state.pendingActions) {
    if (!provided.has(id)) {
      loops.delete(req.loopId);
      throw new Error(
        `Missing tool_result for tool_use ${id}. Expected ${state.pendingActions.size} results, got ${validatedResults.length}.`,
      );
    }
  }

  // Audit each renderer-supplied result against its parsed action.
  for (const r of validatedResults) {
    const action = state.pendingActions.get(r.toolUseId);
    if (!action) continue; // parse error — already accounted for by the adapter
    const resultKind: 'screenshot' | 'text' | 'error' | 'none' = r.errorText
      ? 'error'
      : r.screenshotBytes
        ? 'screenshot'
        : r.text
          ? 'text'
          : 'none';
    recordAction(state.loopId, state.turnIndex, {
      toolUseId: r.toolUseId,
      action,
      ok: !r.errorText,
      errorText: r.errorText,
      resultKind,
      // Use renderer-measured duration when supplied; older callers
      // (or actions that bypass timing) fall back to 0.
      durationMs: r.durationMs ?? 0,
    });
  }

  // Hand off to the adapter — it produces the next user turn (combining
  // renderer results + any internal parse-error tool_results). The
  // optional `extraUserText` carries a mid-loop user interrupt; the
  // adapter appends it as a text block to the same user message so the
  // model re-reads its plan before the next assistant turn.
  state.adapter.appendResults(
    state.adapterState,
    validatedResults,
    { extraUserText: req.extraUserText },
  );
  state.pendingActions = new Map();
  // Results received → we are no longer waiting; the next legal call
  // could be appendUserTurn (after this turn completes with done) or
  // another continue.
  state.awaitingResults = false;
  state.turnIndex += 1;

  // After appending results to the conversation, check whether the
  // accumulated history is approaching the soft token cap. We do this
  // BEFORE the next `step()` so the adapter sends a smaller payload
  // rather than getting rejected by the provider for context overflow.
  maybeTruncateHistory(state);

  if (state.turnIndex >= MAX_TURNS) {
    loops.delete(req.loopId);
    setWidgetFocusable(true);
    finalizeAudit(req.loopId, 'capped', `Stopped after ${MAX_TURNS} turns.`);
    return {
      loopId: state.loopId,
      toolUses: [],
      done: true,
      finalText: `(stopped after ${MAX_TURNS} turns — task may be incomplete)`,
      turnIndex: state.turnIndex,
      capped: true,
    };
  }

  try {
    const turn = await stepAndRecord(state);
    if (turn.done) {
      // Keep `state` alive for a possible follow-up user message — same
      // pattern as `startComputerLoop` above. Widget focus restored so
      // the user can type their next message into our input field.
      // Cost-cap handled inside `stepAndRecord` (see comment there).
      setWidgetFocusable(true);
    }
    return turn;
  } catch (err) {
    // See `startComputerLoop` catch — abort first so the adapter's
    // pending fetch unwinds.
    state.abortController.abort();
    loops.delete(req.loopId);
    setWidgetFocusable(true);
    finalizeAudit(
      req.loopId,
      'error',
      undefined,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

/**
 * Append a NEW user message to a paused loop and step the agent forward.
 * Used for conversationMode follow-up submits — the adapter state from
 * the previous task is preserved, so the agent retains all memory of
 * what it just did (created folders, opened files, navigated to pages).
 *
 * The renderer is expected to call this only after a previous turn has
 * reached `done` and the user has typed a new prompt. Mid-loop user
 * interrupts go through `continueComputerLoop`'s `extraUserText` path
 * instead.
 */
export async function appendUserMessageToLoop(
  req: ComputerLoopAppendRequest,
): Promise<ComputerLoopTurn> {
  const state = loops.get(req.loopId);
  if (!state) throw new Error(`Unknown loopId: ${req.loopId}`);

  // Protocol invariant — see LoopState.awaitingResults. The previous
  // assistant turn emitted tool_uses that were never paired with
  // tool_results; appending a fresh user message here would produce a
  // malformed conversation that the provider will reject. Surface the
  // bug to the renderer instead of letting the API call fail opaquely.
  if (state.awaitingResults) {
    throw new Error(
      'Cannot append user turn while tool_use results are pending. The renderer must call continueComputerLoop with results (or abortComputerLoop) before appending a new user message.',
    );
  }

  // Same refresh as continueComputerLoop — most relevant here, where a
  // user might come back to a paused conversation hours later.
  if (req.authToken && state.adapter.refreshCredential) {
    state.adapter.refreshCredential(state.adapterState, req.authToken);
  }

  state.adapter.appendUserTurn(state.adapterState, {
    prompt: req.prompt,
    imageBytes: req.imageBytes,
    imageMimeType: req.imageMimeType,
    imageWidth: req.imageWidth,
    imageHeight: req.imageHeight,
    imageAttachments: req.imageAttachments,
  });
  state.pendingActions = new Map();
  state.turnIndex += 1;

  // Conversation-mode follow-ups are the most likely path to hit the
  // soft cap (the loop has been running for many turns and now the
  // user appends another task on top). Truncate before the next step
  // for the same reason as `continueComputerLoop` above.
  maybeTruncateHistory(state);
  // Record the new prompt in the audit log BEFORE the next turn fires
  // so its `firstTurnIndex` correctly points at the upcoming turn (the
  // first one the agent will produce in response to this message).
  // Without this the audit only captures message #0; follow-ups in
  // conversation-mode are invisible.
  recordUserMessage(state.loopId, req.prompt, state.turnIndex);

  if (state.turnIndex >= MAX_TURNS) {
    loops.delete(req.loopId);
    setWidgetFocusable(true);
    finalizeAudit(req.loopId, 'capped', `Stopped after ${MAX_TURNS} turns.`);
    return {
      loopId: state.loopId,
      toolUses: [],
      done: true,
      finalText: `(stopped after ${MAX_TURNS} turns — task may be incomplete)`,
      turnIndex: state.turnIndex,
      capped: true,
    };
  }

  // The agent is about to take action again — drop widget focus so
  // robotjs typing lands in the foreground app, not our input.
  setWidgetFocusable(false);

  try {
    const turn = await stepAndRecord(state);
    if (turn.done) {
      setWidgetFocusable(true);
    }
    return turn;
  } catch (err) {
    // See `startComputerLoop` catch — abort first so the adapter's
    // pending fetch unwinds.
    state.abortController.abort();
    loops.delete(req.loopId);
    setWidgetFocusable(true);
    finalizeAudit(
      req.loopId,
      'error',
      undefined,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}

/**
 * Explicit teardown for a paused loop — called when the renderer
 * decides the conversation is over. The `outcome` lets the caller
 * distinguish:
 *  • 'done' — user explicitly wrapped up the conversation
 *  • 'abandoned' — implicit teardown (mode toggled off, new chat
 *     started, app quit). The audit log preserves the distinction so
 *     the run-history view can show what actually happened.
 */
export function endComputerLoop(
  loopId: string,
  outcome: 'done' | 'abandoned' = 'done',
): void {
  const state = loops.get(loopId);
  if (!state) return;
  loops.delete(loopId);
  setWidgetFocusable(true);
  finalizeAudit(loopId, outcome);
}

/**
 * Finalize every loop currently in memory with `outcome: 'abandoned'`.
 * Called from the app's `before-quit` handler so paused conversations
 * don't leave dangling audit JSON on disk (no `endedAt`, no `outcome`,
 * no cost estimate). Uses the synchronous persist path because the
 * process is about to exit and async fs writes wouldn't flush in time.
 */
export function finalizeAllPendingLoops(): void {
  for (const loopId of loops.keys()) {
    finalizeAudit(loopId, 'abandoned', undefined, undefined, /* sync */ true);
  }
  loops.clear();
}

export function abortComputerLoop(loopId: string): void {
  const state = loops.get(loopId);
  if (!state) return;
  state.abortController.abort();
  loops.delete(loopId);
  setWidgetFocusable(true);
  finalizeAudit(loopId, 'aborted', '(stopped by user)');
  console.log(`[optix-cu] aborted loop=${loopId}`);
}

export function isLoopActive(loopId: string): boolean {
  return loops.has(loopId);
}
