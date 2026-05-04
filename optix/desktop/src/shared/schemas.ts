import { z } from 'zod';

// A single shared `Uint8Array` schema. Zod's `z.instanceof(Uint8Array)`
// would otherwise infer `Uint8Array<ArrayBuffer>` (TS picks the strict
// constructor overload via `InstanceType<Uint8ArrayConstructor>`),
// which then mismatches everywhere else in the codebase that types
// bytes as plain `Uint8Array` (the interface default —
// `Uint8Array<ArrayBufferLike>`). Annotating the schema explicitly
// pins it to the loose form so all downstream types line up.
export const Uint8ArraySchema: z.ZodType<Uint8Array> = z.instanceof(Uint8Array);

export const ModeSchema = z.enum(['guide', 'action', 'automate']);
export type Mode = z.infer<typeof ModeSchema>;

// Provider list. Four BYO-key options + Optix Cloud (managed, billed via
// subscription, talks to our Firebase relay with a Bearer token instead
// of a raw provider key).
export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'kimi',
  'google',
  'optixCloud',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

// Optix Cloud subscription tiers. Mirrored from the Cloud Functions'
// `TOKEN_ALLOWANCE_MONTHLY` mapping; the renderer needs the literal
// for billing-error rendering ("Upgrade to Pro" vs "you're already on
// Pro — wait until renewal").
export const TierSchema = z.enum(['starter', 'pro']);
export type Tier = z.infer<typeof TierSchema>;

// A rectangular region on screen the model wants to point at.
// `label` capped at 200 chars — labels are short UI element names
// ("Submit button", "Tools menu"). Anything longer is the model
// dumping unrelated text or a compromised payload trying to blow up
// the overlay paint loop. Coordinates capped at 50_000 px — no real
// 2026 display exceeds ~32k px wide; 50k gives headroom while still
// rejecting garbage values that would explode the overlay's coord
// arithmetic.
export const TargetRegionSchema = z.object({
  label: z.string().max(200),
  x: z.number().int().nonnegative().lt(50_000),
  y: z.number().int().nonnegative().lt(50_000),
  width: z.number().int().positive().lt(50_000),
  height: z.number().int().positive().lt(50_000),
});
export type TargetRegion = z.infer<typeof TargetRegionSchema>;

// A single step in a walkthrough.
export const StepSchema = z.object({
  order: z.number().int().nonnegative(),
  text: z.string(),
  targetRegion: TargetRegionSchema.optional(),
});
export type Step = z.infer<typeof StepSchema>;

// Actions the model proposes. None are executed in Phase 1 — they're surfaced
// for display. In Phase 3 these become the input to the approval-gated automation layer.
export const ProposedActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: z.number().int(), y: z.number().int(), description: z.string() }),
  z.object({ kind: z.literal('type'), text: z.string(), description: z.string() }),
  z.object({ kind: z.literal('scroll'), direction: z.enum(['up', 'down']), amount: z.number().int(), description: z.string() }),
  z.object({ kind: z.literal('openUrl'), url: z.string().url(), description: z.string() }),
]);
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

// The canonical shape we expect from any model. All providers are prompted to
// return JSON matching this; we validate on receipt.
export const ModelResponseSchema = z.object({
  intent: z.string().min(1),
  confidence: z.number().min(0).max(1),
  answer: z.string().min(1),
  steps: z.array(StepSchema).default([]),
  targetRegions: z.array(TargetRegionSchema).default([]),
  warnings: z.array(z.string()).default([]),
  proposedActions: z.array(ProposedActionSchema).default([]),
  requiresApproval: z.boolean(),
});
export type ModelResponse = z.infer<typeof ModelResponseSchema>;

// ============================================================================
// Computer Use loop — multi-turn agent that takes actions on the user's screen,
// re-screenshots between each, and feeds results back to the model.
// Mirrors Anthropic's `computer_20251124` tool input schema so we can pass the
// model's tool_use.input straight through Zod validation. Coordinates are
// `[x, y]` tuples in the screenshot's pixel space (Opus 4.7 = 1:1, no scaling).
// ============================================================================

const Coord = z.tuple([z.number(), z.number()]);
const ClickModifier = z.string().optional(); // e.g. "ctrl", "shift+alt"

// Optional `target` is the visible label/accessibility name of the element
// the model is acting on (e.g. "Firefox icon", "Submit button"). When
// provided, the executor uses the SAME label-matching snapper that Ask
// mode uses for overlay regions (Levenshtein + fuzzy ratio + token Jaccard
// + substring containment) to refine rough coordinates onto the precise
// element. Native computer-use models (Anthropic, OpenAI) typically
// don't emit this field; Kimi and Gemini are prompted to include it
// because their pixel-coordinate generation is unreliable.
const TargetLabel = z.string().optional();

export const ComputerToolActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('key'), text: z.string() }),
  z.object({ action: z.literal('hold_key'), text: z.string(), duration: z.number() }),
  z.object({ action: z.literal('type'), text: z.string() }),
  z.object({ action: z.literal('cursor_position') }),
  z.object({ action: z.literal('mouse_move'), coordinate: Coord, target: TargetLabel }),
  z.object({ action: z.literal('left_mouse_down'), coordinate: Coord }),
  z.object({ action: z.literal('left_mouse_up'), coordinate: Coord }),
  z.object({ action: z.literal('left_click'), coordinate: Coord, text: ClickModifier, target: TargetLabel }),
  z.object({ action: z.literal('right_click'), coordinate: Coord, text: ClickModifier, target: TargetLabel }),
  z.object({ action: z.literal('middle_click'), coordinate: Coord, text: ClickModifier, target: TargetLabel }),
  z.object({ action: z.literal('double_click'), coordinate: Coord, text: ClickModifier, target: TargetLabel }),
  z.object({ action: z.literal('triple_click'), coordinate: Coord, text: ClickModifier, target: TargetLabel }),
  z.object({
    action: z.literal('left_click_drag'),
    start_coordinate: Coord,
    coordinate: Coord,
  }),
  z.object({ action: z.literal('screenshot') }),
  z.object({ action: z.literal('wait'), duration: z.number() }),
  z.object({
    action: z.literal('scroll'),
    coordinate: Coord,
    scroll_direction: z.enum(['up', 'down', 'left', 'right']),
    scroll_amount: z.number(),
    text: ClickModifier,
    target: TargetLabel,
  }),
]);
export type ComputerToolAction = z.infer<typeof ComputerToolActionSchema>;

// ---------------------------------------------------------------------------
// File-system tool actions. These are custom tools (not Anthropic's built-in
// text_editor) so we can shape them to fit Optix's UX exactly: list, read,
// search, and write. The agent gets these alongside the computer tool when
// in Access mode and picks per turn based on the task.
// ---------------------------------------------------------------------------

export const FileToolActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list_directory'), path: z.string() }),
  z.object({ action: z.literal('read_file'), path: z.string() }),
  z.object({
    action: z.literal('search_files'),
    root: z.string(),
    pattern: z.string(),
  }),
  z.object({
    action: z.literal('write_file'),
    path: z.string(),
    // Required — the model must explicitly pass `''` to create an empty
    // file. We previously defaulted to '' but that masked a real model
    // bug where it forgot the content; the parse-error fallback now
    // surfaces "content is required" so the model can self-correct.
    content: z.string(),
  }),
  z.object({ action: z.literal('create_directory'), path: z.string() }),
]);
export type FileToolAction = z.infer<typeof FileToolActionSchema>;

// ---------------------------------------------------------------------------
// Label-based tool actions. The model identifies a UI element by its visible
// label or accessibility name; the host resolves it to screen coordinates
// via UIA (with potential OCR fallback) then executes via robotjs.
//
// Why: weaker vision models (Kimi, Gemini) generate poor screen-pixel
// coordinates. Asking them for a LABEL ("Submit", "Firefox", "Tools menu")
// plays to their strength — they recognise text and icons well — and lets
// the host do the pixel arithmetic.
// ---------------------------------------------------------------------------

export const LabelToolActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click_label'), label: z.string() }),
  z.object({
    action: z.literal('scroll_label'),
    label: z.string(),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().positive().default(3),
  }),
  z.object({
    action: z.literal('type_into_label'),
    label: z.string(),
    text: z.string(),
  }),
]);
export type LabelToolAction = z.infer<typeof LabelToolActionSchema>;

// Meta tools — actions that pause the loop for user interaction rather
// than running on the OS. The renderer is the "executor" here: it shows
// a UI, captures the user's input, and feeds the choice back as the
// tool_result text on the next continue() call.
export const AskUserActionSchema = z.object({
  action: z.literal('ask_user'),
  /** The question shown to the user as a header above the choices. */
  question: z.string().min(1),
  /** Up to 4 options. Each option's `label` is the button text; `value`
   *  is what gets sent back to the model as the tool_result. */
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        value: z.string(),
        description: z.string().optional(),
      }),
    )
    .min(1)
    .max(4),
  /** When true, the UI also shows a freeform text input so the user
   *  can type an answer that isn't in the options list. */
  allowFreeform: z.boolean().optional(),
});
export type AskUserAction = z.infer<typeof AskUserActionSchema>;

export const MetaToolActionSchema = AskUserActionSchema;
export type MetaToolAction = z.infer<typeof MetaToolActionSchema>;

// Shell tool — execute non-interactive shell commands. Used for
// scripted work the visual `computer` tool would do too slowly: pip
// installs, test runs, git ops, file system batch ops the file tools
// don't cover. Output is captured and returned as the tool_result so
// the agent can read what happened. Approval gating is mandatory in
// per-task / each-action modes, and out-of-workspace `cwd` always
// gates regardless of mode (parallel to the file-tool boundary).
export const ShellToolActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run_command'),
    /** The shell command to run. Use `&&`, `|`, `>` freely — we spawn
     *  with `shell: true` so the OS shell parses the line. */
    command: z.string().min(1),
    /** Absolute path the command runs in. Defaults to the user's
     *  workspace folder when set, otherwise the OS home dir. The
     *  agent should pass an explicit `cwd` for any task whose output
     *  depends on the working directory. */
    cwd: z.string().optional(),
    /** Hard timeout in ms. Capped at 120s — long-running tasks
     *  (build watchers, dev servers) need a different mechanism. */
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }),
]);
export type ShellToolAction = z.infer<typeof ShellToolActionSchema>;

// Plan tool. Lets the agent write down a structured plan before
// executing a complex multi-step task (coding, multi-file edits, long
// automation chains). Only one plan exists at a time — a new
// `set_plan` call overwrites the saved one. The renderer pauses the
// loop on each plan call and asks the user to approve, deny, or send
// feedback before continuing.
export const PlanToolActionSchema = z.object({
  action: z.literal('set_plan'),
  /** Free-form Markdown body — typically a numbered or bulleted list
   *  of steps. Free-form keeps the tool simple while letting the
   *  agent decide structure based on task complexity. */
  content: z.string().min(1),
  /** Optional one-line note on why the plan changed. Useful when the
   *  agent revises mid-task ("user clarified that…", "adding step
   *  for the test failure"). */
  rationale: z.string().optional(),
});
export type PlanToolAction = z.infer<typeof PlanToolActionSchema>;

// Unified internal representation. Anthropic's `tool_use` block carries a
// tool name + input; we tag each one with which surface it came from so the
// executor can dispatch and the UI can render distinct icons / descriptions.
export const AgentActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('computer'), data: ComputerToolActionSchema }),
  z.object({ tool: z.literal('file'), data: FileToolActionSchema }),
  z.object({ tool: z.literal('label'), data: LabelToolActionSchema }),
  z.object({ tool: z.literal('meta'), data: MetaToolActionSchema }),
  z.object({ tool: z.literal('plan'), data: PlanToolActionSchema }),
  z.object({ tool: z.literal('shell'), data: ShellToolActionSchema }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

// Recorded routine — a sequence of agent actions captured from a
// successful run, replayable later via the Automate tab. The
// recording captures each action plus the agent narration that
// preceded it, so a hint-based replay can give the model the same
// reasoning trail it had the first time. Edits to the routine
// (rename, reorder, delete actions) write back to the same file.
export const RecordedActionSchema = z.object({
  /** Full agent action — tool + data — preserved for replay fidelity. */
  action: AgentActionSchema,
  /** Human-readable description rendered in the detail view's
   *  reorderable list. Generated at record time so editing the action
   *  data later doesn't silently desync the description. */
  description: z.string(),
  /** Agent narration that led to this action (the model's text in the
   *  same turn). Optional — the agent doesn't always emit text. Used
   *  by hint-based replay so the LLM has the same context. */
  modelText: z.string().optional(),
  /** UIA element name under the click point at record time (e.g.
   *  "Buttonfly", "Sign in button"). Lets replay match the element
   *  by name when coordinates have shifted. Click/drag/scroll actions
   *  populate this; type/key/file/shell actions don't. */
  targetElementName: z.string().optional(),
  /** UIA control type at the click point ("ListItem", "Button",
   *  "Hyperlink"). Disambiguates when multiple elements share a name. */
  targetElementType: z.string().optional(),
  /** Foreground window title at action time ("File Explorer —
   *  Buttonfly", "Mozilla Firefox"). Helps the agent know which app
   *  the action belonged to so it can re-focus the right window
   *  before replaying. */
  windowTitle: z.string().optional(),
});
export type RecordedAction = z.infer<typeof RecordedActionSchema>;

export const RoutineSchema = z.object({
  id: z.string(),
  /** Sequential, human-friendly identifier shown as "OA-{n}" in the
   *  slash menu and used for token references like `/OA-431`. Assigned
   *  by the routine store on save (max existing + 1). Optional in the
   *  schema for backwards compat with routines saved before this
   *  field existed; the store lazy-migrates on first list. */
  oaNumber: z.number().int().positive().optional(),
  /** Display name shown in the slash menu + list view. Defaults to a
   *  trimmed version of the original prompt; users can rename. */
  name: z.string(),
  /** The user's prompt that started the recorded run. Replay submits
   *  this verbatim (plus a hint block) as the routine's input. */
  originalPrompt: z.string(),
  actions: z.array(RecordedActionSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Provider/model the routine was recorded against. Surfaced in the
   *  list view so users know which model produced it; replay still
   *  uses whatever provider is currently active. */
  providerId: z.string(),
  modelId: z.string(),
  /** Number of agent turns the recording spanned. Each turn is one
   *  model API call; a single turn can produce many actions. Lets the
   *  list view show the same turns/actions split as Access Logs. */
  turnCount: z.number().int().nonnegative().optional(),
  /** Total API cost (USD) of the recording run. Computed from each
   *  turn's reported usage at record time using the same `costForTurn`
   *  helper the audit log uses. */
  estimatedCostUsd: z.number().nonnegative().optional(),
  /** Initial screenshot dimensions at record time. Mirrors the
   *  audit log's `imageWidth/imageHeight` so the routine detail
   *  meta card can show the same resolution pill Access Log
   *  Details shows. */
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
});
export type Routine = z.infer<typeof RoutineSchema>;

/** Lightweight summary for the list view — keeps the on-disk JSON
 *  parse cheap by not loading every action's full payload. */
export type RoutineSummary = {
  id: string;
  oaNumber?: number;
  name: string;
  originalPrompt: string;
  createdAt: string;
  updatedAt: string;
  actionCount: number;
  turnCount?: number;
  estimatedCostUsd?: number;
  imageWidth?: number;
  imageHeight?: number;
  providerId: string;
  modelId: string;
};

// Persisted plan state — saved on every approved `set_plan` call,
// read by the renderer's plan view + by the agent on subsequent turns
// so the saved plan stays in conversation context. One global plan at
// a time; new approvals overwrite the file in place.
export const StoredPlanSchema = z.object({
  content: z.string(),
  rationale: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Loop ID that produced this plan (audit trail; the same plan can
   *  span many turns within a loop). */
  loopId: z.string().optional(),
});
export type StoredPlan = z.infer<typeof StoredPlanSchema>;

// One pending tool_use the loop wants the host to execute.
export const ComputerToolUseSchema = z.object({
  id: z.string(),
  action: ComputerToolActionSchema,
});
export type ComputerToolUse = z.infer<typeof ComputerToolUseSchema>;

// Generalised tool_use that carries either a computer or file action.
// Replacing ComputerToolUse over time — kept side-by-side during transition.
export const AgentToolUseSchema = z.object({
  id: z.string(),
  action: AgentActionSchema,
});
export type AgentToolUse = z.infer<typeof AgentToolUseSchema>;

// One side of a tool_result the renderer ships back after running a tool_use.
// `screenshotBytes` is the post-action screenshot (preferred response). For
// `cursor_position` actions we send `text` instead; for any failure we send
// `errorText` so the model can recover gracefully.
export const ComputerToolResultSchema = z.object({
  toolUseId: z.string(),
  screenshotBytes: Uint8ArraySchema.optional(),
  screenshotMimeType: z.string().optional(),
  text: z.string().optional(),
  errorText: z.string().optional(),
  /** Renderer-measured wall-clock time the action took to execute,
   *  including any post-action settle delay + screenshot capture. Used
   *  for the audit log so the run-history view can show per-action
   *  latency instead of always-zero placeholders. */
  durationMs: z.number().int().nonnegative().optional(),
});
export type ComputerToolResult = z.infer<typeof ComputerToolResultSchema>;

// Server reply after a step. `done=true` means stop the loop and use
// `finalResponse` as the user-facing answer. Otherwise execute `toolUses`,
// gather results, and call `continue`. Each tool_use carries an
// `AgentAction` so the renderer can dispatch to the right executor and the
// UI can render appropriate icons / descriptions.
export const ComputerLoopTurnSchema = z.object({
  loopId: z.string(),
  toolUses: z.array(AgentToolUseSchema).default([]),
  done: z.boolean().default(false),
  // When `done`, the model's natural-language wrap-up. We surface it as the
  // `answer` field of a ModelResponse-shaped object so existing UI renders it.
  finalText: z.string().optional(),
  // The turn index just executed (0-based). Used by UI to show "step N/cap".
  turnIndex: z.number().int().nonnegative(),
  // True when the loop hit its iteration cap and bailed; client should treat
  // this as an incomplete result.
  capped: z.boolean().default(false),
  // Token usage reported by the provider for this turn. Forwarded from
  // main so the renderer can accumulate per-turn cost on Automate
  // recordings (the routine list shows turns + cost like Access Logs
  // does). Optional for backwards compat with cached responses.
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
});
export type ComputerLoopTurn = z.infer<typeof ComputerLoopTurnSchema>;

export const ComputerLoopStartRequestSchema = z.object({
  prompt: z.string().min(1),
  imageBytes: Uint8ArraySchema,
  imageMimeType: z.string(),
  imageWidth: z.number().int().positive(),
  imageHeight: z.number().int().positive(),
  // User-attached reference images. Sent in the same initial user message
  // as the screenshot, before the prompt text. Defaults to [] for callers
  // that haven't been updated yet.
  imageAttachments: z
    .array(
      z.object({
        bytes: Uint8ArraySchema,
        mimeType: z.string(),
        filename: z.string().optional(),
      }),
    )
    .default([]),
  // Firebase ID token, only when active provider is 'optixCloud'.
  // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
  authToken: z.string().min(100).max(5000).optional(),
});
export type ComputerLoopStartRequest = z.infer<typeof ComputerLoopStartRequestSchema>;

export const ComputerLoopContinueRequestSchema = z.object({
  loopId: z.string(),
  results: z.array(ComputerToolResultSchema),
  /** Mid-loop user interrupt. When non-empty, the renderer is forwarding
   *  a message the user typed while the agent was running; the adapter
   *  appends it to the next user message so the agent re-reads its plan
   *  before the next turn. */
  extraUserText: z.string().optional(),
  /** Fresh Firebase ID token for Optix Cloud loops. Renderer mints one
   *  per continue call so the SDK client always speaks to the relay
   *  with an unexpired Bearer. Ignored for other providers. */
  // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
  authToken: z.string().min(100).max(5000).optional(),
});

// Append a brand-new user message to an existing (paused) Access loop.
// Used in conversationMode for follow-up submits — the agent keeps full
// memory of everything it just did rather than starting fresh.
export const ComputerLoopAppendRequestSchema = z.object({
  loopId: z.string(),
  prompt: z.string().min(1),
  imageBytes: Uint8ArraySchema.optional(),
  imageMimeType: z.string().optional(),
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  imageAttachments: z
    .array(
      z.object({
        bytes: Uint8ArraySchema,
        mimeType: z.string(),
        filename: z.string().optional(),
      }),
    )
    .default([]),
  // Firebase ID token for follow-up Access turns when on optixCloud.
  // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
  authToken: z.string().min(100).max(5000).optional(),
});
export type ComputerLoopAppendRequest = z.infer<typeof ComputerLoopAppendRequestSchema>;
export type ComputerLoopContinueRequest = z.infer<typeof ComputerLoopContinueRequestSchema>;

// ---------------------------------------------------------------------------
// Conversation persistence — when conversationMode is on, each prompt +
// response is appended to the current conversation. Persisted to disk one
// JSON file per conversation. Schema mirrors the audit log's "best-effort
// write on every event" approach so a crash mid-conversation still leaves
// a reloadable record.
// ---------------------------------------------------------------------------

export const ConversationAttachmentSchema = z.object({
  /** Relative path inside the conversation's image dir, e.g. `images/foo.png`. */
  path: z.string(),
  mimeType: z.string(),
  filename: z.string().optional(),
  byteLength: z.number().int().nonnegative().optional(),
});
export type ConversationAttachment = z.infer<typeof ConversationAttachmentSchema>;

/** Token usage reported by a provider's API response. Optional fields
 *  cover providers that don't expose a particular metric (e.g. Gemini
 *  doesn't split prompt cache hits at the same granularity Anthropic
 *  does). The cost-estimator multiplies these against the per-model
 *  rate table; missing values count as zero in the math. */
export const TokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ConversationTurnSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  mode: ModeSchema,
  prompt: z.string(),
  /** User-attached uploads (paths relative to conversation dir). */
  attachments: z.array(ConversationAttachmentSchema).default([]),
  /** Captured screenshot for this turn (path relative to conversation dir). */
  capturePath: z.string().optional(),
  captureMimeType: z.string().optional(),
  captureWidth: z.number().int().positive().optional(),
  captureHeight: z.number().int().positive().optional(),
  /** Ask-mode response (full ModelResponse). Mutually exclusive with loopId. */
  response: ModelResponseSchema.optional(),
  /** Token usage reported by the provider for this turn. Used by the
   *  Ask-log cost calculation; absent on Access turns (where the
   *  audit log holds the loop's per-turn usage instead) and on legacy
   *  turns persisted before usage tracking landed. */
  usage: TokenUsageSchema.optional(),
  /** Provider/model that produced this turn — recorded so a single
   *  conversation can mix providers and the cost estimator still
   *  picks the right rate per turn. Defaults to the conversation's
   *  top-level provider/model when missing. */
  providerId: ProviderIdSchema.optional(),
  modelId: z.string().optional(),
  /** Access-mode loop ID — deep-link into the audit log for the run. */
  loopId: z.string().optional(),
  /** Final text from the agent (Access mode wrap-up). */
  finalText: z.string().optional(),
  /** Error message if the turn failed. */
  errorMessage: z.string().optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  /** Auto-derived from the first turn's prompt — first ~50 chars. */
  title: z.string().optional(),
  providerId: ProviderIdSchema,
  modelId: z.string(),
  turns: z.array(ConversationTurnSchema).default([]),
});
export type Conversation = z.infer<typeof ConversationSchema>;

// A completed turn in the session history.
export const HistoryEntrySchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  mode: ModeSchema,
  prompt: z.string(),
  providerId: ProviderIdSchema,
  modelId: z.string(),
  response: ModelResponseSchema.optional(),
  error: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// IPC request/response shapes.

// User-attached image (uploaded via the 📎 button). Sent alongside the
// captured screenshot — the model sees BOTH in the user-message content.
// When privacy is paused, the screenshot is skipped but attachments still
// go through.
export const ImageAttachmentSchema = z.object({
  bytes: Uint8ArraySchema,
  mimeType: z.string(),
  filename: z.string().optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>;

// One past Q&A pair, sent to the provider so an Ask follow-up has the
// model's prior response in its message history. Without this, each
// Ask submit would be model-stateless even with conversationMode on
// (the visual thread shows past turns but the provider never saw them).
export const PriorTurnSchema = z.object({
  /** The user's prior prompt text. */
  prompt: z.string(),
  /** What the assistant said in response. For done turns this is the
   *  `answer` field of the prior ModelResponse, optionally followed by
   *  the steps as a list. For loop-done turns it's the agent's final
   *  text. The renderer formats this — providers just pass it through. */
  assistantText: z.string(),
});
export type PriorTurn = z.infer<typeof PriorTurnSchema>;

export const PromptRequestSchema = z.object({
  mode: ModeSchema,
  prompt: z.string().min(1),
  // Raw image bytes (preferred — avoids base64 IPC overhead). Each provider
  // converts to its own format (data URL, raw base64, etc.) when building
  // the API call.
  imageBytes: Uint8ArraySchema.optional(),
  imageMimeType: z.string().optional(),
  // Pixel dimensions of the screenshot, used by main-side coordinate-snap
  // helpers (UIA / OCR) to map between screenshot coords and screen coords.
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  // User-attached reference images (uploaded via the 📎 button). Sent in
  // the same user message as the screenshot, BEFORE the prompt text.
  imageAttachments: z.array(ImageAttachmentSchema).default([]),
  // Past Q&A pairs prepended to the model's message history when
  // conversationMode is on. Without these, an Ask follow-up is sent
  // as if it were a fresh first-time question.
  priorTurns: z.array(PriorTurnSchema).default([]),
  // Firebase ID token, only sent when activeProviderId === 'optixCloud'.
  // The cloud relay verifies it server-side. ID tokens expire in 1 hour
  // so the renderer fetches a fresh one (via the Firebase SDK's auto-
  // refresh) right before each call instead of caching it in main.
  // 100–5000 chars: Firebase ID tokens are ~1 KB; defends against blob injection.
  authToken: z.string().min(100).max(5000).optional(),
});
export type PromptRequest = z.infer<typeof PromptRequestSchema>;

export const SettingsSchema = z.object({
  activeProviderId: ProviderIdSchema,
  modelByProvider: z.record(ProviderIdSchema, z.string()),
  privacyPaused: z.boolean(),
  hotkeyToggleWidget: z.string(),
  /**
   * When true, providers that support it (currently: Kimi via `$web_search`)
   * are given a web-search tool. The model decides when to use it — useful
   * for apps the model isn't familiar with. Costs: extra latency + the search
   * is billed against the provider's API key.
   */
  webSearchEnabled: z.boolean().default(false),
  /**
   * When true, the model is asked to include target-region bounding boxes
   * for walkthrough steps so the user can press "Show on screen" to see
   * them highlighted. Off saves tokens for users who don't use the overlay.
   */
  overlayEnabled: z.boolean().default(true),
  /**
   * Action-mode approval gate behaviour.
   *  - `per-task`: one confirmation at the start of each loop (default)
   *  - `each-action`: confirm every individual action before it executes
   *  - `never`: run without confirmation (relies on Stop button for safety)
   */
  agentApprovalMode: z.enum(['per-task', 'each-action', 'never']).default('per-task'),
  /**
   * Optional cost ceiling for a single Computer Use loop, in USD. The loop
   * checks the estimated cost after each turn and stops if it exceeds this
   * value. `null` (default) means no cap.
   */
  // 0/negative coerces to null because "no effective cap" should be
  // expressed as null, not 0 — `cost <= 0` would otherwise short-circuit
  // the loop's ceiling check on the very first turn.
  agentCostCeilingUsd: z.number().nonnegative().nullable().default(null).transform((v) => (typeof v === 'number' && v < 0.01 ? null : v)),
  /**
   * Optional workspace-folder path. When set, file-system actions targeting
   * paths inside this folder follow the regular approval mode; actions
   * outside it force a per-action prompt (except in `never` mode).
   * `null` means no scope — every FS action follows the approval mode
   * normally.
   */
  // Empty / whitespace-only strings coerce to `null` — the field's
  // semantic intent is "no scope" rather than "scope set to the empty
  // string". Without this, a settings UI that posts `''` on clear
  // would leave a sentinel value that downstream `agentWorkspaceFolder
  // === null` checks miss, treating every path as in-workspace.
  agentWorkspaceFolder: z
    .string()
    .nullable()
    .default(null)
    .transform((v) => (typeof v === 'string' && v.trim() === '' ? null : v)),
  /**
   * When true, prompts are stitched into an ongoing conversation: each
   * new prompt sends the prior turns as context, and the response area
   * shows a stacked thread instead of a single response card. When false
   * (default), every prompt is a one-shot.
   */
  conversationMode: z.boolean().default(false),
  /**
   * Visual theme. The renderer applies this as a `data-theme` attribute
   * on the document root, and the stylesheet flips its CSS variables
   * accordingly. Dark is the historical default (matches the floating-
   * over-the-screen aesthetic); light is for daytime / brighter
   * environments where dark-on-bright is hard to read.
   */
  theme: z.enum(['dark', 'light']).default('dark'),
});
export type Settings = z.infer<typeof SettingsSchema>;
