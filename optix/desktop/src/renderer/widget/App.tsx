import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentAction,
  AgentToolUse,
  ComputerLoopTurn,
  ComputerToolAction,
  FileToolAction,
  LabelToolAction,
  MetaToolAction,
  Mode,
  ModelResponse,
  PlanToolAction,
  ProviderId,
  RecordedAction,
  Routine,
  RoutineSummary,
  Settings,
  ShellToolAction,
  StoredPlan,
  TargetRegion,
  TokenUsage,
} from '../../shared/schemas';
import type { CaptureTimings, ProviderTimings, SearchSource } from '../../shared/api';
import { PROVIDER_LABELS } from '../../shared/models';
import { costForTurns } from '../../shared/pricing';
import { PromptInput, type PromptInputHandle } from './components/PromptInput';
import { ModeSwitch } from './components/ModeSwitch';
import { ResponseCard } from './components/ResponseCard';
import { StopButton } from './components/StopButton';
import { WidgetHeader } from './components/WidgetHeader';
import { SettingsPanel } from './components/SettingsPanel';
import { ElapsedSeconds } from './components/ElapsedSeconds';
import { useRotatingMessage } from './components/StreamingPlaceholder';
import { ApprovalGate } from './components/ApprovalGate';
import {
  ComputerLoopProgress,
  type LoopActionItem,
  type LoopItem,
} from './components/ComputerLoopProgress';
import { WorkspaceFolderControl } from './components/WorkspaceFolderControl';
import {
  NewChatIcon,
  PlanListIcon,
  RecordIcon,
  SearchIcon,
} from './components/Icons';
import { PlanView } from './components/PlanView';
import { DocsViewer } from './components/DocsViewer';
import { SlashMenu } from './components/SlashMenu';
import { AttachmentTray, type StagedAttachment } from './components/AttachmentTray';
import { UserBubble } from './components/UserBubble';

export type TimingBreakdown = {
  capture?: CaptureTimings;
  provider?: ProviderTimings;
};

/**
 * Pulls the currently-accumulated `"answer": "..."` text out of a partial
 * JSON stream. The stream contains the model's full structured response; we
 * only want the answer prose for live display. The regex handles the half-
 * formed closing quote (no `"` yet) and JSON escapes. Returns the raw buffer
 * as a fallback if no answer field has started yet.
 */
function extractAnswer(buffer: string): string {
  const match = buffer.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/);
  // The regex has one capture group, so when `match` exists `match[1]`
  // is defined — but `noUncheckedIndexedAccess` widens it to undefined.
  // Defaulting to '' keeps the chain safe without disabling the rule.
  const captured = match?.[1] ?? '';
  if (!captured) return '';
  return captured
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    // Strip Anthropic native-search inline citation wrappers
    // (<cite index="2-2">…</cite>) so they don't leak into the live display.
    .replace(/<\/?cite[^>]*>/g, '');
}

/** Extract the intent string the same way as answer — first field in the JSON. */
function extractIntent(buffer: string): string {
  const match = buffer.match(/"intent"\s*:\s*"((?:[^"\\]|\\.)*)/);
  const captured = match?.[1] ?? '';
  if (!captured) return '';
  return captured
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

/** Extract confidence number once it's been emitted (or null if not yet). */
function extractConfidence(buffer: string): number | null {
  const match = buffer.match(/"confidence"\s*:\s*(\d+(?:\.\d+)?)/);
  const captured = match?.[1];
  if (!captured) return null;
  const v = Number(captured);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

/**
 * Extract step `text` strings as the JSON streams in. Once `"steps": [` has
 * appeared we walk the rest of the buffer for `"text": "..."` matches —
 * each one is one step. The last step's text may still be partial (no
 * closing quote) — that's fine, we render it live.
 */
function extractSteps(buffer: string): string[] {
  const stepsStart = buffer.search(/"steps"\s*:\s*\[/);
  if (stepsStart === -1) return [];
  const after = buffer.slice(stepsStart);
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(after)) !== null) {
    const captured = m[1] ?? '';
    out.push(
      captured
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/<\/?cite[^>]*>/g, ''),
    );
  }
  return out;
}

/**
 * Extract warning strings from the streaming JSON. Once `"warnings": [` has
 * appeared we walk the array body for string literals until the closing
 * `]`. Same caveat as extractSteps: a warning string containing a literal
 * `]` would truncate the search early — acceptable given how rare that is
 * in practice for safety/usage warnings.
 */
function extractWarnings(buffer: string): string[] {
  const startMatch = buffer.match(/"warnings"\s*:\s*\[/);
  if (!startMatch || startMatch.index === undefined) return [];
  const after = buffer.slice(startMatch.index + startMatch[0].length);
  const endIdx = after.indexOf(']');
  const region = endIdx === -1 ? after : after.slice(0, endIdx);
  const re = /"((?:[^"\\]|\\.)*)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    const captured = m[1] ?? '';
    out.push(
      captured
        .replace(/\\n/g, ' ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/<\/?cite[^>]*>/g, ''),
    );
  }
  return out;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'capturing' }
  | { kind: 'thinking' }
  | {
      kind: 'awaiting-approval';
      prompt: string;
      imageBytes: Uint8Array;
      imageMimeType: string;
      imageWidth: number;
      imageHeight: number;
      imageAttachments: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>;
    }
  | {
      kind: 'looping';
      loopId: string;
      items: LoopItem[];
      turnIndex: number;
      imageWidth: number;
      imageHeight: number;
      /** When set, the loop is paused awaiting user approval for this
       *  specific action (each-action mode). */
      pendingActionId?: string;
      /** When set, the agent has called the `ask_user` meta tool and the
       *  loop is paused on user input. The renderer shows ChoicePrompt
       *  inline; the user's selection resolves a pending promise that
       *  runLoop awaits. */
      pendingAsk?: { toolUseId: string; action: MetaToolAction };
      /** When set, the agent has proposed a plan via the `plan` tool
       *  and the loop is paused for the user to approve / deny / send
       *  feedback. The renderer shows a PlanApprovalGate inline. */
      pendingPlan?: { toolUseId: string; action: PlanToolAction };
    }
  | {
      kind: 'loop-done';
      items: LoopItem[];
      turnIndex: number;
      capped: boolean;
    }
  | {
      kind: 'done';
      response: ModelResponse;
      timings: TimingBreakdown;
      usedWebSearch?: boolean;
      sources?: SearchSource[];
      imageWidth?: number;
      imageHeight?: number;
    }
  | { kind: 'error'; message: string };

/**
 * Snapshot of a finalized turn for the conversation thread. We freeze just
 * the display data we need (no live streams, no abort refs) so the past
 * turns render statically while the current `Status` drives the active
 * card. Each terminal Status kind has a corresponding PastTurn variant.
 */
type PastTurn = {
  id: string;
  prompt: string;
  mode: Mode;
  /** Brief preview info for user-attached uploads (filename only — bytes
   *  aren't needed once the turn has been sent). */
  attachmentNames: string[];
} & (
  | {
      kind: 'done';
      response: ModelResponse;
      timings: TimingBreakdown;
      usedWebSearch?: boolean;
      sources?: SearchSource[];
      imageWidth?: number;
      imageHeight?: number;
    }
  | {
      kind: 'loop-done';
      items: LoopItem[];
      turnIndex: number;
      capped: boolean;
    }
  | { kind: 'error'; message: string }
);

/**
 * Post-action settle delay before we capture the next screenshot. Tuned
 * per action kind from the previous blanket 400ms — most clicks settle in
 * under 200ms; only typing / drags / Enter-keys need longer because IMEs
 * commit and dialogs open asynchronously.
 */
function settleDelayFor(action: ComputerToolAction): number {
  switch (action.action) {
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
      // A click that opens a menu or dialog usually paints within ~150ms.
      // Pad to 180ms for safety.
      return 180;
    case 'type':
      // typeString is char-by-char with internal pauses; once the LAST
      // char is sent, IME commit + final repaint takes ~250ms.
      return 280;
    case 'key': {
      // Modifier-only or non-action keys settle fast. Enter/Return-like
      // keys often launch apps or submit forms — give them more time.
      const t = action.text.toLowerCase();
      if (t.endsWith('return') || t.endsWith('enter')) return 350;
      return 180;
    }
    case 'hold_key':
      return 200;
    case 'left_click_drag':
      return 250;
    case 'scroll':
      return 200;
    case 'mouse_move':
    case 'left_mouse_down':
    case 'left_mouse_up':
    case 'cursor_position':
      // Pure cursor work — no UI state change to wait for.
      return 80;
    case 'wait':
      // The action ITSELF was the wait; no extra settle needed.
      return 0;
    case 'screenshot':
      return 0;
    default:
      return 200;
  }
}

/** Short, human-readable description of one agent action (computer or
 *  file). Mirrors the main-side describe helpers so the live UI can render
 *  immediately without a round-trip. */
function describeComputerActionLocal(a: ComputerToolAction): string {
  switch (a.action) {
    case 'screenshot': return 'Take screenshot';
    case 'wait': return `Wait ${a.duration}s`;
    case 'cursor_position': return 'Read cursor position';
    case 'mouse_move': return `Move to (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_mouse_down': return `Mouse down at (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_mouse_up': return `Mouse up at (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_click': return `Click (${a.coordinate[0]}, ${a.coordinate[1]})${a.text ? ' +' + a.text : ''}`;
    case 'right_click': return `Right-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'middle_click': return `Middle-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'double_click': return `Double-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'triple_click': return `Triple-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_click_drag':
      return `Drag (${a.start_coordinate[0]},${a.start_coordinate[1]}) → (${a.coordinate[0]},${a.coordinate[1]})`;
    case 'type': {
      const preview = a.text.length > 40 ? a.text.slice(0, 37) + '…' : a.text;
      return `Type "${preview}"`;
    }
    case 'key': return `Press ${a.text}`;
    case 'hold_key': return `Hold ${a.text} ${a.duration}s`;
    case 'scroll': return `Scroll ${a.scroll_direction} ${a.scroll_amount}`;
  }
}

function describeFileActionLocal(a: FileToolAction): string {
  switch (a.action) {
    case 'list_directory': return `List ${a.path}`;
    case 'read_file': return `Read ${a.path}`;
    case 'search_files': return `Search ${a.root} for "${a.pattern}"`;
    case 'write_file': {
      const len = new TextEncoder().encode(a.content).length;
      return `Write ${len}b to ${a.path}`;
    }
    case 'create_directory': return `Create directory ${a.path}`;
  }
}

function describeLabelActionLocal(a: LabelToolAction): string {
  switch (a.action) {
    case 'click_label': return `Click "${a.label}"`;
    case 'scroll_label':
      return `Scroll ${a.direction} ${a.amount} on "${a.label}"`;
    case 'type_into_label': {
      const preview = a.text.length > 30 ? a.text.slice(0, 27) + '…' : a.text;
      return `Type "${preview}" into "${a.label}"`;
    }
  }
}

function describeAction(a: AgentAction): string {
  if (a.tool === 'computer') return describeComputerActionLocal(a.data);
  if (a.tool === 'file') return describeFileActionLocal(a.data);
  if (a.tool === 'label') return describeLabelActionLocal(a.data);
  if (a.tool === 'plan') {
    const head =
      a.data.content.split('\n').find((l) => l.trim().length > 0) ?? '';
    const trimmed = head.length > 60 ? head.slice(0, 57) + '…' : head;
    return trimmed ? `Proposed plan: ${trimmed}` : 'Proposed plan';
  }
  if (a.tool === 'shell') {
    const cmd =
      a.data.command.length > 80 ? a.data.command.slice(0, 77) + '…' : a.data.command;
    const cwdSuffix = a.data.cwd ? ` (cwd: ${a.data.cwd})` : '';
    return `Run: ${cmd}${cwdSuffix}`;
  }
  // meta tool — only `ask_user` for now.
  return `Ask: ${a.data.question}`;
}

function actionKindOf(
  a: AgentAction,
):
  | ComputerToolAction['action']
  | FileToolAction['action']
  | LabelToolAction['action']
  | MetaToolAction['action']
  | PlanToolAction['action']
  | ShellToolAction['action'] {
  return a.data.action;
}

/** Format a recorded action into a hint line for replay. Includes
 *  the UIA element name + window title when available so the agent
 *  can match by semantics rather than blind coordinates. */
function formatRecordedAction(a: RecordedAction, idx: number): string {
  const parts: string[] = [a.description];
  if (a.targetElementName) {
    const typeSuffix = a.targetElementType ? ` (${a.targetElementType})` : '';
    parts.push(`→ targeted "${a.targetElementName}"${typeSuffix}`);
  }
  if (a.windowTitle) {
    parts.push(`in window "${a.windowTitle}"`);
  }
  const head = `${idx + 1}. ${parts.join(' ')}`;
  // The agent's narration from the original run, indented under the
  // step. Helps the replay model see what reasoning preceded the
  // action — often more useful than the action description alone.
  if (a.modelText) {
    return `${head}\n   reasoning: ${a.modelText.replace(/\s+/g, ' ').trim()}`;
  }
  return head;
}

/** Range of an active `/query` token at the cursor. `start` is the
 *  index of the `/` itself, `end` is the cursor position. Returned
 *  by `findActiveSlashToken`; consumed by the slash menu's pick +
 *  Escape handlers to surgically replace just that range. */
type ActiveSlashToken = { start: number; end: number; query: string };

/** Detect an active `/word` token at the cursor. Returns null when
 *  the cursor isn't inside one. Rules:
 *   • `/` must be at the start of the value or immediately after a
 *     whitespace character — otherwise paths like `a/b` would open
 *     the menu unexpectedly.
 *   • Everything between `/` and the cursor must be word chars
 *     (alphanumeric, dash, underscore) — a space closes the token.
 *   • The match anchors at the cursor, so editing earlier in the
 *     prompt doesn't keep the menu stuck open. */
function findActiveSlashToken(
  value: string,
  cursor: number,
): ActiveSlashToken | null {
  const before = value.slice(0, cursor);
  const m = before.match(/(^|\s)\/([a-zA-Z0-9_-]*)$/);
  if (!m) return null;
  const lead = m[1] ?? '';
  const query = m[2] ?? '';
  const start = before.length - 1 - query.length; // index of '/'
  // Sanity: confirm the char at `start` is actually a slash and the
  // preceding context matches the lead we captured.
  if (value[start] !== '/') return null;
  if (start > 0 && lead.length === 0) return null;
  return { start, end: cursor, query };
}

/** Build a hint section for one routine — used by the token-based
 *  expansion to append context for each `/OA-{n}` reference in the
 *  prompt. Same shape as `buildReplayPrompt`'s body but per-routine
 *  so multiple routines can stack. */
function buildRoutineHintBlock(routine: Routine): string {
  const oaTag =
    typeof routine.oaNumber === 'number' ? `OA-${routine.oaNumber}` : routine.id.slice(0, 8);
  const steps = routine.actions.map(formatRecordedAction).join('\n');
  return [
    `Routine ${oaTag} ("${routine.name}") was recorded ${new Date(routine.createdAt).toLocaleString()} from this prompt: "${routine.originalPrompt}".`,
    'Its successful actions, in order:',
    steps,
  ].join('\n');
}

/** Resolve `/OA-{n}` tokens in the user's prompt by fetching each
 *  referenced routine and appending one hint block per routine. The
 *  token itself stays in the user-facing line (with the routine's
 *  name added in parentheses for readability) so the model can tell
 *  which references map to which hint blocks below.
 *
 *  Tokens that don't resolve (deleted routine, typo'd number) are
 *  left untouched — the model can flag them in its reply. */
async function expandRoutineTokens(prompt: string): Promise<string> {
  const re = /\/OA-(\d+)/g;
  const matches = [...prompt.matchAll(re)];
  if (matches.length === 0) return prompt;
  const numbers = Array.from(new Set(matches.map((m) => Number(m[1]))));
  const resolved = await Promise.all(
    numbers.map((n) => window.optix.routines.readByOaNumber(n).catch(() => null)),
  );
  const byNumber = new Map<number, Routine>();
  for (let i = 0; i < numbers.length; i++) {
    const r = resolved[i];
    if (r) byNumber.set(numbers[i] as number, r);
  }
  if (byNumber.size === 0) return prompt;
  const annotated = prompt.replace(re, (full, numStr: string) => {
    const r = byNumber.get(Number(numStr));
    return r ? `${full} ("${r.name}")` : full;
  });
  const hintBlocks = Array.from(byNumber.values()).map(buildRoutineHintBlock);
  return [
    annotated.trim(),
    '',
    '---',
    ...hintBlocks,
    '',
    'Reproduce each referenced routine\'s steps in the order the user asked. Prefer matching by element name / window title (the semantic anchors) over the literal coordinates — the screen layout may have shifted since the recording. Adapt where current state genuinely differs (window moved, dialog already closed, file already exists). If you must deviate substantially, briefly say why.',
  ].join('\n');
}

/** Hint-based replay prompt — the agent gets the user's task plus a
 *  numbered list of actions that worked previously, each enriched
 *  with the UIA element name + window title that was under the
 *  click + the model's own reasoning trail. Adapt-but-follow framing
 *  keeps it from blindly re-executing when the screen has shifted. */
function buildReplayPrompt(userPrompt: string, routine: Routine): string {
  const steps = routine.actions.map(formatRecordedAction).join('\n');
  return [
    userPrompt.trim(),
    '',
    '---',
    `(Replaying saved routine "${routine.name}" — recorded ${new Date(routine.createdAt).toLocaleString()}.)`,
    'A previous successful run completed these actions in order:',
    steps,
    '',
    'Reproduce these steps. Prefer matching by element name / window title (the semantic anchors) over the literal coordinates — the screen layout may have shifted since the recording. Adapt where current state genuinely differs (window moved, dialog already closed, file already exists). If you must deviate substantially, briefly say why.',
  ].join('\n');
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<Mode>('guide');
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [showSettings, setShowSettings] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [streamBuffer, setStreamBuffer] = useState('');
  const [overlayShowing, setOverlayShowing] = useState(false);
  const [isCompact, setIsCompact] = useState(false);
  // Saved plan + view state. The plan button in the controls row is
  // visible always but only enabled when a plan has been saved (the
  // file persists across sessions, so the button can light up on
  // launch). Clicking it opens an inline view that lets the user
  // read or clear the plan.
  const [savedPlan, setSavedPlan] = useState<StoredPlan | null>(null);
  const [showPlanView, setShowPlanView] = useState(false);

  // Automate-mode recording. The Record toggle is per-run: when ON,
  // the next Automate run captures its actions + agent narration and
  // saves them as a routine on success. Resets to OFF after a save
  // so a single click → single recording.
  const [isRecording, setIsRecording] = useState(false);
  // In-flight recording state, kept on a ref so the runLoop callback
  // (memoised with `[]` deps) sees the latest recording without
  // closure staleness. Set on submit when isRecording was true; the
  // loop's per-action branches push to `actions`, and turn.done
  // flushes the result via the routines IPC.
  const recordingRef = useRef<{
    active: boolean;
    originalPrompt: string;
    actions: RecordedAction[];
    /** Most recent agent narration, attached to the next action so
     *  the routine preserves the model's reasoning trail per step. */
    pendingModelText?: string;
    /** Number of agent turns observed so far. Increments on each
     *  non-done turn that arrives during recording. Persisted on
     *  save so the routine list can show "turns × actions" the same
     *  way Access Logs does. */
    turnCount: number;
    /** Per-turn usage records — summed via `costForTurns` on save to
     *  produce the routine's `estimatedCostUsd`. */
    usages: Array<{ modelId: string; usage: TokenUsage }>;
    /** Initial screenshot dimensions captured at submit time —
     *  persisted so the detail meta card can show resolution. */
    imageWidth?: number;
    imageHeight?: number;
  } | null>(null);
  // Active replay context — set when the user runs a routine via the
  // slash menu. Surfaces in submit() to attach the hint block to the
  // user's prompt before sending it to the agent. Cleared after submit.
  const replayingRoutineRef = useRef<Routine | null>(null);
  // Slash-menu state — opens when the prompt has an active `/word`
  // token at the cursor in Automate mode. The selected index is
  // owned here so keyboard navigation (↑/↓/Enter/Escape) intercepted
  // in the textarea can drive it without round-tripping through the
  // menu component.
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [routineSummaries, setRoutineSummaries] = useState<RoutineSummary[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  /** Cursor position inside the prompt textarea, reported by
   *  `PromptInput` on every selection change. Drives the slash-token
   *  detection so the menu can open mid-sentence. */
  const [promptCursor, setPromptCursor] = useState(0);
  /** Imperative handle on the prompt input — used to surgically
   *  replace the active `/query` substring with `/OA-{n}` when the
   *  user picks a routine, then refocus the textarea at the new
   *  cursor position. */
  const promptInputRef = useRef<PromptInputHandle>(null);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Conversation thread: completed turns rendered above the active card
  // when conversationMode is on. Stays empty for single-shot mode so the
  // existing "one card replaces the previous" UX is preserved.
  const [pastTurns, setPastTurns] = useState<PastTurn[]>([]);
  // ID of the persisted conversation backing the current thread. Created
  // lazily on the first turn-finalize when conversationMode is on (so
  // toggling the mode without sending anything doesn't litter the disk
  // with empty conversations). Resets when the user submits a prompt
  // while conversationMode is OFF (which clears the thread).
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Smart capture-reuse cache. After a fresh capture we stamp the bytes
  // with the foreground HWND and a timestamp; the next submit checks
  // both — if the user is still in the same window and the cache is
  // recent, we reuse the pixels instead of re-capturing. The user can
  // override with the explicit re-capture button.
  type CaptureCache = {
    bytes: Uint8Array;
    mimeType: string;
    width: number;
    height: number;
    hwnd: string | null;
    timestamp: number;
  };
  const captureCacheRef = useRef<CaptureCache | null>(null);
  // Body scroll container ref — used to auto-scroll to the latest turn
  // when a new message is sent or a turn finalizes. Without this the
  // older content stays at the top of the viewport and the new turn
  // appears below the fold.
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  // True when the body has more content below the visible area —
  // drives the bottom-fade pseudo-element. We only show the fade when
  // there's actually content being clipped (otherwise the fade reads
  // as random gradient over empty space). Re-evaluated on scroll,
  // resize, and whenever new content is appended.
  const [showBodyFade, setShowBodyFade] = useState(false);
  // Mirror of whether the most recent submit reused the cached
  // screenshot, so we can show a tiny "reused" badge under the user
  // bubble. Reset on every fresh capture.
  const [reusedCapture, setReusedCapture] = useState<boolean>(false);
  // Max age for the capture cache. Beyond this we always recapture even
  // if HWND matches — the user's screen state has likely drifted.
  const CAPTURE_CACHE_MAX_AGE_MS = 30_000;
  // The prompt + attachments that drive whichever turn is currently active
  // (capturing → thinking/looping → done). Rendered as a user bubble above
  // the active card so the user can see what they asked. Cleared when the
  // turn is finalized into pastTurns or when status returns to idle.
  const [activeTurnPrompt, setActiveTurnPrompt] = useState<string | null>(null);
  const [activeTurnAttachmentNames, setActiveTurnAttachmentNames] = useState<string[]>([]);
  const [activeTurnMode, setActiveTurnMode] = useState<Mode | null>(null);
  // Mid-loop user interrupt — text the user typed while the agent was
  // running. Drained at the next runLoop iteration's `continue()` call;
  // the adapter appends it to the next user message so the agent reads
  // it before the next turn. The ref holds the canonical pending text;
  // the state mirror is just for rendering the "queued" indicator.
  const pendingInterruptRef = useRef<string | null>(null);
  const [queuedInterrupt, setQueuedInterrupt] = useState<string | null>(null);
  // Bytes we need to persist when the turn finalizes. Held in a ref
  // because they're write-once / read-once and shouldn't trigger renders.
  // Cleared after every finalize.
  const activeTurnPersistRef = useRef<{
    attachments: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>;
    capture?: { bytes: Uint8Array; mimeType: string; width: number; height: number };
    /** Token usage reported by the provider — used by chat-history
     *  for Ask-mode cost tracking. Set after `provider.prompt`
     *  resolves, before finalize fires. */
    usage?: import('../../shared/schemas').TokenUsage;
    providerId?: ProviderId;
    modelId?: string;
  } | null>(null);

  // Object-URL hygiene: revoke each preview URL when the chip is removed
  // and on unmount, so we don't leak browser memory across many uploads.
  useEffect(() => {
    return () => {
      for (const a of attachments) URL.revokeObjectURL(a.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickImages = useCallback(async () => {
    setAttachError(null);
    const result = await window.optix.widget.pickImages();
    if (Array.isArray(result)) return; // cancelled
    if (result.errors.length > 0) {
      setAttachError(result.errors.join(' \u2022 '));
    }
    if (result.images.length === 0) return;
    const next: StagedAttachment[] = result.images.map((img) => ({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filename: img.filename,
      mimeType: img.mimeType,
      bytes: img.bytes,
      // The Blob constructor's BlobPart wants `Uint8Array<ArrayBuffer>` per
      // the DOM lib (ArrayBuffer-backed, not SharedArrayBuffer). All our
      // image bytes originate from `blob.arrayBuffer()` in preload, which
      // produces ArrayBuffer-backed views at runtime — the cast is safe.
      previewUrl: URL.createObjectURL(
        new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.mimeType }),
      ),
    }));
    setAttachments((prev) => [...prev, ...next]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
  }, []);

  /**
   * Snapshot the active turn (prompt + attachments + active terminal
   * status) into `pastTurns`, then clear active-turn UI state. Called
   * after a terminal Status kind when conversationMode is on. Single-shot
   * mode keeps the active card visible and never calls this.
   *
   * Also persists the turn to disk via chatHistory IPC. The first call
   * lazily starts a new conversation so empty conversations never get
   * written when the user toggles the mode without sending anything.
   */
  const finalizeActiveTurn = useCallback(
    (terminal: Extract<Status, { kind: 'done' | 'loop-done' | 'error' }>) => {
      if (activeTurnPrompt === null || activeTurnMode === null) return;
      const id = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const base = {
        id,
        prompt: activeTurnPrompt,
        mode: activeTurnMode,
        attachmentNames: activeTurnAttachmentNames,
      };
      let pt: PastTurn;
      if (terminal.kind === 'done') {
        pt = {
          ...base,
          kind: 'done',
          response: terminal.response,
          timings: terminal.timings,
          usedWebSearch: terminal.usedWebSearch,
          sources: terminal.sources,
          imageWidth: terminal.imageWidth,
          imageHeight: terminal.imageHeight,
        };
      } else if (terminal.kind === 'loop-done') {
        pt = {
          ...base,
          kind: 'loop-done',
          items: terminal.items,
          turnIndex: terminal.turnIndex,
          capped: terminal.capped,
        };
      } else {
        pt = { ...base, kind: 'error', message: terminal.message };
      }
      setPastTurns((prev) => [...prev, pt]);

      // Persist the turn to disk. We snapshot the persistence-ref bytes
      // up-front so concurrent state changes can't drop them mid-IPC.
      const persistRef = activeTurnPersistRef.current;
      const capturedPrompt = activeTurnPrompt;
      const capturedMode = activeTurnMode;
      void (async () => {
        try {
          const provider = settingsRef.current?.activeProviderId;
          const modelId = provider
            ? settingsRef.current?.modelByProvider[provider]
            : undefined;
          if (!provider || !modelId) return;
          let convId = conversationId;
          if (convId === null) {
            const conv = await window.optix.chatHistory.start({
              providerId: provider,
              modelId,
            });
            convId = conv.id;
            setConversationId(convId);
          }
          let finalText: string | undefined;
          if (terminal.kind === 'loop-done') {
            for (const it of terminal.items) {
              if (it.kind === 'message' && it.isFinal) {
                finalText = it.text;
                break;
              }
            }
          }
          await window.optix.chatHistory.appendTurn({
            convId,
            mode: capturedMode,
            prompt: capturedPrompt,
            attachments: persistRef?.attachments ?? [],
            capture: persistRef?.capture,
            response: terminal.kind === 'done' ? terminal.response : undefined,
            // We don't have a loopId in renderer state today (the audit
            // log links to it via the run, but the renderer's loop state
            // doesn't expose it after completion). Future improvement:
            // surface loopId in PastTurn so users can deep-link from
            // history → audit.
            finalText,
            errorMessage:
              terminal.kind === 'error' ? terminal.message : undefined,
            // Token usage — captured on the persist-ref when the
            // provider returned the response. Drives Ask-log cost.
            usage: persistRef?.usage,
            providerId: persistRef?.providerId,
            modelId: persistRef?.modelId,
          });
        } catch (err) {
          console.warn(
            '[optix] chatHistory.appendTurn failed:',
            err instanceof Error ? err.message : err,
          );
        }
      })();

      activeTurnPersistRef.current = null;
      setActiveTurnPrompt(null);
      setActiveTurnAttachmentNames([]);
      setActiveTurnMode(null);
      setStatus({ kind: 'idle' });
    },
    [activeTurnPrompt, activeTurnMode, activeTurnAttachmentNames, conversationId],
  );

  const toggleCompact = useCallback(() => {
    setIsCompact((prev) => {
      const next = !prev;
      void window.optix.widget.setCompact(next);
      return next;
    });
  }, []);

  // rAF-debounced streaming: chunk deltas append to a ref; a scheduled
  // animation frame flushes the accumulated text into React state at most
  // once per paint (~60Hz), avoiding a render per token.
  const streamBufferRef = useRef('');
  const streamDirtyRef = useRef(false);
  const streamRafRef = useRef<number | null>(null);

  const flushStreamBuffer = useCallback(() => {
    streamRafRef.current = null;
    if (!streamDirtyRef.current) return;
    streamDirtyRef.current = false;
    setStreamBuffer(streamBufferRef.current);
  }, []);

  const resetStreamBuffer = useCallback(() => {
    if (streamRafRef.current !== null) {
      cancelAnimationFrame(streamRafRef.current);
      streamRafRef.current = null;
    }
    streamBufferRef.current = '';
    streamDirtyRef.current = false;
    setStreamBuffer('');
  }, []);

  useEffect(() => {
    void window.optix.settings.get().then(setSettings);
    // On mount, ensure no stale overlay is visible — HMR or a hard reload of
    // the widget can lose track of an overlay that the main process is still
    // showing from before the reload.
    void window.optix.overlay.hide();
    return window.optix.settings.onChange(setSettings);
  }, []);

  // Load the persisted plan on mount + subscribe to plan-changed
  // broadcasts so saves from the runLoop's plan handler (and clears
  // from the plan view) propagate to the Plan button + the view.
  useEffect(() => {
    void window.optix.plan.read().then(setSavedPlan);
    return window.optix.plan.onChanged(setSavedPlan);
  }, []);

  // Routines list for the slash menu. Loaded on mount + refreshed on
  // every save/update/delete broadcast so the menu stays in sync.
  useEffect(() => {
    setRoutinesLoading(true);
    void window.optix.routines.list().then((items) => {
      setRoutineSummaries(items);
      setRoutinesLoading(false);
    });
    return window.optix.routines.onChanged(() => {
      void window.optix.routines.list().then(setRoutineSummaries);
    });
  }, []);

  // Accumulate streamed tokens from whichever provider call is in flight.
  // We clear the buffer each submit so it only contains the current response.
  useEffect(() => {
    return window.optix.provider.onChunk((delta) => {
      streamBufferRef.current += delta;
      streamDirtyRef.current = true;
      if (streamRafRef.current === null) {
        streamRafRef.current = requestAnimationFrame(flushStreamBuffer);
      }
    });
  }, [flushStreamBuffer]);

  // Cancel any pending rAF on unmount so we don't flush after teardown.
  useEffect(() => {
    return () => {
      if (streamRafRef.current !== null) {
        cancelAnimationFrame(streamRafRef.current);
        streamRafRef.current = null;
      }
    };
  }, []);

  // Open the held MediaStream in the background when the widget mounts (and
  // whenever privacy is turned back off). By the time the user clicks
  // capture, the stream is ready and the frame grab is ~30ms instead of 2s.
  useEffect(() => {
    if (!settings) return;
    if (settings.privacyPaused) {
      void window.optix.capture.reset();
      // When privacy is turned ON, drop the cached screenshot so a
      // future "ask without capture" prompt can't accidentally reuse
      // pixels the user thought were discarded.
      captureCacheRef.current = null;
      setReusedCapture(false);
    } else {
      void window.optix.capture.prewarm();
    }
  }, [settings?.privacyPaused]);

  // When conversationMode toggles OFF, tear down any paused Access loop —
  // option-A continuity only applies inside a conversation. Without this,
  // the main-side loop state would leak until the next single-shot
  // submit (which also clears it, but only if the user submits).
  useEffect(() => {
    if (settings?.conversationMode) return;
    if (!liveLoopIdRef.current) return;
    const stale = liveLoopIdRef.current;
    liveLoopIdRef.current = null;
    // Mode toggle off mid-conversation = implicit teardown; record as
    // 'abandoned' so the audit log shows the conversation wasn't
    // explicitly wrapped up by the user.
    void window.optix.computer.end(stale, 'abandoned').catch(() => {
      /* ignore */
    });
  }, [settings?.conversationMode]);

  const isBusy =
    status.kind === 'capturing' ||
    status.kind === 'thinking' ||
    status.kind === 'looping' ||
    status.kind === 'awaiting-approval';
  // Stop button shouldn't appear while we're waiting on the user to
  // approve — only during in-flight work.
  const isStoppable =
    status.kind === 'capturing' ||
    status.kind === 'thinking' ||
    status.kind === 'looping';
  // Rotating "Tickling the brain…" → "Releasing the response…" message used
  // as the button label during the thinking state. Resets on each new query.
  const rotatingMessage = useRotatingMessage(status.kind === 'thinking');

  // Regex over the full buffer is O(N) per call; memoizing avoids re-running
  // it on unrelated re-renders (was O(N²) across the response).
  const streamingAnswer = useMemo(() => extractAnswer(streamBuffer), [streamBuffer]);
  const streamingIntent = useMemo(() => extractIntent(streamBuffer), [streamBuffer]);
  const streamingConfidence = useMemo(
    () => extractConfidence(streamBuffer),
    [streamBuffer],
  );
  const streamingSteps = useMemo(() => extractSteps(streamBuffer), [streamBuffer]);
  const streamingWarnings = useMemo(() => extractWarnings(streamBuffer), [streamBuffer]);

  // The Computer Use loop runs as a chain of awaits; we need an abort flag
  // outside of React state so the running iteration can short-circuit.
  const loopAbortRef = useRef<{ loopId: string | null; aborted: boolean }>({
    loopId: null,
    aborted: false,
  });
  // Pause state for the running loop. Renderer-side only: when `paused`
  // is true, runLoop blocks on `resolveResume` at natural boundaries
  // (between turns, between actions) without cancelling any in-flight
  // API call or executor. The main process is unaware — adapter state
  // stays warm in memory and resumes seamlessly.
  const loopPauseRef = useRef<{
    paused: boolean;
    resolveResume: (() => void) | null;
  }>({ paused: false, resolveResume: null });
  const [isPaused, setIsPaused] = useState(false);
  // Pending resume timer. We update the UI to "unpaused" immediately on
  // click for instant visual feedback, but the *actual* loop unpark
  // fires after a short delay so a follow-up double-click can intercept
  // and cancel before any new agent actions run. Cleared by both stop()
  // and re-pause so a stale resume can't unpark a loop that was just
  // aborted or re-paused.
  const pendingResumeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const RESUME_DELAY_MS = 220;
  // Loop ID kept alive across submits when conversationMode is on. Set
  // when an Access loop reaches `done`; consumed on the next submit so
  // the new user message is appended to the same conversation (the
  // agent keeps memory of what it just did). Cleared on conversation
  // reset, mode toggle off, or explicit abort. When null, submit takes
  // the fresh-loop path (computer.start).
  const liveLoopIdRef = useRef<string | null>(null);
  // Mirror current settings into a ref so the empty-dep runLoop closure
  // can read FRESH values instead of the value at first-render. Without
  // this, `settings` inside runLoop is whatever it was when the callback
  // was first memoised — typically null, before settings load — and
  // checks like `provider === 'kimi'` always fail.
  const settingsRef = useRef<Settings | null>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  // Pending per-action approval — when set, the loop is awaiting a user
  // decision before executing the action. The resolver is called with one of:
  //   - approve: run the action as proposed
  //   - deny: skip the action and tell the model the user refused it
  //   - feedback: skip and pass the user's text back as model-readable
  //               correction (e.g. "click the second result instead")
  //   - abort: stop the whole loop
  type PerActionDecision =
    | { kind: 'approve' }
    | { kind: 'deny' }
    | { kind: 'feedback'; text: string }
    | { kind: 'abort' };
  const pendingApprovalRef = useRef<
    ((decision: PerActionDecision) => void) | null
  >(null);
  // When the agent calls the ask_user meta tool, runLoop sets this ref
  // before awaiting and the ChoicePrompt UI calls it on the user's pick.
  // The resolved string becomes the tool_result text on the next turn.
  const pendingChoiceRef = useRef<((value: string) => void) | null>(null);
  // When the agent calls the plan tool, runLoop sets this ref to the
  // resolver of a promise it awaits; PlanApprovalGate's button clicks
  // call it with the user's decision (approve / deny / feedback). The
  // runLoop then saves or discards the plan based on the decision and
  // ships the appropriate tool_result text back to the model.
  const pendingPlanDecisionRef = useRef<
    | ((
        decision:
          | { kind: 'approve' }
          | { kind: 'deny' }
          | { kind: 'feedback'; text: string },
      ) => void)
    | null
  >(null);

  /** Drive the Computer Use loop: execute each tool_use, capture a fresh
   *  screenshot, send results back, repeat until done or aborted. When
   *  `approvalMode === 'each-action'`, pauses before each action until the
   *  user clicks Approve / Skip / Stop. */
  const runLoop = useCallback(
    async (
      initialPrompt: string,
      imageBytes: Uint8Array,
      imageMimeType: string,
      imageWidth: number,
      imageHeight: number,
      approvalMode: 'per-task' | 'each-action' | 'never',
      initialAttachments: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>,
      // When set, this submit appends a NEW user message to an existing
      // paused loop (option-A continuity) instead of starting fresh.
      // Provided by the renderer when conversationMode is on AND a
      // previous Access turn just finished cleanly.
      continueLoopId?: string,
    ) => {
      let turn: ComputerLoopTurn;
      try {
        if (continueLoopId) {
          turn = await window.optix.computer.appendUserMessage({
            loopId: continueLoopId,
            prompt: initialPrompt,
            imageBytes,
            imageMimeType,
            imageWidth,
            imageHeight,
            imageAttachments: initialAttachments,
          });
        } else {
          turn = await window.optix.computer.start({
            prompt: initialPrompt,
            imageBytes,
            imageMimeType,
            imageWidth,
            imageHeight,
            imageAttachments: initialAttachments,
          });
        }
      } catch (err) {
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        // Main-side has already torn down the loop on this error path.
        // Drop our reference so the next submit doesn't try to append
        // to a dead loop id.
        liveLoopIdRef.current = null;
        return;
      }
      loopAbortRef.current = { loopId: turn.loopId, aborted: false };

      const allItems: LoopItem[] = [];
      let curImageWidth = imageWidth;
      let curImageHeight = imageHeight;

      // Loop until the model says done or the user aborts. Each iteration:
      // 1) push the model's narration text (if any) as a message item
      // 2) push 'running' action items for each tool_use, in order
      // 3) execute each, capture post-action screenshot, mark ✓/✗
      // 4) call continue with the batch of results, repeat
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (loopAbortRef.current.aborted) return;
        // Pause boundary: between turns. The model has finished its
        // previous response and we're about to drive the next continue
        // call; this is the cleanest place to park the loop.
        // eslint-disable-next-line no-await-in-loop
        await waitIfPaused();
        if (loopAbortRef.current.aborted) return;

        if (turn.done) {
          // Final message renders as the conclusion at the bottom of the list.
          if (turn.finalText) {
            allItems.push({
              kind: 'message',
              id: `msg-final-${turn.turnIndex}`,
              text: turn.finalText,
              isFinal: true,
            });
          }
          setStatus({
            kind: 'loop-done',
            items: allItems,
            turnIndex: turn.turnIndex,
            capped: turn.capped,
          });
          loopAbortRef.current = { loopId: null, aborted: false };
          loopPauseRef.current = { paused: false, resolveResume: null };
          if (pendingResumeRef.current) {
            clearTimeout(pendingResumeRef.current);
            pendingResumeRef.current = null;
          }
          setIsPaused(false);
          // When conversationMode is on, keep the loop alive in main so
          // the next submit can append to the same conversation. The
          // capped case is intentionally NOT continued — turn-cap means
          // something went wrong and a fresh start is the safer call.
          if (settingsRef.current?.conversationMode && !turn.capped) {
            liveLoopIdRef.current = turn.loopId;
          } else {
            // Mode off (or capped): tell main to drop the adapter state
            // so we don't leak memory. Single-shot success counts as a
            // proper 'done' (the agent's task ran to completion). Capped
            // would have been finalized in main with `outcome: 'capped'`
            // already, so this end call is a no-op for that path.
            void window.optix.computer.end(turn.loopId, 'done').catch(() => {
              /* ignore */
            });
            liveLoopIdRef.current = null;
          }
          // Flush a recording in progress, if any. We persist only on
          // a clean done (not capped) and only when at least one
          // action was captured — partial recordings would replay
          // weirdly. Reset the recording ref + UI toggle either way.
          const rec = recordingRef.current;
          if (rec?.active && !turn.capped && rec.actions.length > 0) {
            // Sum API cost across all recorded turns using the same
            // helper the audit log uses, so the routine list cost
            // matches what Access Logs would have shown for the
            // same run.
            const estimatedCostUsd = costForTurns(rec.usages);
            void window.optix.routines
              .save({
                originalPrompt: rec.originalPrompt,
                actions: rec.actions,
                providerId: settingsRef.current?.activeProviderId ?? 'anthropic',
                modelId:
                  settingsRef.current?.modelByProvider[
                    settingsRef.current?.activeProviderId ?? 'anthropic'
                  ] ?? '(unknown)',
                turnCount: rec.turnCount,
                estimatedCostUsd,
                imageWidth: rec.imageWidth,
                imageHeight: rec.imageHeight,
              })
              .then((saved) => {
                if (!saved) {
                  console.warn(
                    '[optix-routines] save returned null — see main process logs',
                  );
                }
              })
              .catch((err) => {
                // Surface to DevTools so a silent failure (Zod parse
                // mismatch, fs write error) is at least visible.
                console.warn('[optix-routines] save failed:', err);
              });
          } else if (rec?.active) {
            console.log(
              '[optix-routines] recording NOT saved:',
              `actions=${rec.actions.length} capped=${turn.capped}`,
            );
          }
          recordingRef.current = null;
          setIsRecording(false);
          return;
        }

        // Push the model's narration for this turn (if any) BEFORE the
        // action items, since the model emits text before the tool_use.
        if (turn.finalText) {
          allItems.push({
            kind: 'message',
            id: `msg-${turn.turnIndex}`,
            text: turn.finalText,
          });
        }
        // Stash the model's narration on the recording so it attaches
        // to the next action's RecordedAction entry. Hint-based
        // replay uses this to reconstruct the model's reasoning trail.
        // Also bump the turn counter + capture this turn's usage so
        // the saved routine surfaces turns × actions × cost the same
        // way Access Logs does.
        if (recordingRef.current?.active) {
          recordingRef.current.pendingModelText = turn.finalText ?? undefined;
          recordingRef.current.turnCount += 1;
          const u: TokenUsage = {
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            cacheCreationInputTokens: turn.cacheCreationInputTokens,
            cacheReadInputTokens: turn.cacheReadInputTokens,
          };
          recordingRef.current.usages.push({
            modelId:
              settingsRef.current?.modelByProvider[
                settingsRef.current?.activeProviderId ?? 'anthropic'
              ] ?? '(unknown)',
            usage: u,
          });
        }
        // Stage: insert a 'running' action item for each tool_use, in order.
        const newActions: LoopActionItem[] = turn.toolUses.map((tu: AgentToolUse) => ({
          kind: 'action',
          toolUseId: tu.id,
          description: describeAction(tu.action),
          actionKind: actionKindOf(tu.action),
          state: 'running',
        }));
        allItems.push(...newActions);
        setStatus({
          kind: 'looping',
          loopId: turn.loopId,
          items: [...allItems],
          turnIndex: turn.turnIndex,
          imageWidth: curImageWidth,
          imageHeight: curImageHeight,
        });

        const results: Array<{
          toolUseId: string;
          screenshotBytes?: Uint8Array;
          screenshotMimeType?: string;
          text?: string;
          errorText?: string;
          /** Wall-clock execution time stamped from the renderer's
           *  `actionT0` baseline. Forwarded to main where it lands in
           *  the audit log's per-action `durationMs`. */
          durationMs?: number;
        }> = [];

        // eslint-disable-next-line no-await-in-loop
        for (const tu of turn.toolUses) {
          if (loopAbortRef.current.aborted) return;
          // Pause boundary: between actions within a turn. The user
          // gets immediate feedback — the next click/keystroke won't
          // fire — without interrupting the action that's already in
          // flight.
          // eslint-disable-next-line no-await-in-loop
          await waitIfPaused();
          if (loopAbortRef.current.aborted) return;

          const action = tu.action;

          // ----------------------------------------------------------------
          // Decide whether this action requires user approval before running:
          //
          // Hard rule (applies in EVERY approval mode, including Never):
          //  • Any file action whose target sits outside the user-set
          //    workspace folder is gated. The workspace is a user-set
          //    boundary; an explicit prompt should fire when the agent
          //    tries to escape it, regardless of how trusting the user
          //    has been with everything else.
          //
          // Mode-based gating (only applies inside the workspace):
          //  • 'each-action' → gate everything except harmless no-ops
          //  • 'per-task'    → gate write_file (still always-confirm)
          //  • 'never'       → no extra gates
          // ----------------------------------------------------------------
          const isHarmlessNoop =
            action.tool === 'computer' && action.data.action === 'screenshot';
          let needsGate = false;

          // Hard boundary: out-of-scope file actions always prompt.
          if (action.tool === 'file') {
            const target =
              action.data.action === 'search_files'
                ? action.data.root
                : action.data.path;
            // eslint-disable-next-line no-await-in-loop
            const inScope = await window.optix.computer.isPathInScope(target);
            if (!inScope) {
              needsGate = true;
            }
          }

          // Hard boundary: out-of-workspace shell `cwd` always prompts.
          // We resolve cwd in main (workspace folder default → home dir
          // fallback) so the gate decision matches what the executor
          // actually runs against.
          if (action.tool === 'shell') {
            // eslint-disable-next-line no-await-in-loop
            const resolved = await window.optix.computer.resolveShellCwd(
              action.data.cwd,
            );
            if (!resolved.inScope) {
              needsGate = true;
            }
          }

          // Mode-based gating layered on top.
          if (!needsGate) {
            if (approvalMode === 'each-action' && !isHarmlessNoop) {
              needsGate = true;
            } else if (
              approvalMode === 'per-task' &&
              action.tool === 'file' &&
              action.data.action === 'write_file'
            ) {
              needsGate = true;
            } else if (approvalMode === 'per-task' && action.tool === 'shell') {
              // Shell commands are side-effectful enough to deserve the
              // same per-task always-confirm treatment as write_file.
              needsGate = true;
            }
          }

          // Per-action approval gate: pause until the user decides.
          if (needsGate) {
            setStatus({
              kind: 'looping',
              loopId: turn.loopId,
              items: [...allItems],
              turnIndex: turn.turnIndex,
              imageWidth: curImageWidth,
              imageHeight: curImageHeight,
              pendingActionId: tu.id,
            });
            // Note: we do NOT toggle widget focusability here. The widget
            // stays non-focusable, so mouse clicks on Approve/Deny/Type
            // buttons land on the buttons (Win32 click events still flow
            // to non-activatable windows) but the target app keeps OS
            // foreground/keyboard focus throughout. Focus is only briefly
            // borrowed inside PerActionApproval when the user opens the
            // "Type something" textarea, then handed back via a foreground-
            // window restore.
            // eslint-disable-next-line no-await-in-loop
            const decision = await new Promise<PerActionDecision>((resolve) => {
              pendingApprovalRef.current = resolve;
            });
            pendingApprovalRef.current = null;

            if (decision.kind === 'abort') {
              loopAbortRef.current.aborted = true;
              try { await window.optix.computer.abort(turn.loopId); } catch { /* ignore */ }
              setStatus({ kind: 'idle' });
              return;
            }

            // Update item + clear pending state for non-approve decisions.
            const refreshLooping = (): void => {
              setStatus({
                kind: 'looping',
                loopId: turn.loopId,
                items: [...allItems],
                turnIndex: turn.turnIndex,
                imageWidth: curImageWidth,
                imageHeight: curImageHeight,
              });
            };

            if (decision.kind === 'deny' || decision.kind === 'feedback') {
              const idx = allItems.findIndex(
                (i) => i.kind === 'action' && i.toolUseId === tu.id,
              );
              const errMsg = decision.kind === 'deny'
                ? 'Denied by user.'
                : `User feedback: ${decision.text}`;
              if (idx !== -1) {
                const prev = allItems[idx] as LoopActionItem;
                allItems[idx] = {
                  ...prev,
                  state: 'failed',
                  errorText: decision.kind === 'deny' ? 'Denied by user' : `Feedback: ${decision.text}`,
                };
              }
              refreshLooping();
              results.push({ toolUseId: tu.id, errorText: errMsg });
              continue;
            }
            // 'approve' falls through to normal execution.
            refreshLooping();
          }

          // -----------------------------------------------------------------
          // Dispatch by tool kind:
          //  • computer (screenshot)    → no-op; we capture fresh below
          //  • computer (other)         → robotjs via computer.execute, then
          //                                 capture a fresh screenshot
          //  • file (any)               → file-system executor; the output
          //                                 text becomes the tool_result; no
          //                                 screenshot needed
          // -----------------------------------------------------------------
          let resultOk = true;
          let resultErrText: string | undefined;
          let resultText: string | undefined;
          let postActionCapture = false; // true → capture a screenshot afterwards
          // Wall-clock start of this action's execution. Reported back
          // to main so the audit log records actual per-action latency
          // instead of the always-zero placeholder it had before. The
          // measurement covers executor work + any settle delay + the
          // post-action screenshot capture, since all three contribute
          // to the user's perceived time-to-next-turn.
          const actionT0 = performance.now();

          if (action.tool === 'meta') {
            // The agent paused for user input. Show the ChoicePrompt
            // inline (via status.pendingAsk), await the user's pick,
            // then send the picked value back as the tool_result text.
            // No screenshot — meta actions don't change OS state.
            const askAction = action.data;
            setStatus({
              kind: 'looping',
              loopId: turn.loopId,
              items: [...allItems],
              turnIndex: turn.turnIndex,
              imageWidth: curImageWidth,
              imageHeight: curImageHeight,
              pendingAsk: { toolUseId: tu.id, action: askAction },
            });
            // The user is interacting with our UI now — let the widget
            // accept keyboard focus while we wait. Restored after.
            try {
              await window.optix.widget.beginTextInput();
            } catch {
              /* ignore — best-effort focus shift */
            }
            // eslint-disable-next-line no-await-in-loop
            const choice = await new Promise<string>((resolve) => {
              pendingChoiceRef.current = resolve;
            });
            pendingChoiceRef.current = null;
            try {
              await window.optix.widget.endTextInput();
            } catch {
              /* ignore */
            }
            // Clear pendingAsk and let the loop continue with this turn.
            setStatus({
              kind: 'looping',
              loopId: turn.loopId,
              items: [...allItems],
              turnIndex: turn.turnIndex,
              imageWidth: curImageWidth,
              imageHeight: curImageHeight,
            });
            resultText = choice;
            postActionCapture = false;
          } else if (action.tool === 'plan') {
            // The agent proposed a plan. Pause the loop, render the
            // PlanApprovalGate inline, and feed the user's decision
            // back as the tool_result text on the next turn. On
            // approve we also persist the plan to disk so the Plan
            // button can light up + the plan view can show it.
            const planAction = action.data;
            setStatus({
              kind: 'looping',
              loopId: turn.loopId,
              items: [...allItems],
              turnIndex: turn.turnIndex,
              imageWidth: curImageWidth,
              imageHeight: curImageHeight,
              pendingPlan: { toolUseId: tu.id, action: planAction },
            });
            try {
              await window.optix.widget.beginTextInput();
            } catch {
              /* ignore */
            }
            // eslint-disable-next-line no-await-in-loop
            const decision = await new Promise<
              | { kind: 'approve' }
              | { kind: 'deny' }
              | { kind: 'feedback'; text: string }
            >((resolve) => {
              pendingPlanDecisionRef.current = resolve;
            });
            pendingPlanDecisionRef.current = null;
            try {
              await window.optix.widget.endTextInput();
            } catch {
              /* ignore */
            }
            setStatus({
              kind: 'looping',
              loopId: turn.loopId,
              items: [...allItems],
              turnIndex: turn.turnIndex,
              imageWidth: curImageWidth,
              imageHeight: curImageHeight,
            });
            if (decision.kind === 'approve') {
              try {
                await window.optix.plan.save({
                  content: planAction.content,
                  rationale: planAction.rationale,
                  loopId: turn.loopId,
                });
              } catch {
                /* persistence failure — non-fatal, the plan still
                 * lives in conversation history */
              }
              resultText =
                'Plan accepted by user. Saved as the active plan.\n\n' +
                planAction.content;
            } else if (decision.kind === 'deny') {
              resultOk = false;
              resultErrText = 'User rejected the plan.';
            } else {
              resultOk = false;
              resultErrText = `User feedback on the plan: ${decision.text}`;
            }
            postActionCapture = false;
          } else if (action.tool === 'shell') {
            // Run the command via the OS shell. Output is captured as
            // text — no screenshot, since shell work usually doesn't
            // change the visible UI in a way the model needs to re-see.
            // eslint-disable-next-line no-await-in-loop
            const sr = await window.optix.computer.executeShell({
              action: action.data,
            });
            if (sr.ok) {
              // Surface exit code + output. Wrap output in a fence
              // so the agent (and the audit log) can tell where it
              // begins and ends, especially for empty output.
              resultText = sr.output
                ? `Exit code: ${sr.exitCode}\n--- output ---\n${sr.output}`
                : `Exit code: ${sr.exitCode}\n(no output)`;
            } else {
              resultOk = false;
              resultErrText = sr.output
                ? `${sr.error}\n--- output ---\n${sr.output}`
                : sr.error;
            }
            postActionCapture = false;
          } else if (action.tool === 'file') {
            // eslint-disable-next-line no-await-in-loop
            const fr = await window.optix.computer.executeFile({ action: action.data });
            if (fr.ok) {
              resultText = fr.output;
            } else {
              resultOk = false;
              resultErrText = fr.error;
            }
          } else if (action.tool === 'label') {
            // Label resolves via UIA + robotjs in main; like a click/scroll/
            // type, we follow with a fresh screenshot so the model sees the
            // post-action state.
            // eslint-disable-next-line no-await-in-loop
            const lr = await window.optix.computer.executeLabel({ action: action.data });
            if (lr.ok) {
              if (lr.text) resultText = lr.text;
              postActionCapture = true;
            } else {
              resultOk = false;
              resultErrText = lr.error;
            }
          } else if (action.data.action === 'screenshot') {
            // Pure capture request — no executor work, just fresh frame.
            postActionCapture = true;
          } else {
            // Kimi and Gemini benefit from auto-snapping click coords to
            // nearby UIA interactive elements — their pixel-coordinate
            // generation is unreliable. Anthropic and OpenAI hit pixels
            // accurately and skip the snap to save the UIA roundtrip.
            // Read via the ref because runLoop is memoised with [] deps —
            // direct `settings.activeProviderId` would be stuck at first-
            // render (null) and snapToUia would always be false.
            const provider = settingsRef.current?.activeProviderId;
            const snapToUia = provider === 'kimi' || provider === 'google';
            // eslint-disable-next-line no-await-in-loop
            const cr = await window.optix.computer.execute({
              action: action.data,
              imageWidth: curImageWidth,
              imageHeight: curImageHeight,
              snapToUia,
            });
            if (cr.ok) {
              if (cr.text) resultText = cr.text;
              postActionCapture = !cr.noScreenshot;
            } else {
              resultOk = false;
              resultErrText = cr.error;
            }
          }

          // Mark item state in the live UI.
          const idx = allItems.findIndex(
            (i) => i.kind === 'action' && i.toolUseId === tu.id,
          );
          if (idx !== -1) {
            const prev = allItems[idx] as LoopActionItem;
            allItems[idx] = {
              ...prev,
              state: resultOk ? 'done' : 'failed',
              errorText: resultOk ? undefined : resultErrText,
            };
          }
          setStatus({
            kind: 'looping',
            loopId: turn.loopId,
            items: [...allItems],
            turnIndex: turn.turnIndex,
            imageWidth: curImageWidth,
            imageHeight: curImageHeight,
          });

          if (!resultOk) {
            results.push({
              toolUseId: tu.id,
              errorText: resultErrText,
              durationMs: Math.round(performance.now() - actionT0),
            });
            continue;
          }
          // Recording: only successful actions land in the routine.
          // Failed actions wouldn't replay productively. The pending
          // modelText (this turn's narration) attaches to the FIRST
          // action; subsequent actions in the same turn share the
          // same narration source by clearing it after the attach.
          const rec = recordingRef.current;
          if (rec?.active) {
            // Pull out the click coordinate (if any) so the recorder
            // can enrich the action with the UIA element under it.
            // Different click variants live on the computer-tool
            // action — others (file/shell/plan/meta) skip the UIA
            // query and just capture the foreground window title.
            let point: [number, number] | undefined;
            if (tu.action.tool === 'computer') {
              const d = tu.action.data;
              if (
                d.action === 'left_click' ||
                d.action === 'right_click' ||
                d.action === 'middle_click' ||
                d.action === 'double_click' ||
                d.action === 'triple_click' ||
                d.action === 'mouse_move' ||
                d.action === 'left_mouse_down' ||
                d.action === 'left_mouse_up'
              ) {
                point = [d.coordinate[0], d.coordinate[1]];
              } else if (d.action === 'left_click_drag') {
                // For drags the start coordinate is the meaningful
                // semantic anchor — the drag's purpose is usually
                // "grab THAT thing and move it".
                point = [d.start_coordinate[0], d.start_coordinate[1]];
              }
            }
            // eslint-disable-next-line no-await-in-loop
            const ctx = await window.optix.computer
              .queryRecordingContext(point)
              .catch(() => null);
            rec.actions.push({
              action: tu.action,
              description: describeAction(tu.action),
              modelText: rec.pendingModelText,
              targetElementName: ctx?.targetElementName,
              targetElementType: ctx?.targetElementType,
              windowTitle: ctx?.windowTitle ?? undefined,
            });
            rec.pendingModelText = undefined;
          }
          if (resultText) {
            results.push({
              toolUseId: tu.id,
              text: resultText,
              durationMs: Math.round(performance.now() - actionT0),
            });
            continue;
          }

          // Only computer or label actions reach here (file actions
          // continued above with text results). Skip settle + capture if
          // the action set `noScreenshot` (e.g. cursor_position).
          if (!postActionCapture) {
            results.push({
              toolUseId: tu.id,
              text: resultText ?? '',
              durationMs: Math.round(performance.now() - actionT0),
            });
            continue;
          }
          // Settle delay before capture — tuned per action kind. Critical
          // for click→menu-open and type→IME-commit flows; trivial for
          // pure cursor moves. Label actions reuse computer-action timing.
          let settleMs = 0;
          if (action.tool === 'computer') {
            settleMs = settleDelayFor(action.data);
          } else if (action.tool === 'label') {
            // Map label → underlying primitive's settle.
            settleMs = action.data.action === 'type_into_label'
              ? 280
              : action.data.action === 'scroll_label'
                ? 200
                : 180; // click_label
          }
          if (settleMs > 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, settleMs));
          }
          if (loopAbortRef.current.aborted) return;

          try {
            // eslint-disable-next-line no-await-in-loop
            const cap = await window.optix.capture.screen();
            curImageWidth = cap.width;
            curImageHeight = cap.height;
            results.push({
              toolUseId: tu.id,
              screenshotBytes: cap.imageBytes,
              screenshotMimeType: cap.imageMimeType,
              durationMs: Math.round(performance.now() - actionT0),
            });
          } catch (err) {
            results.push({
              toolUseId: tu.id,
              errorText: err instanceof Error ? err.message : String(err),
              durationMs: Math.round(performance.now() - actionT0),
            });
          }
        }

        if (loopAbortRef.current.aborted) return;

        // Drain any mid-loop user interrupt the user typed while we
        // were busy executing this turn's actions. The text rides along
        // with the tool_results; the adapter appends it as a text block
        // to the next user message so the model re-reads its plan.
        const extraUserText = pendingInterruptRef.current ?? undefined;
        if (extraUserText) {
          pendingInterruptRef.current = null;
          setQueuedInterrupt(null);
          // Echo the interrupt as a user-bubble in the loop progress so
          // the user has visible confirmation it was injected.
          allItems.push({
            kind: 'message',
            id: `msg-interrupt-${Date.now()}`,
            text: `[you] ${extraUserText}`,
          });
        }

        // Send the batch of results back; await the next turn.
        try {
          // eslint-disable-next-line no-await-in-loop
          turn = await window.optix.computer.continue({
            loopId: turn.loopId,
            results,
            extraUserText,
          });
        } catch (err) {
          setStatus({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
          loopAbortRef.current = { loopId: null, aborted: false };
          loopPauseRef.current = { paused: false, resolveResume: null };
          if (pendingResumeRef.current) {
            clearTimeout(pendingResumeRef.current);
            pendingResumeRef.current = null;
          }
          setIsPaused(false);
          // Main-side error path tears down the loop; drop our ref.
          liveLoopIdRef.current = null;
          return;
        }
      }
    },
    [],
  );

  const submit = useCallback(async () => {
    if (!prompt.trim()) return;
    // Mid-loop interrupt path: while the agent is in `looping` state,
    // a submit doesn't start a new turn — it queues the user's text
    // and lets it ride along with the next continue() call. The
    // existing turn keeps running until then.
    if (status.kind === 'looping') {
      pendingInterruptRef.current = prompt.trim();
      setQueuedInterrupt(prompt.trim());
      setPrompt('');
      return;
    }
    if (isBusy) return;
    // Settings is null only during the initial IPC load. The render
    // shell shows "Loading…" in that state and the submit button isn't
    // mounted, so this guard is mostly for the type system — but it
    // also defends against any race where submit could fire early.
    if (!settings) return;
    setBusySince(Date.now());
    resetStreamBuffer();
    setStatus({ kind: 'capturing' });

    // Snapshot the staged attachments for this submission so we can clear
    // the tray immediately (user gets feedback the upload was consumed)
    // without losing the bytes mid-flight. Used by both Access and Ask paths.
    const submittedAttachments = attachments.map((a) => ({
      bytes: a.bytes,
      mimeType: a.mimeType,
      filename: a.filename,
    }));
    const submittedAttachmentNames = attachments
      .map((a) => a.filename ?? 'image')
      .filter((n) => n.length > 0);
    clearAttachments();

    // Conversation thread bookkeeping. When conversationMode is OFF we
    // keep the existing single-shot behavior — past turns are cleared so
    // the UI shows just the active card. When ON, past completed turns
    // accumulate above the new active card and persist to disk.
    if (!settings?.conversationMode) {
      setPastTurns([]);
      setConversationId(null);
      // Single-shot mode: any paused Access loop from a prior submit
      // is irrelevant. Tear down its main-side state so we don't leak.
      // Marked 'abandoned' because the user moved on without explicitly
      // wrapping up the prior conversation — the audit reflects that.
      if (liveLoopIdRef.current) {
        const stale = liveLoopIdRef.current;
        liveLoopIdRef.current = null;
        void window.optix.computer.end(stale, 'abandoned').catch(() => {
          /* ignore */
        });
      }
    }
    setActiveTurnPrompt(prompt);
    setActiveTurnAttachmentNames(submittedAttachmentNames);
    setActiveTurnMode(mode);
    // Stash the bytes we need at finalize time. Capture bytes get added
    // below once the screenshot is taken.
    activeTurnPersistRef.current = {
      attachments: submittedAttachments,
      capture: undefined,
    };
    // Clear the prompt input so the user can immediately type the next
    // message in conversation mode without having to delete the previous
    // one first. The submitted prompt lives in activeTurnPrompt for the
    // user-bubble render.
    setPrompt('');

    let imageBytes: Uint8Array | undefined;
    let imageMimeType: string | undefined;
    let captureTimings: CaptureTimings | undefined;
    let imageWidth: number | undefined;
    let imageHeight: number | undefined;
    let didReuseCapture = false;
    try {
      if (!settings?.privacyPaused) {
        // Smart capture-reuse: if the user is still in the same window
        // as the cached screenshot AND the cache is recent enough, skip
        // the recapture. Saves ~100-300ms + reuses warm pixels. No
        // user-visible toggle — the heuristic decides on its own.
        const cache = captureCacheRef.current;
        let canReuse = false;
        if (cache && Date.now() - cache.timestamp < CAPTURE_CACHE_MAX_AGE_MS) {
          // One Win32 syscall — fast even on a cold PowerShell child
          // (the foreground helper is already warm from prior captures).
          const fgHwnd = await window.optix.capture.foregroundHwnd();
          // Reuse only when both are non-null AND match. A null on
          // either side means we couldn't trust the comparison —
          // recapture to be safe.
          if (fgHwnd && cache.hwnd && fgHwnd === cache.hwnd) {
            canReuse = true;
          }
        }

        if (canReuse && cache) {
          imageBytes = cache.bytes;
          imageMimeType = cache.mimeType;
          imageWidth = cache.width;
          imageHeight = cache.height;
          didReuseCapture = true;
        } else {
          const capture = await window.optix.capture.screen();
          imageBytes = capture.imageBytes;
          imageMimeType = capture.imageMimeType;
          captureTimings = capture.timings;
          imageWidth = capture.width;
          imageHeight = capture.height;
          // Stamp the cache with the foreground HWND we just captured
          // against, so the next submit can compare. Done in parallel
          // with the user's prompt rendering — no blocking call.
          void window.optix.capture.foregroundHwnd().then((hwnd) => {
            captureCacheRef.current = {
              bytes: capture.imageBytes,
              mimeType: capture.imageMimeType,
              width: capture.width,
              height: capture.height,
              hwnd,
              timestamp: Date.now(),
            };
          });
        }

        if (activeTurnPersistRef.current && imageBytes && imageMimeType && imageWidth && imageHeight) {
          activeTurnPersistRef.current.capture = {
            bytes: imageBytes,
            mimeType: imageMimeType,
            width: imageWidth,
            height: imageHeight,
          };
        }
      }
      setReusedCapture(didReuseCapture);
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      setBusySince(null);
      return;
    }

    // Access / Automate mode → multi-turn Computer Use loop via the
    // active provider's adapter. Automate is identical to Access at
    // runtime; it just adds the optional record toggle (handled
    // outside this block) and the slash-menu replay shape (handled
    // before submit). The main side rejects providers without an
    // adapter; we route ALL providers through the loop here and
    // surface that error if it happens. Show the approval gate first
    // (per the user's setting); on `never` mode we skip straight.
    if (
      (mode === 'action' || mode === 'automate') &&
      imageBytes &&
      imageMimeType &&
      imageWidth &&
      imageHeight
    ) {
      // Augment the user's prompt with routine context. Two paths:
      //  • `/OA-{n}` tokens in the prompt → resolve each one to its
      //    routine (parallel disk reads), keep the token in place
      //    inside the user-facing line, and append one hint block
      //    per resolved routine so the agent sees the action list.
      //  • Legacy `replayingRoutineRef` (set by slash-menu pick on a
      //    pre-migration routine without an OA number) → keep using
      //    `buildReplayPrompt`.
      const legacyReplay = replayingRoutineRef.current;
      replayingRoutineRef.current = null;
      const submitPrompt = legacyReplay
        ? buildReplayPrompt(prompt, legacyReplay)
        : await expandRoutineTokens(prompt);

      // If recording is on (Automate mode + Record toggle), seed the
      // recording ref so each successful action gets captured. The
      // runLoop's done branch flushes the buffer to disk.
      if (mode === 'automate' && isRecording) {
        recordingRef.current = {
          active: true,
          originalPrompt: submitPrompt,
          actions: [],
          turnCount: 0,
          usages: [],
          imageWidth,
          imageHeight,
        };
      }
      if (settings.agentApprovalMode === 'never') {
        setStatus({
          kind: 'looping',
          loopId: '',
          items: [],
          turnIndex: 0,
          imageWidth,
          imageHeight,
        });
        try {
          // If a previous Access turn finished cleanly with conversationMode
          // on, `liveLoopIdRef` holds the paused loop's id — pass it so
          // the agent continues the same conversation instead of starting
          // fresh. Fresh start path is unchanged when no live loop exists.
          const continueId = liveLoopIdRef.current ?? undefined;
          await runLoop(
            submitPrompt,
            imageBytes,
            imageMimeType,
            imageWidth,
            imageHeight,
            'never',
            submittedAttachments,
            continueId,
          );
        } finally {
          setBusySince(null);
        }
        return;
      }
      // 'per-task' and 'each-action' both show the start-of-task gate first.
      // Per-action approvals layer on top during the loop itself.
      setStatus({
        kind: 'awaiting-approval',
        prompt: submitPrompt,
        imageBytes,
        imageMimeType,
        imageWidth,
        imageHeight,
        imageAttachments: submittedAttachments,
      });
      // busySince stays set so the timer keeps ticking visually; we'll clear
      // it on cancel/loop-done.
      return;
    }

    setStatus({ kind: 'thinking' });
    // Prior Q&A pairs from the visible thread, sent so the model has
    // context for follow-up questions in conversationMode. Without this,
    // each Ask submit hits the provider stateless even though the user
    // sees a chat thread above. We pull a short string for the
    // assistant side: the response's `answer` for done turns, the
    // agent's `finalText` for loop-done, or the error message — that's
    // all the model needs to "remember what we just said". Skipping
    // prior screenshots keeps tokens manageable.
    const priorTurns = settings?.conversationMode
      ? pastTurns.map((t) => {
          let assistantText = '';
          if (t.kind === 'done') {
            assistantText = t.response.answer;
            if (t.response.steps.length > 0) {
              assistantText +=
                '\n' + t.response.steps.map((s) => `${s.order}. ${s.text}`).join('\n');
            }
          } else if (t.kind === 'loop-done') {
            const finalMsg = t.items.find((i) => i.kind === 'message' && i.isFinal);
            assistantText =
              finalMsg && finalMsg.kind === 'message'
                ? finalMsg.text
                : '(agent run complete)';
          } else {
            assistantText = `(error: ${t.message})`;
          }
          return { prompt: t.prompt, assistantText };
        })
      : [];
    try {
      const { response, timings: providerTimings, usedWebSearch, sources, usage } = await window.optix.provider.prompt({
        mode,
        prompt,
        imageBytes,
        imageMimeType,
        imageWidth,
        imageHeight,
        imageAttachments: submittedAttachments,
        priorTurns,
      });
      // Stash the provider+model+usage for the persistence layer to
      // pick up when the turn finalises. Stored on the same ref as
      // the bytes so finalizeActiveTurn can grab everything in one
      // place. Provider/model come from the active settings — same
      // pair the IPC handler used.
      if (activeTurnPersistRef.current) {
        activeTurnPersistRef.current.usage = usage;
        activeTurnPersistRef.current.providerId = settings?.activeProviderId;
        activeTurnPersistRef.current.modelId = settings
          ? settings.modelByProvider[settings.activeProviderId]
          : undefined;
      }
      setStatus({
        kind: 'done',
        response,
        timings: { capture: captureTimings, provider: providerTimings },
        usedWebSearch,
        sources,
        imageWidth,
        imageHeight,
      });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusySince(null);
    }
  }, [prompt, mode, settings, isBusy, status.kind, resetStreamBuffer, attachments, clearAttachments]);

  // Auto-finalize the active turn into pastTurns once the status reaches
  // a terminal kind, but only when conversationMode is on. Single-shot
  // mode leaves status alone so the existing one-card-replaces-the-other
  // UX continues to work. The active card briefly renders the terminal
  // state before this fires; for `done`/`loop-done` that's the normal
  // completion paint, and for `error` it ensures the user sees the error
  // message before it gets snapshotted into the thread.
  useEffect(() => {
    if (!settings?.conversationMode) return;
    if (
      status.kind !== 'done' &&
      status.kind !== 'loop-done' &&
      status.kind !== 'error'
    ) {
      return;
    }
    finalizeActiveTurn(status);
  }, [status, settings?.conversationMode, finalizeActiveTurn]);

  const approveLoop = useCallback(async () => {
    if (status.kind !== 'awaiting-approval') return;
    const { prompt: p, imageBytes, imageMimeType, imageWidth, imageHeight, imageAttachments } = status;
    const mode = settings?.agentApprovalMode ?? 'per-task';
    setStatus({
      kind: 'looping',
      loopId: '',
      items: [],
      turnIndex: 0,
      imageWidth,
      imageHeight,
    });
    try {
      const continueId = liveLoopIdRef.current ?? undefined;
      await runLoop(p, imageBytes, imageMimeType, imageWidth, imageHeight, mode, imageAttachments, continueId);
    } finally {
      setBusySince(null);
    }
  }, [status, runLoop, settings?.agentApprovalMode]);

  const approvePendingAction = useCallback(() => {
    pendingApprovalRef.current?.({ kind: 'approve' });
  }, []);
  const denyPendingAction = useCallback(() => {
    pendingApprovalRef.current?.({ kind: 'deny' });
  }, []);
  const sendFeedbackForPendingAction = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pendingApprovalRef.current?.({ kind: 'feedback', text: trimmed });
  }, []);

  // Resolves the pending ask_user choice. Called by ChoicePrompt's
  // onSubmit when the user picks an option (or types freeform text).
  const submitChoice = useCallback((value: string) => {
    pendingChoiceRef.current?.(value);
  }, []);

  /** Slash menu pick: surgically replace the active `/query` range
   *  in the prompt with a `/OA-{n}` token + trailing space. The
   *  user can compose around the token freely — submit() resolves
   *  the token via `expandRoutineTokens`. Routines without an
   *  oaNumber (very old, pre-migration) fall back to staging the
   *  whole prompt via the legacy replay ref. */
  const pickRoutineFromSlash = useCallback(
    (summary: RoutineSummary, slash: ActiveSlashToken) => {
      if (typeof summary.oaNumber === 'number') {
        promptInputRef.current?.replaceRange(
          slash.start,
          slash.end,
          `/OA-${summary.oaNumber} `,
        );
      } else {
        // Legacy fallback — stage the routine directly via the
        // replay ref since it has no token form yet.
        void window.optix.routines.read(summary.id).then((r) => {
          if (r) {
            replayingRoutineRef.current = r;
            setPrompt(r.originalPrompt);
          }
        });
      }
      setSlashSelectedIndex(0);
    },
    [],
  );

  // Resolves the pending plan-tool decision. Called by
  // PlanApprovalGate when the user approves / denies / sends
  // feedback. The runLoop's plan branch turns this into either a
  // `plan.save` IPC call + accept tool_result, or a denial /
  // feedback tool_result.
  const resolvePlanDecision = useCallback(
    (
      decision:
        | { kind: 'approve' }
        | { kind: 'deny' }
        | { kind: 'feedback'; text: string },
    ) => {
      pendingPlanDecisionRef.current?.(decision);
    },
    [],
  );

  const cancelApproval = useCallback(() => {
    setStatus({ kind: 'idle' });
    setBusySince(null);
    // The active turn never produced any agent output — drop the user
    // bubble too rather than leaving it dangling above an empty area.
    setActiveTurnPrompt(null);
    setActiveTurnAttachmentNames([]);
    setActiveTurnMode(null);
  }, []);

  const stop = useCallback(async () => {
    // If the loop is paused on a per-action approval, resolve the pending
    // promise with 'abort' so runLoop can short-circuit cleanly.
    if (pendingApprovalRef.current) {
      pendingApprovalRef.current({ kind: 'abort' });
      return;
    }
    // Cancel a pending resume timer so it can't unpark the loop after
    // we've already aborted (the race window is the resume delay).
    if (pendingResumeRef.current) {
      clearTimeout(pendingResumeRef.current);
      pendingResumeRef.current = null;
    }
    // Cancel implies an unpause too — release any awaiter so runLoop
    // can wake, see `aborted = true`, and bail out cleanly.
    loopPauseRef.current.paused = false;
    loopPauseRef.current.resolveResume?.();
    loopPauseRef.current.resolveResume = null;
    setIsPaused(false);
    // Abort whichever flow is active.
    if (loopAbortRef.current.loopId) {
      const id = loopAbortRef.current.loopId;
      loopAbortRef.current.aborted = true;
      try {
        await window.optix.computer.abort(id);
      } catch {
        // ignore
      }
      // Aborted loop can't be continued — drop the live-loop ref so the
      // next submit takes the fresh-start path.
      if (liveLoopIdRef.current === id) liveLoopIdRef.current = null;
    } else {
      await window.optix.provider.cancel();
    }
    setStatus({ kind: 'idle' });
    setBusySince(null);
    // Drop the active user bubble — the turn produced nothing useful and
    // shouldn't linger as orphaned context above the next prompt.
    setActiveTurnPrompt(null);
    setActiveTurnAttachmentNames([]);
    setActiveTurnMode(null);
  }, []);

  // Reset everything for a fresh conversation. Aborts any in-flight
  // loop / Ask request, tears down a paused conversation-mode loop in
  // main (so its adapter state doesn't leak), and clears the thread
  // history. The saved plan is intentionally NOT cleared here — the
  // user manages that explicitly from the plan view's Clear button,
  // and many "new chat" flows are still working off the same plan.
  const clearChat = useCallback(async () => {
    // Cancel any pending per-action approval / plan decision so
    // runLoop can wake and bail out cleanly.
    pendingApprovalRef.current?.({ kind: 'abort' });
    pendingApprovalRef.current = null;
    pendingChoiceRef.current?.('');
    pendingChoiceRef.current = null;
    pendingPlanDecisionRef.current?.({ kind: 'deny' });
    pendingPlanDecisionRef.current = null;

    // Clear pause + pending resume timer.
    if (pendingResumeRef.current) {
      clearTimeout(pendingResumeRef.current);
      pendingResumeRef.current = null;
    }
    loopPauseRef.current.paused = false;
    loopPauseRef.current.resolveResume?.();
    loopPauseRef.current.resolveResume = null;
    setIsPaused(false);

    // Abort whichever flow is active. Best-effort — failures are
    // non-fatal and we still clear UI state below.
    if (loopAbortRef.current.loopId) {
      const id = loopAbortRef.current.loopId;
      loopAbortRef.current.aborted = true;
      try {
        await window.optix.computer.abort(id);
      } catch {
        /* ignore */
      }
    } else {
      try {
        await window.optix.provider.cancel();
      } catch {
        /* ignore */
      }
    }

    // Tear down any paused conversation-mode loop sitting in main.
    if (liveLoopIdRef.current) {
      const stale = liveLoopIdRef.current;
      liveLoopIdRef.current = null;
      void window.optix.computer.end(stale, 'abandoned').catch(() => {
        /* ignore */
      });
    }

    // Reset all UI state in one batch.
    setStatus({ kind: 'idle' });
    setBusySince(null);
    setActiveTurnPrompt(null);
    setActiveTurnAttachmentNames([]);
    setActiveTurnMode(null);
    setPastTurns([]);
    setConversationId(null);
    setPrompt('');
    setAttachments([]);
    setAttachError(null);
    setQueuedInterrupt(null);
    setStreamBuffer('');
  }, []);

  // Block at the next natural boundary in runLoop. Caller awaits us; we
  // resolve immediately when not paused, otherwise park on a promise the
  // resume callback will fulfil. Used at the top of the per-turn while
  // loop and the per-action for loop so an in-flight API call or
  // executor isn't interrupted mid-flight — the pause takes effect at
  // the next clean boundary instead.
  const waitIfPaused = useCallback(async (): Promise<void> => {
    if (!loopPauseRef.current.paused) return;
    await new Promise<void>((resolve) => {
      loopPauseRef.current.resolveResume = resolve;
    });
  }, []);

  const pauseLoop = useCallback(() => {
    // Only meaningful when a loop is actually running.
    if (!loopAbortRef.current.loopId) return;
    // If a resume was in flight, cancel it — re-pausing on top of a
    // pending resume should leave the loop paused, not paused-then-
    // unpaused once the timer fires.
    if (pendingResumeRef.current) {
      clearTimeout(pendingResumeRef.current);
      pendingResumeRef.current = null;
    }
    if (loopPauseRef.current.paused) return;
    loopPauseRef.current.paused = true;
    setIsPaused(true);
  }, []);

  const resumeLoop = useCallback(() => {
    if (!loopPauseRef.current.paused) return;
    // Instant visual feedback: drop the highlight and flip the icon
    // back to pause-bars right now so the click feels responsive.
    setIsPaused(false);
    // The actual loop unpark is deferred so a follow-up double-click
    // (which fires Cancel) can intercept and abort before any new
    // agent action runs. Clear any prior pending resume first so
    // back-to-back resume clicks don't stack timers.
    if (pendingResumeRef.current) clearTimeout(pendingResumeRef.current);
    pendingResumeRef.current = setTimeout(() => {
      pendingResumeRef.current = null;
      // stop() may have cleared the paused flag already (cancel won
      // the race) — in that case there's nothing to unpark.
      if (!loopPauseRef.current.paused) return;
      loopPauseRef.current.paused = false;
      loopPauseRef.current.resolveResume?.();
      loopPauseRef.current.resolveResume = null;
    }, RESUME_DELAY_MS);
  }, []);

  // 3-second auto-dismiss: the overlay is meant as a quick visual aid, not
  // a persistent annotation that follows the user as they switch apps. The
  // ref holds the active timeout so a manual hide / new submit can cancel
  // it before it fires.
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const OVERLAY_DURATION_MS = 5000;

  const cancelOverlayTimer = useCallback(() => {
    if (overlayTimerRef.current !== null) {
      clearTimeout(overlayTimerRef.current);
      overlayTimerRef.current = null;
    }
  }, []);

  // The "latest overlay-able turn" — either the active card (single-shot
  // mode keeps `status.kind === 'done'` after a response) OR the most
  // recent past turn (conversationMode finalizes the active turn into
  // `pastTurns` and resets status to `idle`, so the regions live there).
  // The button visibility and `toggleOverlay` both read from this so the
  // overlay still works after a turn has been moved into the thread.
  const overlaySource = useMemo<{
    regions: TargetRegion[];
    imageWidth: number;
    imageHeight: number;
  } | null>(() => {
    const collect = (
      response: ModelResponse,
      w: number | undefined,
      h: number | undefined,
    ) => {
      if (!w || !h) return null;
      const stepRegions = response.steps
        .map((s) => s.targetRegion)
        .filter((r): r is NonNullable<typeof r> => r !== undefined);
      const regions = [...response.targetRegions, ...stepRegions];
      if (regions.length === 0) return null;
      return { regions, imageWidth: w, imageHeight: h };
    };
    if (status.kind === 'done') {
      const fromActive = collect(status.response, status.imageWidth, status.imageHeight);
      if (fromActive) return fromActive;
    }
    // Walk past turns in reverse looking for the most recent done with
    // populated regions. Skips loop-done / error turns — only Ask
    // responses produce overlay regions.
    for (let i = pastTurns.length - 1; i >= 0; i--) {
      const t = pastTurns[i];
      if (t && t.kind === 'done') {
        const fromPast = collect(t.response, t.imageWidth, t.imageHeight);
        if (fromPast) return fromPast;
        // First done turn wins regardless of whether it has regions —
        // earlier turns are obsolete from the user's POV.
        break;
      }
    }
    return null;
  }, [status, pastTurns]);

  const toggleOverlay = useCallback(async () => {
    if (overlayShowing) {
      cancelOverlayTimer();
      await window.optix.overlay.hide();
      setOverlayShowing(false);
      return;
    }
    if (!overlaySource) return;
    await window.optix.overlay.show({
      regions: overlaySource.regions,
      imageWidth: overlaySource.imageWidth,
      imageHeight: overlaySource.imageHeight,
    });
    setOverlayShowing(true);
    cancelOverlayTimer();
    overlayTimerRef.current = setTimeout(() => {
      void window.optix.overlay.hide();
      setOverlayShowing(false);
      overlayTimerRef.current = null;
    }, OVERLAY_DURATION_MS);
  }, [overlayShowing, overlaySource, cancelOverlayTimer]);

  // Tear down the overlay when the source disappears — e.g. the user
  // submitted a new query and the prior regions are no longer relevant.
  useEffect(() => {
    if (!overlaySource && overlayShowing) {
      cancelOverlayTimer();
      void window.optix.overlay.hide();
      setOverlayShowing(false);
    }
  }, [overlaySource, overlayShowing, cancelOverlayTimer]);

  // Cancel the auto-dismiss timer on unmount so we don't fire after teardown.
  useEffect(() => cancelOverlayTimer, [cancelOverlayTimer]);

  // Auto-scroll the body to its bottom whenever a new turn lands —
  // either a fresh user message starting (activeTurnPrompt becomes
  // non-null) or a finished turn moving into pastTurns. Without this,
  // newer content appears below the fold while the viewport stays
  // pinned to whatever was on screen before, which reads as the new
  // message overlapping the old. Uses scrollHeight rather than a
  // child ref so we don't have to thread a ref through every turn.
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    // requestAnimationFrame so we scroll AFTER the new content has
    // been laid out (otherwise scrollHeight is the pre-update value).
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [pastTurns.length, activeTurnPrompt]);

  // Track whether the body has content scrolled below the visible area
  // so the bottom fade only renders when it actually has content to
  // fade out. Listens to scroll + uses ResizeObserver so the fade
  // hides when the user reaches the bottom or when content shrinks
  // back inside the viewport.
  useEffect(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    // 4px epsilon — sub-pixel rounding can leave scrollTop a fraction
    // short of (scrollHeight - clientHeight) even when "at bottom".
    const update = (): void => {
      const overflowing = el.scrollHeight > el.clientHeight + 1;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      setShowBodyFade(overflowing && !atBottom);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Also observe the inner content — when a turn finishes streaming
    // and the response card grows, the body's clientHeight didn't
    // change but scrollHeight did. Watching the first child catches it.
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [pastTurns.length, activeTurnPrompt, status.kind]);


  if (!settings) {
    return (
      <div className="widget">
        <WidgetHeader
          providerLabel="…"
          modelLabel="…"
          onDocs={() => setShowDocs(true)}
          onSettings={() => setShowSettings(true)}
          onHide={() => window.optix.widget.hide()}
          onToggleCompact={toggleCompact}
          isCompact={isCompact}
        />
        <div className="widget__loading">Loading…</div>
      </div>
    );
  }

  if (showSettings) {
    return (
      <div className="widget">
        <SettingsPanel settings={settings} onClose={() => setShowSettings(false)} />
      </div>
    );
  }

  if (showDocs) {
    return (
      <div className="widget">
        <DocsViewer onClose={() => setShowDocs(false)} />
      </div>
    );
  }

  if (showPlanView && savedPlan) {
    return (
      <div className="widget">
        <PlanView
          plan={savedPlan}
          onClose={() => setShowPlanView(false)}
          onClear={() => {
            void window.optix.plan.clear().then(() => {
              setShowPlanView(false);
            });
          }}
        />
      </div>
    );
  }

  const providerLabel = PROVIDER_LABELS[settings.activeProviderId];
  const modelLabel = settings.modelByProvider[settings.activeProviderId] ?? '(no model)';

  return (
    <div className={`widget${isCompact ? ' widget--compact' : ''}`}>
      <WidgetHeader
        providerLabel={providerLabel}
        modelLabel={modelLabel}
        onDocs={() => setShowDocs(true)}
        onSettings={() => setShowSettings(true)}
        onHide={() => window.optix.widget.hide()}
        onToggleCompact={toggleCompact}
        isCompact={isCompact}
      />

      <div className="widget__controls">
        <ModeSwitch mode={mode} onChange={setMode} disabled={isBusy} />
        {/* Action-icon cluster on the right side of the controls row.
            Wrapping in its own flex container with a tight 4px gap
            means the icons sit next to each other (parent's
            space-between handles the big gap from the mode switch). */}
        <div className="widget__controls-actions">
          {/* Automate-mode Record toggle. Arms the NEXT run for
              capture; the loop's done path saves the automation and
              resets the toggle. The list of saved automations lives
              in the Settings header, alongside Access Logs / Ask
              Logs, so all run history is in one place. */}
          {mode === 'automate' && (
            <button
              type="button"
              className={`btn btn--icon${isRecording ? ' btn--icon-recording' : ''}`}
              onClick={() => setIsRecording((v) => !v)}
              disabled={isBusy}
              title={
                isRecording
                  ? 'Recording armed — your next run will be saved as an automation'
                  : 'Record the next run as a reusable automation'
              }
              aria-label={isRecording ? 'Cancel recording' : 'Arm recording'}
            >
              <RecordIcon />
            </button>
          )}
          {/* Plan button — shown in Access AND Automate (both use the
              Computer Use loop and benefit from plans). Always
              rendered for layout stability; disabled until a plan
              has been saved. Click opens the plan view. */}
          {(mode === 'action' || mode === 'automate') && (
            <button
              type="button"
              className={`btn btn--icon${savedPlan ? ' btn--icon-active' : ''}`}
              onClick={() => setShowPlanView(true)}
              disabled={!savedPlan}
              title={
                savedPlan
                  ? 'View the active plan'
                  : 'No plan yet — the agent will create one when needed'
              }
              aria-label="View the active plan"
            >
              <PlanListIcon />
            </button>
          )}
          {/* Workspace folder picker — shown in Access AND Automate
              (the Computer Use loop and shell tool both honour scope
              regardless of which tab is driving). */}
          {(mode === 'action' || mode === 'automate') && (
            <WorkspaceFolderControl settings={settings} />
          )}
          {/* Overlay toggle — always rendered when overlay is enabled
              in settings, but disabled until a response with target
              regions arrives. Keeping the button visible (just dim)
              means its position doesn't shift when an answer lands. */}
          {settings.overlayEnabled && (
            <button
              type="button"
              className={`btn btn--icon${overlayShowing ? ' btn--icon-active' : ''}`}
              onClick={toggleOverlay}
              disabled={!overlaySource}
              title={
                !overlaySource
                  ? 'Highlight the answer on screen — available once the agent locates an element'
                  : overlayShowing
                    ? 'Hide on-screen highlight'
                    : 'Show on-screen highlight'
              }
              aria-label={overlayShowing ? 'Hide on-screen highlight' : 'Show on-screen highlight'}
            >
              <SearchIcon />
            </button>
          )}
          {/* Clear chat — abort any in-flight work and start fresh.
              Disabled when there's nothing to clear (idle + empty
              thread + empty prompt + no attachments) so the row's
              affordances reflect available actions. The saved plan
              is left intact; users manage that from the plan view. */}
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => void clearChat()}
            disabled={
              status.kind === 'idle' &&
              pastTurns.length === 0 &&
              activeTurnPrompt === null &&
              !prompt.trim() &&
              attachments.length === 0
            }
            title="Clear the chat and start fresh"
            aria-label="Clear chat"
          >
            <NewChatIcon />
          </button>
        </div>
      </div>

      <div
        className={`widget__body${showBodyFade ? ' widget__body--has-overflow' : ''}`}
        ref={bodyScrollRef}
      >
        {/* Pinned plan card — visible whenever a plan is saved in
            Access mode. Click opens the full plan view. Stays at the
            top of the body so the user can glance at the active plan
            mid-task without scrolling through the run timeline. */}
        {savedPlan && (mode === 'action' || mode === 'automate') && (
          <button
            type="button"
            className="plan-pinned"
            onClick={() => setShowPlanView(true)}
            title="Open the active plan"
          >
            <span className="plan-pinned__icon" aria-hidden="true">
              <PlanListIcon />
            </span>
            <span className="plan-pinned__label">Active plan</span>
            <span className="plan-pinned__preview">
              {savedPlan.content.split('\n').find((l) => l.trim().length > 0) ??
                ''}
            </span>
          </button>
        )}

        {/* Idle advisory — only when there's no active conversation. */}
        {pastTurns.length === 0 &&
          activeTurnPrompt === null &&
          status.kind === 'idle' &&
          mode === 'action' &&
          (settings.activeProviderId === 'kimi' || settings.activeProviderId === 'google') && (
            <div className="widget__advisory">
              ⚠ {providerLabel} can be unreliable for visual clicks. For best Access-mode accuracy, use Anthropic.
            </div>
          )}

        {/* Awaiting-approval gate is its own layout (no user bubble —
            the gate echoes the prompt prominently itself). Sits outside
            the unified turn list. */}
        {status.kind === 'awaiting-approval' && (
          <ApprovalGate
            prompt={status.prompt}
            onApprove={() => void approveLoop()}
            onCancel={cancelApproval}
          />
        )}

        {/* Unified conversation list — past turns AND the active turn
            share the same shell (`.widget__thread-turn`) so messages
            and responses flow together as one stream. The body is the
            single scroll container; new turns auto-scroll to bottom. */}
        {(pastTurns.length > 0 || (activeTurnPrompt !== null && status.kind !== 'awaiting-approval')) && (
          <div className="widget__thread">
            {pastTurns.map((t) => (
              <div key={t.id} className="widget__thread-turn">
                <UserBubble
                  prompt={t.prompt}
                  mode={t.mode}
                  attachmentNames={t.attachmentNames}
                />
                {t.kind === 'done' && (
                  <ResponseCard
                    response={t.response}
                    timings={t.timings}
                    usedWebSearch={t.usedWebSearch}
                    sources={t.sources}
                    imageWidth={t.imageWidth}
                    imageHeight={t.imageHeight}
                  />
                )}
                {t.kind === 'loop-done' && (
                  <ComputerLoopProgress
                    items={t.items}
                    turnIndex={t.turnIndex}
                    done
                    capped={t.capped}
                  />
                )}
                {t.kind === 'error' && (
                  <div className="widget__error">{t.message}</div>
                )}
              </div>
            ))}

            {/* Active turn — same shell as a past turn. Its agent
                output swaps based on `status.kind` (streaming →
                done, or looping → loop-done). */}
            {activeTurnPrompt !== null &&
              activeTurnMode !== null &&
              status.kind !== 'idle' &&
              status.kind !== 'awaiting-approval' && (
                <div className="widget__thread-turn">
                  <UserBubble
                    prompt={activeTurnPrompt}
                    mode={activeTurnMode}
                    attachmentNames={activeTurnAttachmentNames}
                  />

                  {reusedCapture && (
                    <div className="widget__reused-capture">
                      ↺ Reusing prior screenshot · same window, &lt;30s old
                    </div>
                  )}

                  {status.kind === 'error' && (
                    <div className="widget__error">{status.message}</div>
                  )}

                  {status.kind === 'looping' && (
                    <ComputerLoopProgress
                      items={status.items}
                      turnIndex={status.turnIndex}
                      pendingActionId={status.pendingActionId}
                      pendingAsk={status.pendingAsk}
                      pendingPlan={status.pendingPlan}
                      onApprove={approvePendingAction}
                      onDeny={denyPendingAction}
                      onFeedback={sendFeedbackForPendingAction}
                      onChoice={submitChoice}
                      onPlanDecision={resolvePlanDecision}
                    />
                  )}

                  {status.kind === 'loop-done' && (
                    <ComputerLoopProgress
                      items={status.items}
                      turnIndex={status.turnIndex}
                      done
                      capped={status.capped}
                    />
                  )}

                  {/* Streaming view: same `.response` shell as the final
                      ResponseCard so framing doesn't change when the
                      stream finishes — only the inner content swaps. */}
                  {(status.kind === 'capturing' || status.kind === 'thinking') &&
                    streamingIntent && (
                      <article className="response">
                        <header className="response__header">
                          <span className="response__intent">{streamingIntent}</span>
                          {streamingConfidence !== null && (
                            <span className="response__confidence" title="Model confidence">
                              {Math.round(streamingConfidence * 100)}%
                            </span>
                          )}
                        </header>
                        <div className="response__scroll">
                          {streamingAnswer && (
                            <p
                              className={
                                streamingSteps.length === 0 && streamingWarnings.length === 0
                                  ? 'response__answer response__answer--streaming'
                                  : 'response__answer'
                              }
                            >
                              {streamingAnswer}
                            </p>
                          )}
                          {streamingWarnings.length > 0 && (
                            <ul className="response__warnings">
                              {streamingWarnings.map((w, i) => (
                                <li key={i}>⚠ {w}</li>
                              ))}
                            </ul>
                          )}
                          {streamingSteps.length > 0 && (
                            <ol className="response__steps">
                              {streamingSteps.map((s, i) => (
                                <li key={i}>
                                  <span
                                    className={
                                      i === streamingSteps.length - 1
                                        ? 'response__step-text response__step-text--streaming'
                                        : 'response__step-text'
                                    }
                                  >
                                    {s}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </div>
                      </article>
                    )}

                  {status.kind === 'done' && (
                    <ResponseCard
                      response={status.response}
                      timings={status.timings}
                      usedWebSearch={status.usedWebSearch}
                      sources={status.sources}
                      imageWidth={status.imageWidth}
                      imageHeight={status.imageHeight}
                    />
                  )}
                </div>
              )}
          </div>
        )}
      </div>

      {attachError && <div className="widget__attach-error">{attachError}</div>}

      {/* Mid-loop interrupt indicator — visible while a loop is running
          AFTER the user has typed an interrupt. Cleared when the next
          turn picks it up. Lets the user know their message is queued. */}
      {queuedInterrupt !== null && status.kind === 'looping' && (
        <div className="widget__interrupt-queued">
          ⏎ Queued for next turn: <em>{queuedInterrupt}</em>
        </div>
      )}

      {/* Composite prompt field: attachments tray + textarea share one
          framed container so thumbnails sit inside the input visually,
          freeing up vertical space in the body above. Falls back to a
          plain textarea look when no attachments are staged. */}
      <div
        className={`widget__prompt-wrap${attachments.length > 0 ? ' widget__prompt-wrap--has-attachments' : ''}`}
      >
        {(() => {
          // Slash menu opens whenever the prompt has an active
          // `/word` token at the cursor in any agent-loop mode
          // (Access OR Automate). Recording stays exclusive to
          // Automate, but referencing saved automations via
          // `/OA-{n}` is useful in both — composing routines into
          // ad-hoc Access prompts is one of the main reasons to
          // record them.
          if (mode !== 'action' && mode !== 'automate') return null;
          const slash = findActiveSlashToken(prompt, promptCursor);
          if (!slash) return null;
          const q = slash.query.toLowerCase();
          const filtered = q
            ? routineSummaries.filter(
                (s) =>
                  s.name.toLowerCase().includes(q) ||
                  s.originalPrompt.toLowerCase().includes(q),
              )
            : routineSummaries;
          return (
            <SlashMenu
              items={filtered}
              selectedIndex={slashSelectedIndex}
              onIndexChange={setSlashSelectedIndex}
              onPick={(s) => pickRoutineFromSlash(s, slash)}
              loading={routinesLoading}
              totalCount={routineSummaries.length}
              query={slash.query}
            />
          );
        })()}
        <AttachmentTray attachments={attachments} onRemove={removeAttachment} />
        {/* Prompt input is enabled during `looping` so the user can type a
            mid-loop interrupt; submit() routes it into the queue. All other
            busy states keep the input disabled. */}
        <PromptInput
          ref={promptInputRef}
          value={prompt}
          onChange={(v) => {
            setPrompt(v);
            // Resetting the highlight on every edit keeps stale
            // indices from carrying past a filter shrink. The menu
            // also clamps internally, but resetting feels snappier.
            setSlashSelectedIndex(0);
          }}
          onSubmit={submit}
          onCursorChange={setPromptCursor}
          disabled={isBusy && status.kind !== 'looping'}
          placeholder={
            // Per-mode hint so the placeholder matches the current
            // tab's behaviour. Type `/` in Access or Automate to
            // open the routine picker.
            mode === 'guide'
              ? "Ask about what's on your screen… e.g. 'How do I create an invoice here?'"
              : mode === 'action'
                ? "Tell the agent what to do… e.g. 'Open my desktop and create a folder called notes' — type / to invoke a saved automation"
                : "Record a new automation or invoke one with /OA-N… e.g. 'Open Firefox and check my unread emails'"
          }
          onIntercept={(e) => {
            // Only consume keys when the slash menu is actually open.
            // Slash menu is available in BOTH agent-loop modes.
            if (mode !== 'action' && mode !== 'automate') return false;
            const slash = findActiveSlashToken(prompt, promptCursor);
            if (!slash) return false;
            const q = slash.query.toLowerCase();
            const filtered = q
              ? routineSummaries.filter(
                  (s) =>
                    s.name.toLowerCase().includes(q) ||
                    s.originalPrompt.toLowerCase().includes(q),
                )
              : routineSummaries;
            if (e.key === 'ArrowDown') {
              setSlashSelectedIndex((i) =>
                Math.min(i + 1, Math.max(0, filtered.length - 1)),
              );
              return true;
            }
            if (e.key === 'ArrowUp') {
              setSlashSelectedIndex((i) => Math.max(i - 1, 0));
              return true;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              const picked = filtered[slashSelectedIndex];
              if (picked) {
                pickRoutineFromSlash(picked, slash);
              }
              return true;
            }
            if (e.key === 'Escape') {
              // Close the menu without nuking the user's whole
              // sentence — just remove the active /query token.
              promptInputRef.current?.replaceRange(slash.start, slash.end, '');
              return true;
            }
            return false;
          }}
        />
      </div>

      <div className="widget__actions">
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => void pickImages()}
          disabled={isBusy}
          title="Attach images"
          aria-label="Attach images"
        >
          📎
        </button>
        <button
          className="btn btn--primary"
          onClick={submit}
          disabled={(isBusy && status.kind !== 'looping') || !prompt.trim()}
          type="button"
        >
          {status.kind === 'capturing' && busySince !== null ? (
            <>Capturing… (<ElapsedSeconds since={busySince} />s)</>
          ) : status.kind === 'thinking' && busySince !== null ? (
            <>{rotatingMessage} (<ElapsedSeconds since={busySince} />s)</>
          ) : status.kind === 'awaiting-approval' ? (
            'Awaiting approval…'
          ) : status.kind === 'looping' && prompt.trim() ? (
            'Queue interrupt'
          ) : status.kind === 'looping' && busySince !== null ? (
            <>Working… (<ElapsedSeconds since={busySince} />s)</>
          ) : (
            // Static label in every non-busy state. The system decides
            // whether to actually capture under the hood (smart reuse
            // checks foreground HWND + cache age) — the user doesn't
            // need to know or choose.
            'Send'
          )}
        </button>
        <StopButton
          // Always rendered so the actions row layout is stable —
          // disabled greys out when nothing is in flight.
          enabled={isStoppable}
          // Pause is only meaningful inside an Access loop. The
          // 'thinking' / 'capturing' states are single-shot Ask
          // flows that have no boundary to park at — those just
          // get a single-click cancel.
          canPause={status.kind === 'looping'}
          paused={isPaused}
          onToggle={() => {
            if (isPaused) resumeLoop();
            else pauseLoop();
          }}
          onCancel={() => void stop()}
        />
      </div>
    </div>
  );
}
