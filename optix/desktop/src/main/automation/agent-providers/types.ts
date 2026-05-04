// Provider-agnostic Computer Use adapter interface.
//
// Each LLM that supports computer-use semantics (Anthropic claude_4-7,
// OpenAI computer-use-preview, Gemini 2.5 Computer Use, etc.) implements
// this. The shared loop driver in `computer-loop.ts` calls these methods
// and is otherwise blissfully unaware of which API is on the other side.
//
// The shape is deliberately stateful: the adapter holds the conversation
// history (in whatever format the provider's API expects) inside an
// opaque `state` object that the loop driver passes back on every call.
//
// Two reasons for the parse-error split:
//   - The adapter knows its own response format and can localise errors
//     ("missing `content` for write_file") rather than letting them
//     bubble up as opaque exceptions.
//   - The renderer never sees broken tool_uses (it can't execute them),
//     but the adapter remembers them internally so the next
//     `appendResults` call can synthesise an is_error tool_result back
//     to the model so it can self-correct.

import type { AgentAction, ProviderId } from '@shared/schemas';

export type AgentToolUse = { id: string; action: AgentAction };

/** Host-supplied result of executing one tool_use. The adapter converts
 *  this into the provider-native tool_result shape inside `appendResults`. */
export type AgentToolResult = {
  toolUseId: string;
  /** Post-action screenshot (computer actions). */
  screenshotBytes?: Uint8Array;
  screenshotMimeType?: string;
  /** Plain-text result (file actions, cursor_position). */
  text?: string;
  /** Failure message — surfaced as an `is_error` tool_result so the
   *  model can retry. */
  errorText?: string;
  /** Renderer-measured wall-clock duration for executing this tool —
   *  includes settle delay and post-action screenshot capture. Stored
   *  in the audit log; the model never sees it. */
  durationMs?: number;
};

/** What `step()` returns to the loop driver. */
export type AgentTurnResult = {
  /** Successfully-parsed tool_uses the host should execute. */
  toolUses: AgentToolUse[];
  /** ids of tool_uses that failed input validation. The adapter has
   *  already remembered them internally; the loop driver just uses this
   *  list for telemetry / step-list rendering. */
  parseErrorIds: string[];
  /** Model's natural-language text for this turn (narration or final
   *  wrap-up). */
  finalText?: string;
  /** True when the model emitted no tool_uses — task is complete. */
  done: boolean;
  /** Telemetry for the audit log. Optional fields are best-effort —
   *  providers that don't expose them just leave them undefined. */
  apiMs: number;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};

export type AgentInitOpts = {
  apiKey: string;
  modelId: string;
  prompt: string;
  imageBytes: Uint8Array;
  imageMimeType: string;
  imageWidth: number;
  imageHeight: number;
  workspaceFolder: string | null;
  /** User-attached reference images; appear in the same initial user
   *  message as the screenshot, before the prompt text. */
  imageAttachments?: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>;
};

/** Adapter shape. State is opaque to the loop driver — each provider
 *  picks its own representation and just hands it back via the methods. */
export interface AgentProviderAdapter<State = unknown> {
  readonly id: ProviderId;
  init(opts: AgentInitOpts): State;
  /** Run one turn against the API. Pushes the assistant turn into state
   *  and returns parsed tool_uses + telemetry. */
  step(state: State, abortSignal: AbortSignal): Promise<AgentTurnResult>;
  /** Append host-supplied tool_results to the conversation state. The
   *  adapter combines these with any internally-remembered parse errors
   *  from the previous turn so the resulting user message satisfies the
   *  provider's "every tool_use needs a tool_result" protocol.
   *
   *  `opts.extraUserText` carries a mid-loop user interrupt — text the
   *  user typed while the agent was running. Adapters append it as a
   *  text block to the same user message as the tool_results so the
   *  model sees the new instruction and can re-plan before the next
   *  turn. Optional; not all providers may handle it cleanly yet. */
  appendResults(
    state: State,
    results: AgentToolResult[],
    opts?: { extraUserText?: string },
  ): void;
  /** Append a brand-new user message to a paused conversation. Used in
   *  conversationMode for follow-up submits — the agent retains full
   *  history (the just-created folder, the file it just opened) instead
   *  of starting fresh. After this call the next `step()` will read the
   *  new user message as if the agent had never stopped. */
  appendUserTurn(state: State, opts: AppendUserTurnOpts): void;
  /** Optional: swap in a fresh credential for the underlying SDK
   *  client. Only Optix Cloud uses this — Firebase ID tokens expire
   *  after ~1 hour, so any conversation-mode loop that sits idle long
   *  enough would otherwise fail with 401 mid-turn. The renderer
   *  attaches a freshly-minted token to each continue/append request,
   *  and the loop driver calls this before the next step. Adapters
   *  that don't need refresh (BYO-key providers) leave it undefined. */
  refreshCredential?(state: State, credential: string): void;
}

export type AppendUserTurnOpts = {
  prompt: string;
  /** Fresh screenshot (optional — privacy-paused submits skip it). */
  imageBytes?: Uint8Array;
  imageMimeType?: string;
  imageWidth?: number;
  imageHeight?: number;
  imageAttachments?: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>;
};
