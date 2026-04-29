// The shape of window.optix exposed by the preload bridge.
// Both renderers (widget + settings) see this identical surface.

import type {
  ComputerLoopAppendRequest,
  ComputerLoopContinueRequest,
  ComputerLoopStartRequest,
  ComputerLoopTurn,
  ComputerToolAction,
  Conversation,
  ConversationTurn,
  FileToolAction,
  HistoryEntry,
  LabelToolAction,
  Mode,
  ModelResponse,
  ProposedAction,
  PromptRequest,
  ProviderId,
  RecordedAction,
  Routine,
  RoutineSummary,
  Settings,
  ShellToolAction,
  StoredPlan,
  TargetRegion,
} from './schemas';

export type ActionExecuteRequest = {
  action: ProposedAction;
  /** Optional — image dimensions the action's coordinates are relative to. */
  imageWidth?: number;
  imageHeight?: number;
};

export type ActionExecuteResult = { ok: true } | { ok: false; error: string };

/** Payload sent from main → overlay renderer with regions to draw. */
export type OverlayRenderPayload = {
  regions: TargetRegion[];
  /** Pixel size of the screenshot the model annotated against. */
  imageWidth: number;
  imageHeight: number;
  /** Logical pixel size of the display the overlay is covering. */
  displayWidth: number;
  displayHeight: number;
};

/** Payload renderer (widget) sends to ask the overlay to appear. */
export type OverlayShowRequest = {
  regions: TargetRegion[];
  imageWidth: number;
  imageHeight: number;
};

export type CaptureTimings = {
  grabMs: number;    // getDisplayMedia / cached stream lookup
  resizeMs: number;  // canvas drawImage
  encodeMs: number;  // toBlob + arrayBuffer
  totalMs: number;
};

export type ProviderTimings = {
  apiMs: number;    // network round trip + server-side inference
  totalMs: number;  // includes JSON extract + Zod parse
  ttftMs?: number;  // time to first streamed token (if the provider streamed)
  streamChunks?: number;        // number of delta events received
  streamDurationMs?: number;    // from first chunk to last
  streamCharCount?: number;     // total chars streamed (for rate calc)
};

export type CaptureResult = {
  /** Raw image bytes — avoid base64 over IPC. Main encodes to whatever each provider needs. */
  imageBytes: Uint8Array;
  /** MIME type for the bytes, e.g. 'image/jpeg'. */
  imageMimeType: string;
  width: number;
  height: number;
  timings: CaptureTimings;
};

export type SearchSource = {
  /** Absolute URL the model consulted. */
  url: string;
  /** Page title (or hostname fallback) — shown on hover. */
  title: string;
};

export type PromptResult = {
  response: ModelResponse;
  timings: ProviderTimings;
  /** Set if the model invoked a web-search tool while answering. */
  usedWebSearch?: boolean;
  /** Distinct URLs the model fetched while answering — surfaced as favicon chips. */
  sources?: SearchSource[];
  /** Token usage summed across all API round-trips this prompt
   *  triggered (single call for non-search; multiple iterations for
   *  tool loops). Optional — older providers or errored runs may
   *  return a result without usage. The renderer threads this into
   *  the conversation turn so Ask logs can show cost. */
  usage?: import('./schemas').TokenUsage;
};

export interface OptixApi {
  capture: {
    screen: () => Promise<CaptureResult>;
    /** Opens the held MediaStream in the background so the next capture is fast. */
    prewarm: () => Promise<void>;
    /** Tears down the held MediaStream (e.g. when privacy mode is enabled). */
    reset: () => Promise<void>;
    /** Foreground window HWND as a decimal string (or null on failure).
     *  Used by the smart capture-reuse logic — if the HWND on the next
     *  submit matches the one stamped on the cached screenshot, we
     *  reuse the cached pixels instead of re-capturing. */
    foregroundHwnd: () => Promise<string | null>;
  };
  provider: {
    prompt: (req: PromptRequest) => Promise<PromptResult>;
    cancel: () => Promise<void>;
    testKey: (providerId: ProviderId) => Promise<{ ok: true } | { ok: false; error: string }>;
    /** Subscribe to streaming token deltas. Returns an unsubscribe fn. */
    onChunk: (cb: (delta: string) => void) => () => void;
    /** Subscribe to search-start notifications (web search invoked). */
    onSearchStart: (cb: (query: string) => void) => () => void;
  };
  settings: {
    get: () => Promise<Settings>;
    set: (patch: Partial<Settings>) => Promise<Settings>;
    setApiKey: (providerId: ProviderId, apiKey: string) => Promise<void>;
    hasApiKey: (providerId: ProviderId) => Promise<boolean>;
    deleteApiKey: (providerId: ProviderId) => Promise<void>;
    onChange: (cb: (settings: Settings) => void) => () => void;
  };
  history: {
    list: () => Promise<HistoryEntry[]>;
    clear: () => Promise<void>;
  };
  widget: {
    hide: () => Promise<void>;
    /** Toggle whether the widget can receive keyboard focus. */
    setFocusable: (focusable: boolean) => Promise<void>;
    /** Capture the current foreground window and grant keyboard focus to
     *  the widget so the user can type. Use for brief text-input moments
     *  during a Computer Use loop. */
    beginTextInput: () => Promise<void>;
    /** Reverse `beginTextInput`: drop widget focus and restore the
     *  previously-captured foreground window. */
    endTextInput: () => Promise<void>;
    /** Compact mode: shrink the widget to header-only or restore. */
    setCompact: (compact: boolean) => Promise<void>;
    /** Open a native folder picker; on confirm, save the chosen path to
     *  settings as the agent workspace. Returns the path (or null if
     *  cancelled and nothing was previously set). */
    chooseWorkspaceFolder: () => Promise<string | null>;
    /** Open a native image picker (multi-select). Returns the chosen
     *  images plus any per-file rejection reasons (oversized, wrong
     *  format) so the UI can surface them. Empty array on cancel. */
    pickImages: () => Promise<
      | []
      | {
          images: Array<{ filename: string; mimeType: string; bytes: Uint8Array }>;
          errors: string[];
        }
    >;
  };
  overlay: {
    /** Show the overlay with the given regions. Called from the widget renderer. */
    show: (req: OverlayShowRequest) => Promise<void>;
    /** Hide the overlay. */
    hide: () => Promise<void>;
    /** Subscribe to render payloads. Used by the overlay renderer only. */
    onRender: (cb: (payload: OverlayRenderPayload) => void) => () => void;
  };
  action: {
    /** Execute one approved action on the OS. Returns success / error result. */
    execute: (req: ActionExecuteRequest) => Promise<ActionExecuteResult>;
  };
  computer: {
    /** Begin a Computer Use loop with an initial prompt + screenshot. */
    start: (req: ComputerLoopStartRequest) => Promise<ComputerLoopTurn>;
    /** Feed back tool_results, get next turn (or done). */
    continue: (req: ComputerLoopContinueRequest) => Promise<ComputerLoopTurn>;
    /** Continue a paused conversation by appending a brand-new user
     *  message. Used in conversationMode for follow-up submits — agent
     *  retains full memory of what it just did. */
    appendUserMessage: (req: ComputerLoopAppendRequest) => Promise<ComputerLoopTurn>;
    /** Tear down a paused loop's adapter state. Called when the
     *  renderer-side conversation resets (new chat, mode toggle, etc).
     *  `outcome` distinguishes "user explicitly wrapped up" ('done') vs
     *  "implicit teardown" ('abandoned'). Defaults to 'done' for
     *  backwards compatibility. */
    end: (loopId: string, outcome?: 'done' | 'abandoned') => Promise<void>;
    /** Abort an in-flight loop. */
    abort: (loopId: string) => Promise<void>;
    /** Run a single computer-tool action via the OS executor. */
    execute: (req: ComputerExecuteRequest) => Promise<ComputerExecuteResult>;
    /** Run a single file-system action via the file executor. */
    executeFile: (req: { action: FileToolAction }) => Promise<FileExecuteResult>;
    /** Run a single label-based action: resolve via UIA, then robotjs. */
    executeLabel: (req: { action: LabelToolAction }) => Promise<ComputerExecuteResult>;
    /** Execute a shell command via the OS shell. Captures stdout/stderr,
     *  enforces a timeout, truncates large outputs from the head. */
    executeShell: (req: { action: ShellToolAction }) => Promise<ShellExecuteResult>;
    /** Resolve the effective cwd for a shell command + report whether it
     *  sits inside the current workspace. Drives gating decisions in the
     *  renderer's runLoop. */
    resolveShellCwd: (cwd?: string) => Promise<{ cwd: string; inScope: boolean }>;
    /** Capture UIA element under a point (if `point` supplied) + the
     *  foreground window title. Used by the Automate tab's routine
     *  recorder to enrich each action with semantic context. */
    queryRecordingContext: (
      point?: [number, number],
    ) => Promise<{
      windowTitle: string | null;
      targetElementName?: string;
      targetElementType?: string;
    }>;
    /** Check whether a path is inside the user's configured workspace. */
    isPathInScope: (path: string) => Promise<boolean>;
  };
  audit: {
    /** List all audit log summaries newest-first. */
    list: () => Promise<AuditLogSummary[]>;
    /** Read a single audit log by filename. */
    read: (filename: string) => Promise<AuditLog | null>;
    /** Save an audit log to disk in a chosen format. */
    export: (
      filename: string,
      format: 'json' | 'markdown' | 'text',
    ) => Promise<{ ok: true; path: string } | { ok: false; error?: string }>;
    /** Delete an audit log by filename. */
    delete: (filename: string) => Promise<boolean>;
  };
  plan: {
    /** Read the saved plan, or null if none. */
    read: () => Promise<StoredPlan | null>;
    /** Overwrite the saved plan with new content. */
    save: (req: {
      content: string;
      rationale?: string;
      loopId?: string;
    }) => Promise<StoredPlan>;
    /** Drop the saved plan. */
    clear: () => Promise<void>;
    /** Subscribe to plan-changed broadcasts (save / clear). Returns an
     *  unsubscribe function. */
    onChanged: (cb: (plan: StoredPlan | null) => void) => () => void;
  };
  routines: {
    /** List all routines newest-first, summary form. */
    list: () => Promise<RoutineSummary[]>;
    /** Read a single routine including its full action list. */
    read: (id: string) => Promise<Routine | null>;
    /** Read a routine by its sequential OA number (the human-friendly
     *  identifier used in `/OA-{n}` token references). */
    readByOaNumber: (n: number) => Promise<Routine | null>;
    /** Persist a freshly-recorded run as a new routine. Returns the
     *  saved routine (with the assigned id), or null on failure. */
    save: (req: {
      originalPrompt: string;
      actions: RecordedAction[];
      providerId: string;
      modelId: string;
      name?: string;
      turnCount?: number;
      estimatedCostUsd?: number;
      imageWidth?: number;
      imageHeight?: number;
    }) => Promise<Routine | null>;
    /** Edit an existing routine. Only the supplied fields are changed. */
    update: (req: {
      id: string;
      name?: string;
      originalPrompt?: string;
      actions?: RecordedAction[];
    }) => Promise<Routine | null>;
    /** Drop a routine + its file. */
    delete: (id: string) => Promise<boolean>;
    /** Subscribe to routine-changed broadcasts (save / update / delete).
     *  No payload — listeners refresh by re-listing. */
    onChanged: (cb: () => void) => () => void;
  };
  chatHistory: {
    /** Start a new conversation; returns the conversation metadata
     *  (id, started timestamp, etc.) for renderer-side state. */
    start: (req: { providerId: ProviderId; modelId: string }) => Promise<Conversation>;
    /** Append a finalized turn — main writes attachment + capture bytes
     *  to disk and returns the persisted ConversationTurn (with relative
     *  paths in place of bytes). */
    appendTurn: (req: ChatHistoryAppendTurnRequest) => Promise<ConversationTurn | null>;
    /** List all persisted conversations newest-first. */
    list: () => Promise<ConversationSummary[]>;
    /** Read a single conversation including its turn list. */
    read: (id: string) => Promise<Conversation | null>;
    /** Delete a conversation + its image directory. */
    delete: (id: string) => Promise<boolean>;
    /** Read one attachment's bytes by relative path within the
     *  conversation's image dir (e.g. "images/abc.png"). */
    readAttachment: (
      convId: string,
      path: string,
    ) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  };
}

export type ChatHistoryAppendTurnRequest = {
  convId: string;
  mode: Mode;
  prompt: string;
  attachments: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>;
  capture?: { bytes: Uint8Array; mimeType: string; width: number; height: number };
  response?: ModelResponse;
  loopId?: string;
  finalText?: string;
  errorMessage?: string;
  /** Token usage for this turn (Ask mode). Drives Ask-log cost
   *  estimation in the viewer. Optional — Access turns currently
   *  store their token data in the audit log instead. */
  usage?: import('./schemas').TokenUsage;
  /** Provider/model that produced this turn — recorded per-turn so
   *  multi-provider conversations price each turn correctly. */
  providerId?: ProviderId;
  modelId?: string;
};

export type ConversationSummary = {
  id: string;
  startedAt: string;
  endedAt?: string;
  title?: string;
  providerId: ProviderId;
  modelId: string;
  turnCount: number;
  /** Number of turns where a screenshot was captured. */
  screenshotCount: number;
  /** Estimated USD cost summed across the conversation's Ask turns
   *  using the per-turn `usage` blocks and the shared pricing table.
   *  Undefined when no turn has usage data (legacy conversations). */
  estimatedCostUsd?: number;
};

// Mirror of the audit module's types so renderer can use them without
// importing from main code.
export type AuditLogSummary = {
  filename: string;
  loopId: string;
  startedAt: string;
  endedAt?: string;
  prompt: string;
  outcome?: 'done' | 'aborted' | 'capped' | 'error' | 'abandoned';
  modelId: string;
  providerId: ProviderId;
  /** Number of user messages in the run. >1 ⇒ multi-message
   *  conversation-mode session. */
  messageCount: number;
  turnCount: number;
  actionCount: number;
  estimatedCostUsd?: number;
};

export type AuditActionRecord = {
  toolUseId: string;
  action: import('./schemas').AgentAction;
  description: string;
  ok: boolean;
  errorText?: string;
  resultKind: 'screenshot' | 'text' | 'error' | 'none';
  /** Renderer-measured wall-clock duration in milliseconds. Older
   *  audit JSON has 0 here (placeholder); new runs measure actual
   *  per-action latency including settle + post-action capture. */
  durationMs: number;
};

export type AuditTurnRecord = {
  turnIndex: number;
  startedAt: string;
  apiMs: number;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  modelText?: string;
  actions: AuditActionRecord[];
};

/** One user-submitted message inside an audit log. With option-A
 *  conversation continuity, a single loop can span many of these —
 *  one per user submit. The viewer groups turns under their owning
 *  message via `firstTurnIndex`. */
export type AuditUserMessage = {
  index: number;
  prompt: string;
  startedAt: string;
  firstTurnIndex: number;
};

export type AuditLog = {
  loopId: string;
  startedAt: string;
  endedAt?: string;
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
  finalText?: string;
  outcome?: 'done' | 'aborted' | 'capped' | 'error' | 'abandoned';
  errorMessage?: string;
  estimatedCostUsd?: number;
};

export type ComputerExecuteRequest = {
  action: ComputerToolAction;
  imageWidth?: number;
  imageHeight?: number;
  /** Non-Anthropic providers (Kimi, Gemini) ask the executor to snap
   *  click coords to the nearest interactive UIA element. Same idea as
   *  Ask-mode overlay snap, applied to the click action. */
  snapToUia?: boolean;
};
export type ComputerExecuteResult =
  | { ok: true; text?: string; noScreenshot?: boolean }
  | { ok: false; error: string };

export type FileExecuteResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export type ShellExecuteResult =
  | { ok: true; output: string; exitCode: number }
  | { ok: false; error: string; output?: string; exitCode?: number };

declare global {
  interface Window {
    optix: OptixApi;
  }
}
