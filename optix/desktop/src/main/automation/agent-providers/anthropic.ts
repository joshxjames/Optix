// Anthropic Computer Use adapter — wraps the `messages.create` API with
// the `computer_20251124` tool plus our four custom file tools, exposes
// the loop driver's generic interface.

import Anthropic from '@anthropic-ai/sdk';
import { app } from 'electron';
import { statSync } from 'node:fs';
import path from 'node:path';
import {
  AskUserActionSchema,
  ComputerToolActionSchema,
  FileToolActionSchema,
  LabelToolActionSchema,
  PlanToolActionSchema,
  ShellToolActionSchema,
  type AgentAction,
} from '@shared/schemas';
import { imageBytesToBase64 } from '@main/providers/base';
import { readPlanSync } from '@main/storage/plan-store';
import type {
  AgentInitOpts,
  AgentProviderAdapter,
  AgentToolResult,
  AgentToolUse,
  AgentTurnResult,
} from './types';

const COMPUTER_BETA = 'computer-use-2025-11-24';

// History-truncation policy — must match the legacy duck-typed
// behaviour in computer-loop.ts:71-72 (KEEP_FIRST_TURNS / KEEP_LAST_TURNS).
// Kept in sync until the loop driver migrates to the formal
// `truncateHistory` interface method (see types.ts TODO).
const KEEP_FIRST_TURNS = 2;
const KEEP_LAST_TURNS = 20;

// Anthropic image limits — rejects screenshots exceeding either bound.
// We pre-validate so a too-large screenshot degrades to a text fallback
// rather than hard-failing the turn.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB on the wire (post-base64)
const MAX_IMAGE_DIM_PX = 8000;

// Exported so the Optix Cloud adapter can build the same internal
// state shape and just swap the SDK client for one that talks to our
// Firebase relay.
export type AnthropicState = {
  client: Anthropic;
  modelId: string;
  imageWidth: number;
  imageHeight: number;
  workspaceFolder: string | null;
  messages: Anthropic.Messages.MessageParam[];
  /** Order-preserving list of tool_use ids from the most recent turn —
   *  used to build the next user message in the same order the model
   *  emitted. */
  pendingToolUseIds: string[];
  /** Successfully-parsed actions, keyed by tool_use_id. */
  pendingActions: Map<string, AgentAction>;
  /** tool_use ids that failed input validation; we synthesise an
   *  is_error tool_result for each so the model can self-correct. */
  pendingErrors: Map<string, string>;
  /** Cached active-plan snapshot. The plan can be 50KB+ and reading +
   *  re-serialising it on every step is wasteful when the user hasn't
   *  changed it. Cache it keyed by the plan file's mtime; re-read only
   *  when mtime changes. `mtimeMs === null` means we last observed no
   *  plan file. `content === null` paired with a numeric mtime means
   *  the file existed but parsed to nothing (corrupt JSON). */
  planCache: { mtimeMs: number | null; content: string | null };
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function getKnownFolders(): Record<string, string> {
  const out: Record<string, string> = {};
  const tryGet = (
    key: 'desktop' | 'documents' | 'downloads' | 'home' | 'pictures' | 'music' | 'videos',
    label: string,
  ): void => {
    try {
      out[label] = app.getPath(key);
    } catch {
      // skip
    }
  };
  tryGet('home', 'Home');
  tryGet('desktop', 'Desktop');
  tryGet('documents', 'Documents');
  tryGet('downloads', 'Downloads');
  tryGet('pictures', 'Pictures');
  tryGet('music', 'Music');
  tryGet('videos', 'Videos');
  return out;
}

/** Read the plan only when its on-disk mtime has changed since the
 *  last call for this state. Returns the cached content otherwise.
 *  A 50KB plan re-read every step adds up across long conversations;
 *  this collapses it to one cheap stat() per turn. */
function getCachedPlanContent(state: AnthropicState): string | null {
  let mtimeMs: number | null = null;
  try {
    const planPath = path.join(app.getPath('userData'), 'plans', 'current.json');
    mtimeMs = statSync(planPath).mtimeMs;
  } catch {
    // No plan file (or unreadable) — drop any cached content.
    if (state.planCache.mtimeMs !== null || state.planCache.content !== null) {
      state.planCache = { mtimeMs: null, content: null };
    }
    return null;
  }
  if (mtimeMs === state.planCache.mtimeMs) {
    return state.planCache.content;
  }
  const plan = readPlanSync();
  let rendered: string | null = null;
  if (plan) {
    const revisedNote = plan.updatedAt !== plan.createdAt ? '; revised since then' : '';
    rendered =
      `\n---\nActive plan (you set this previously and the user approved it${revisedNote}):\n\n${plan.content}\n\n` +
      'Continue executing this plan. The user already has it pinned in their UI — you do NOT need to re-screenshot the screen, re-list directories, or call any tool just to "read" or "describe" the plan. If the user asks what the plan is, answer directly from the text above. Only call `plan` again if scope genuinely changes.';
  }
  state.planCache = { mtimeMs, content: rendered };
  return rendered;
}

function buildSystemPrompt(
  workspaceFolder: string | null,
  cachedPlanBlock: string | null,
): string {
  const lines = [
    "You are Optix, an AI assistant that performs tasks on the user's computer.",
    '',
    'You have three surfaces:',
    '1. **File-system tools** (`list_directory`, `read_file`, `search_files`, `write_file`, `create_directory`) — fast and exact. Prefer these whenever the task can be done by reading, listing, searching, or modifying files directly.',
    '2. **`computer` tool** — primary tool for clicks, typing, scrolling, screenshots. Use this for visual UI work where there is no file-path equivalent.',
    '3. **Label-based tools** (`click_label`, `scroll_label`, `type_into_label`) — secondary fallback. Use when a coordinate-based `computer` click misses the intended target, or for elements whose pixel position is unstable (taskbar icons, system tray, dynamically-sized buttons). The host resolves the label via Windows UI Automation.',
    '',
    'Loop:',
    '1. Inspect the current state (screenshot for visual context, or file-system tools for content).',
    '2. Take ONE action. After each action you receive an updated screenshot or tool result.',
    '3. When the task is complete, reply with a brief plain-text summary and STOP using tools — that ends the session.',
    '4. If you hit an unrecoverable problem, describe it in a text reply and stop. Do not retry indefinitely.',
    '',
    'Coordinates: use the screenshot pixel coordinates directly — they map 1:1 to the screen.',
    '',
    'Tool input contract: when calling `write_file`, you MUST include the `content` field — pass an empty string if you genuinely want a zero-byte file. The user will see the byte count in the audit log.',
    '',
    "Safety: do NOT perform destructive operations (deleting files, sending messages, paying for things) unless the user's request explicitly asks for them. Prefer keyboard shortcuts (Win+R, Ctrl+S) over visual clicks when reliable.",
    '',
    'Inference over interrogation: when the user references something they recently created or asked about (e.g. "open that folder", "now add a file there"), default to the most recent matching subject without asking. Specifically: if you just created a directory and the next instruction implies file work, treat THAT directory as the working location for the next step — not the workspace root.',
    '',
    'Asking the user (`ask_user`): pause and ask ONLY when (a) the next action depends on information you cannot reliably infer, AND (b) guessing wrong would damage / cause rework / write to the wrong place. Do NOT ask for trivial reversible decisions, formatting choices, or anything you can derive from the screenshot, recent context, or known folders. Cap options at 4 concrete answers. When you do ask, keep the question to one sentence.',
    '',
    'Planning (`plan`): for complex multi-step tasks (coding, multi-file edits, long automation chains, anything where the user benefits from seeing your approach upfront), call `plan` first with a numbered list of concrete steps before executing. The user approves, denies, or sends feedback. Skip the plan tool entirely for trivial single-action tasks (one click, one file read, one quick lookup). Only one plan exists at a time — calling `plan` again overwrites the saved plan, which is the right move when scope changes mid-task or the user pushes back. Reference the plan implicitly while executing (you don\'t need to re-read it aloud each turn) and revise it if you discover the original approach won\'t work.',
    '',
    'Running commands (`run_command`): prefer this over opening a terminal visually whenever you need to run a non-interactive shell command — package installs, tests, builds, git ops, batch file ops. Pass `cwd` explicitly when path-sensitive; without one we default to the workspace folder, falling back to the home dir. Output (stdout + stderr + exit code) comes back as the tool_result so you can read it. AVOID interactive REPLs (sudo, ssh password, npm init prompts) and long-running services (`npm run dev`, watchers) — they\'ll hang and timeout. For anything destructive (rm, mv, force-push), pause first via `ask_user` to confirm.',
  ];
  const known = getKnownFolders();
  if (Object.keys(known).length > 0) {
    lines.push('');
    lines.push("Known folder paths on this machine (use these, don't guess):");
    for (const [name, p] of Object.entries(known)) {
      lines.push(`  ${name}: ${p}`);
    }
  }
  if (workspaceFolder) {
    lines.push('');
    // JSON-encode the path so backticks/newlines/quotes in a malicious or
    // unusual workspace path can't break out of the markdown code span
    // and corrupt the rest of the prompt. JSON.stringify wraps in double
    // quotes and escapes `\n`, `"`, and control chars — the prompt
    // becomes `Workspace: "C:\\path\\with\\\"quotes\\\""`, which is
    // unambiguous to the model and can't inject into surrounding text.
    lines.push(
      `Workspace: ${JSON.stringify(workspaceFolder)}. Stay inside this folder for file-system actions whenever possible. Any file action targeting a path outside this folder will be paused for explicit user approval — regardless of the user's other approval settings — so plan accordingly and only step outside when the task genuinely requires it.`,
    );
  }
  if (cachedPlanBlock) {
    lines.push('');
    lines.push(cachedPlanBlock);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function buildFileTools(): unknown[] {
  return [
    {
      name: 'list_directory',
      description:
        'List the contents of a directory. Returns one line per entry: type tag (D=dir, F=file, L=symlink), size in bytes for files, and the entry name. Capped at ~500 entries.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to list.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'read_file',
      description:
        'Read the full contents of a UTF-8 text file. Files larger than 100 KB are rejected — use this for source files, configs, docs, not binary blobs.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search_files',
      description:
        'Recursively search for filenames matching a pattern under a root directory. Pattern is glob-like (`*.json`, `**/foo.ts`) or a plain substring (case-insensitive). Skips hidden, node_modules, __pycache__. Capped at 200 results, depth 8.',
      input_schema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Absolute path of the directory to search under.' },
          pattern: { type: 'string', description: 'Glob (`*.md`, `**/*.test.ts`) or plain substring.' },
        },
        required: ['root', 'pattern'],
      },
    },
    {
      name: 'write_file',
      description:
        'Write a UTF-8 text file. Overwrites if it exists, creates if not. Will create at most one missing parent directory level. Always requires explicit user approval before executing.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to write.' },
          content: { type: 'string', description: 'Full content to write.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'create_directory',
      description:
        'Create a directory at the given path. Creates any missing parents recursively. No-op if the directory already exists.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to create.' },
        },
        required: ['path'],
      },
    },
    // ---- Label-based tools (fallback when computer-tool clicks miss) ------
    {
      name: 'click_label',
      description:
        'Click a UI element by its visible label or accessibility name. The host resolves the label to coordinates via Windows UI Automation. Use as a fallback if a normal computer-tool click misses the intended target, or for taskbar / system-tray icons whose pixel positions vary.',
      input_schema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Visible text or accessibility name.' },
        },
        required: ['label'],
      },
    },
    {
      name: 'scroll_label',
      description:
        'Scroll on a UI element identified by its visible label. Useful when the target scroll container has a name.',
      input_schema: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number' },
        },
        required: ['label', 'direction', 'amount'],
      },
    },
    {
      name: 'type_into_label',
      description:
        'Click the labelled element to focus it, then type the given text into it.',
      input_schema: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['label', 'text'],
      },
    },
    // ---- Shell tool — run non-interactive commands ----------------------
    {
      name: 'run_command',
      description:
        'Execute a non-interactive shell command on the user\'s machine. Output (stdout + stderr) is returned to you, truncated from the start if very large. ' +
        'USE THIS for: package installs (npm install, pip install), tests (pytest, npm test), build commands, git ops, file batch ops your file tools can\'t cover, anything you\'d otherwise type into a terminal manually. ' +
        'Each command requires user approval (per-task and per-action modes both gate it; "never" mode runs it). Out-of-workspace `cwd` always gates regardless of mode. ' +
        'DO NOT use for interactive REPLs / prompts (npm init, ssh password, sudo) — they\'ll hang and time out. ' +
        'DO NOT use for long-running services (npm run dev, watchers) — those exceed the timeout. ' +
        'Specify `cwd` explicitly when the command is path-sensitive. When a workspace folder is set, prefer running inside it.',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command line. `&&`, `|`, `>` work as the OS shell expects.',
          },
          cwd: {
            type: 'string',
            description: 'Absolute path to run in. Defaults to the workspace folder when set, else the user\'s home directory.',
          },
          timeoutMs: {
            type: 'number',
            description: 'Hard timeout in milliseconds. Capped at 120000 (2 minutes); default 60000.',
          },
        },
        required: ['command'],
      },
    },
    // ---- Plan tool — propose a structured plan before complex work -----
    {
      name: 'plan',
      description:
        'Write or revise a structured plan for the current task BEFORE executing actions. ' +
        'USE THIS for complex multi-step tasks (coding, multi-file edits, long automation chains, anything where the user benefits from seeing your approach upfront). ' +
        'Skip it for trivial single-action tasks. ' +
        'Only one plan exists at a time — calling this again overwrites the saved plan, which is the right move when scope changes mid-task. ' +
        'The user is shown the plan and asked to approve, deny, or send feedback. On approval the plan persists and is echoed back to you so you can refer to it as you execute. On deny or feedback you should revise and call `plan` again.',
      input_schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              'Markdown body of the plan. A numbered or bulleted list of concrete steps works best. Be specific — what file/path/command, not just "edit code".',
          },
          rationale: {
            type: 'string',
            description:
              'Optional one-line note on why this plan was created or revised (e.g. "user clarified target directory", "adding step for the test failure"). Helps the user follow plan evolution.',
          },
        },
        required: ['content'],
      },
    },
    // ---- Meta tools — pause the loop for direct user interaction --------
    {
      name: 'ask_user',
      description:
        'Pause and ask the user a clarifying question with a small set of pre-written answer options. ' +
        'USE THIS ONLY when the next action depends on information you cannot reliably infer from the screenshot, recent context, or the user\'s prompt — and where guessing wrong would cause damage, rework, or wrong-place file writes. ' +
        'Do NOT use for trivial reversible decisions, formatting choices, or anything you can derive yourself. Prefer inferring from context (e.g. "the folder I just created" implies that folder is the working location for the next step). ' +
        'Provide between 1 and 4 concrete `options` covering the realistic answers; set `allowFreeform: true` only when the answer is genuinely open-ended. The selected option\'s `value` is what comes back to you on the next turn.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One sentence — the question shown to the user.' },
          options: {
            type: 'array',
            maxItems: 4,
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Button text the user sees.' },
                value: { type: 'string', description: 'String returned to you when picked.' },
                description: { type: 'string', description: 'Optional small text under the label.' },
              },
              required: ['label', 'value'],
            },
          },
          allowFreeform: { type: 'boolean', description: 'Add a free-text input below the options.' },
        },
        required: ['question', 'options'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool-use parsing
// ---------------------------------------------------------------------------

type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

function parseToolUse(tu: Anthropic.Messages.ToolUseBlock): ParseResult {
  try {
    if (tu.name === 'computer') {
      return {
        ok: true,
        action: { tool: 'computer', data: ComputerToolActionSchema.parse(tu.input) },
      };
    }
    const fileToolNames = [
      'list_directory',
      'read_file',
      'search_files',
      'write_file',
      'create_directory',
    ] as const;
    if ((fileToolNames as readonly string[]).includes(tu.name)) {
      const data = FileToolActionSchema.parse({
        action: tu.name,
        ...(tu.input as Record<string, unknown>),
      });
      return { ok: true, action: { tool: 'file', data } };
    }
    const labelToolNames = ['click_label', 'scroll_label', 'type_into_label'] as const;
    if ((labelToolNames as readonly string[]).includes(tu.name)) {
      const data = LabelToolActionSchema.parse({
        action: tu.name,
        ...(tu.input as Record<string, unknown>),
      });
      return { ok: true, action: { tool: 'label', data } };
    }
    if (tu.name === 'ask_user') {
      const data = AskUserActionSchema.parse({
        action: 'ask_user',
        ...(tu.input as Record<string, unknown>),
      });
      return { ok: true, action: { tool: 'meta', data } };
    }
    if (tu.name === 'plan') {
      const data = PlanToolActionSchema.parse({
        action: 'set_plan',
        ...(tu.input as Record<string, unknown>),
      });
      return { ok: true, action: { tool: 'plan', data } };
    }
    if (tu.name === 'run_command') {
      const data = ShellToolActionSchema.parse({
        action: 'run_command',
        ...(tu.input as Record<string, unknown>),
      });
      return { ok: true, action: { tool: 'shell', data } };
    }
    return { ok: false, error: `Unknown tool: ${tu.name}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid input for tool "${tu.name}": ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Image helpers + prompt-cache helpers
// ---------------------------------------------------------------------------

function bytesToImageBlock(
  bytes: Uint8Array,
  mimeType: string,
): Anthropic.Messages.ImageBlockParam {
  const media: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' =
    mimeType === 'image/png' || mimeType === 'image/webp' || mimeType === 'image/gif'
      ? mimeType
      : 'image/jpeg';
  return {
    type: 'image',
    source: { type: 'base64', media_type: media, data: imageBytesToBase64(bytes) },
  };
}

/** Read PNG / JPEG dimensions from the first few header bytes without
 *  pulling in a full decoder. Returns `null` if the format isn't
 *  recognised — caller treats that as "skip the dim check, still
 *  enforce byte length". This is intentionally minimal: Optix only
 *  ever ships PNG screenshots from the renderer; the JPEG branch is
 *  defensive against future format changes. */
function readImageDims(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR width/height at
  // offsets 16 (width) and 20 (height) as big-endian uint32.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  // JPEG: walk segments until SOF0/SOF2 marker (0xFFC0..0xFFC3, C5..C7,
  // C9..CB, CD..CF). Bail at first SOI mismatch.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === undefined) return null;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
        const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
        return { width, height };
      }
      const segLen = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      if (segLen < 2) return null;
      i += 2 + segLen;
    }
  }
  return null;
}

/** Pre-validate a screenshot against Anthropic's hard limits (5 MB on
 *  the wire post-base64, 8000 px on either axis). Returns either a
 *  ready-to-use image block, or a one-line reason string the caller
 *  can surface as a text-only tool_result so the loop survives.
 *  We deliberately do NOT downscale — that's the renderer's job; this
 *  is just graceful degradation when the renderer hands us something
 *  oversized (extremely large external monitors, mis-configured DPI). */
function tryImageBlockOrReason(
  bytes: Uint8Array,
  mimeType: string,
):
  | { ok: true; block: Anthropic.Messages.ImageBlockParam }
  | { ok: false; reason: string } {
  const dims = readImageDims(bytes);
  if (dims && (dims.width > MAX_IMAGE_DIM_PX || dims.height > MAX_IMAGE_DIM_PX)) {
    return {
      ok: false,
      reason: `screenshot too large to send (${dims.width}x${dims.height} px, Anthropic max ${MAX_IMAGE_DIM_PX}px on either axis)`,
    };
  }
  // base64 inflates by 4/3; check post-encoding byte length.
  const approxB64Len = Math.ceil(bytes.byteLength / 3) * 4;
  if (approxB64Len > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `screenshot too large to send (${(approxB64Len / 1024 / 1024).toFixed(2)} MB after base64, Anthropic max 5 MB)`,
    };
  }
  return { ok: true, block: bytesToImageBlock(bytes, mimeType) };
}

/** Place a `cache_control: { type: 'ephemeral' }` marker on the last
 *  block of the LAST STABLE user message — i.e. the most recent user
 *  message whose contents won't change on the next turn. Marking the
 *  most-recent-user-message-period would attach the marker to the
 *  tool_results block we're about to generate, which churns the cache
 *  every turn (each new tool_result becomes a fresh cache entry).
 *
 *  Anthropic semantics: a `cache_control` marker says "everything up to
 *  and including this block is cacheable". So we want the marker on
 *  the LATEST block whose prefix is stable across the whole loop —
 *  ideally the message just before the most recent user message. For
 *  short conversations we still cache from the system prompt (handled
 *  separately in `step()`); this function only matters once we have
 *  enough history to justify a second cache point. */
function withMessageCachePoint(
  messages: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  if (messages.length < 3) return messages;
  // Skip the LAST user message (its content was generated this turn or
  // is about to change next turn) and find the prior user message —
  // that one's contents are now frozen for the rest of the loop.
  let lastUserIdx = -1;
  let stableUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (lastUserIdx === -1) {
        lastUserIdx = i;
      } else {
        stableUserIdx = i;
        break;
      }
    }
  }
  if (stableUserIdx === -1) return messages;
  return messages.map((m, i) => {
    if (i !== stableUserIdx) return m;
    if (typeof m.content === 'string') {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } } as any,
        ],
      };
    }
    if (!Array.isArray(m.content) || m.content.length === 0) return m;
    const newContent = m.content.map((b, bi) =>
      bi === m.content.length - 1
        ? ({ ...b, cache_control: { type: 'ephemeral' } } as any)
        : b,
    );
    return { ...m, content: newContent };
  });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const anthropicAgentAdapter: AgentProviderAdapter<AnthropicState> = {
  id: 'anthropic',

  init(opts: AgentInitOpts): AnthropicState {
    const userContent: Array<
      Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam
    > = [];
    // Pre-validate the initial screenshot — graceful degrade rather than
    // hard-fail if the renderer hands us something oversized.
    const initImg = tryImageBlockOrReason(opts.imageBytes, opts.imageMimeType);
    if (initImg.ok) {
      userContent.push(initImg.block);
    } else {
      console.warn(`[optix-anthropic-cu] init: ${initImg.reason}`);
      userContent.push({ type: 'text', text: `[${initImg.reason}]` });
    }
    for (const att of opts.imageAttachments ?? []) {
      const attImg = tryImageBlockOrReason(att.bytes, att.mimeType);
      if (attImg.ok) {
        userContent.push(attImg.block);
      } else {
        console.warn(`[optix-anthropic-cu] init attachment: ${attImg.reason}`);
        userContent.push({ type: 'text', text: `[attachment skipped — ${attImg.reason}]` });
      }
    }
    userContent.push({ type: 'text', text: opts.prompt });
    return {
      client: new Anthropic({ apiKey: opts.apiKey }),
      modelId: opts.modelId,
      imageWidth: opts.imageWidth,
      imageHeight: opts.imageHeight,
      workspaceFolder: opts.workspaceFolder,
      messages: [{ role: 'user', content: userContent }],
      pendingToolUseIds: [],
      pendingActions: new Map(),
      pendingErrors: new Map(),
      planCache: { mtimeMs: null, content: null },
    };
  },

  async step(state: AnthropicState, abortSignal: AbortSignal): Promise<AgentTurnResult> {
    // The `computer` tool's display_width_px / display_height_px change
    // when the user resizes their screen mid-conversation (or
    // appendUserTurn lands a new screenshot at a different size).
    // Anthropic's `cache_control` marks "everything up to and including
    // this block is cacheable", so the computer tool MUST sit AFTER the
    // tool-list cache marker — otherwise a single dim change invalidates
    // the cached tool prefix every turn.
    //
    // Order: stable file/meta tools FIRST (with cache marker on the last
    // one so the whole stable prefix is cached), then the volatile
    // computer tool LAST (uncached).
    const fileTools = buildFileTools();
    const computerTool = {
      type: 'computer_20251124',
      name: 'computer',
      display_width_px: state.imageWidth,
      display_height_px: state.imageHeight,
    };
    const tools = [
      ...fileTools.map((t, i, arr) =>
        i === arr.length - 1
          ? ({ ...(t as any), cache_control: { type: 'ephemeral' } })
          : t,
      ),
      computerTool,
    ];
    // System prompt block — also marked. The plan-block portion of the
    // system prompt is cached against its mtime in `state.planCache`,
    // so this whole text only changes when the plan file changes (or
    // the workspace folder rotates).
    const system = [
      {
        type: 'text',
        text: buildSystemPrompt(state.workspaceFolder, getCachedPlanContent(state)),
        cache_control: { type: 'ephemeral' },
      },
    ];

    const t0 = performance.now();
    const final = await state.client.messages.create(
      {
        model: state.modelId,
        max_tokens: 2048,
        system,
        tools,
        messages: withMessageCachePoint(state.messages),
      } as any,
      {
        signal: abortSignal,
        headers: { 'anthropic-beta': COMPUTER_BETA },
      },
    );
    const apiMs = Math.round(performance.now() - t0);

    // Extract tool_use blocks; route through parseToolUse so bad inputs
    // become tool_result errors instead of crashing the loop.
    const allToolUseBlocks = final.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );
    const toolUses: AgentToolUse[] = [];
    const parseErrors = new Map<string, string>();
    for (const tu of allToolUseBlocks) {
      const r = parseToolUse(tu);
      if (r.ok) {
        toolUses.push({ id: tu.id, action: r.action });
      } else {
        parseErrors.set(tu.id, r.error);
        console.warn(
          `[optix-anthropic-cu] tool_use ${tu.id} (${tu.name}) failed parse: ${r.error}`,
        );
      }
    }

    const finalText = final.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    // Echo the assistant turn into the conversation so the next user turn
    // can pair tool_results with the correct ids.
    state.messages.push({ role: 'assistant', content: final.content });

    const allIds = allToolUseBlocks.map((b) => b.id);
    state.pendingToolUseIds = allIds;
    state.pendingActions = new Map(toolUses.map((tu) => [tu.id, tu.action]));
    state.pendingErrors = parseErrors;

    // Branch on stop_reason — the `done` decision can't be derived from
    // tool_use count alone (e.g. `max_tokens` mid-tool_use truncates the
    // turn and we should NOT continue executing a partial tool).
    //
    // Anthropic stop_reason values:
    //   end_turn       — model finished naturally; done.
    //   stop_sequence  — hit a stop sequence; done.
    //   tool_use       — at least one tool_use emitted; continue.
    //   max_tokens     — output cap hit; done with note (model was cut
    //                    off mid-response — partial tool_uses unsafe to
    //                    execute, surface the warning instead).
    //   pause_turn     — Anthropic added this for very long tool_use
    //                    chains; the model paused and wants to resume.
    //                    Continue but log so the audit shows it.
    let done: boolean;
    let stopNote: string | undefined;
    // Cast to string so the switch can accept stop_reason values the
    // SDK's union type doesn't yet enumerate (e.g. `pause_turn` was
    // added to the API before our SDK pin caught up). Treat unknown
    // values defensively in `default`.
    const stopReason: string | null = final.stop_reason ?? null;
    switch (stopReason) {
      case 'end_turn':
      case 'stop_sequence':
        done = true;
        break;
      case 'tool_use':
        done = allIds.length === 0;
        break;
      case 'max_tokens':
        console.warn(
          `[optix-anthropic-cu] stop_reason=max_tokens — model truncated mid-response (toolUses=${allIds.length}); treating as done.`,
        );
        done = true;
        stopNote = '(model output truncated by max_tokens — response may be incomplete)';
        break;
      case 'pause_turn':
        console.log('[optix-anthropic-cu] stop_reason=pause_turn — continuing.');
        done = allIds.length === 0;
        break;
      default:
        if (stopReason) {
          console.warn(
            `[optix-anthropic-cu] unknown stop_reason=${stopReason}; defaulting to tool_use count.`,
          );
        }
        done = allIds.length === 0;
        break;
    }

    const baseFinal = done ? finalText || '(no further actions)' : finalText || undefined;
    const composedFinal = stopNote
      ? baseFinal
        ? `${baseFinal}\n\n${stopNote}`
        : stopNote
      : baseFinal;

    return {
      toolUses,
      parseErrorIds: Array.from(parseErrors.keys()),
      finalText: composedFinal,
      done,
      apiMs,
      stopReason: final.stop_reason ?? undefined,
      inputTokens: final.usage?.input_tokens,
      outputTokens: final.usage?.output_tokens,
      cacheCreationInputTokens: (final.usage as any)?.cache_creation_input_tokens,
      cacheReadInputTokens: (final.usage as any)?.cache_read_input_tokens,
    };
  },

  appendResults(
    state: AnthropicState,
    results: AgentToolResult[],
    opts?: { extraUserText?: string },
  ): void {
    const byId = new Map(results.map((r) => [r.toolUseId, r]));
    // Validate every renderer-supplied result against the pending-id set.
    // The loop driver already does an outer check, but a defensive guard
    // here means a future caller (or test harness) can't sneak an orphan
    // tool_use_id into the conversation — Anthropic's API would reject
    // the next request with a 400 and a confusing trace. Drop orphans
    // with a clear log line instead.
    const pendingSet = new Set(state.pendingToolUseIds);
    for (const r of results) {
      if (!pendingSet.has(r.toolUseId)) {
        console.error(
          `[optix-anthropic-cu] dropping orphan tool_result for id=${r.toolUseId} (not in pending set; pending=[${state.pendingToolUseIds.join(',')}])`,
        );
        byId.delete(r.toolUseId);
      }
    }
    const blocks: Array<
      Anthropic.Messages.ToolResultBlockParam | Anthropic.Messages.TextBlockParam
    > = [];
    // Walk the model's emitted order so the user message mirrors it.
    for (const id of state.pendingToolUseIds) {
      // Defend against a renderer that pairs a screenshot with a
      // non-computer action — e.g. file/shell tool results don't
      // semantically carry a screenshot, and feeding one back as a
      // tool_result image would confuse the model into thinking the
      // file/shell call returned an image. Drop the bytes; keep the
      // text/error path.
      const action = state.pendingActions.get(id);
      const r0 = byId.get(id);
      if (r0?.screenshotBytes && action && action.tool !== 'computer') {
        console.warn(
          `[optix-anthropic-cu] dropping screenshot bytes paired with non-computer action (tool=${action.tool}, id=${id}).`,
        );
        delete (r0 as { screenshotBytes?: Uint8Array }).screenshotBytes;
        delete (r0 as { screenshotMimeType?: string }).screenshotMimeType;
      }
      const parseErr = state.pendingErrors.get(id);
      if (parseErr) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: id,
          content: parseErr,
          is_error: true,
        });
        continue;
      }
      const r = byId.get(id);
      if (!r) {
        // Pending id with no matching result — synthesise an explicit
        // is_error tool_result so the model can self-correct instead
        // of seeing a silent gap. The loop driver pre-validates this,
        // but races / future refactors could open the gap; defending
        // the protocol invariant locally is cheap.
        console.error(
          `[optix-anthropic-cu] no result for pending tool_use id=${id}; emitting is_error placeholder.`,
        );
        blocks.push({
          type: 'tool_result',
          tool_use_id: id,
          content: 'result missing',
          is_error: true,
        });
        continue;
      }
      if (r.errorText) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: id,
          content: r.errorText,
          is_error: true,
        });
      } else if (r.screenshotBytes && r.screenshotMimeType) {
        // Pre-validate dimensions + size. If the screenshot would be
        // rejected by Anthropic (>5MB or >8000px on either axis), fall
        // back to a text-only result describing why so the loop
        // survives. Renderer should ideally never feed us oversize
        // images — this is defensive degradation.
        const blk = tryImageBlockOrReason(r.screenshotBytes, r.screenshotMimeType);
        if (blk.ok) {
          blocks.push({
            type: 'tool_result',
            tool_use_id: id,
            content: [blk.block],
          });
        } else {
          console.warn(`[optix-anthropic-cu] tool_result image rejected: ${blk.reason}`);
          blocks.push({
            type: 'tool_result',
            tool_use_id: id,
            content: blk.reason,
          });
        }
      } else if (r.text) {
        blocks.push({ type: 'tool_result', tool_use_id: id, content: r.text });
      } else {
        blocks.push({ type: 'tool_result', tool_use_id: id, content: '' });
      }
    }
    // Mid-loop user interrupt — appended as a trailing text block to the
    // same user message as the tool_results. Anthropic's protocol allows
    // mixing tool_result and text blocks within one user message; this
    // is the cheapest way to make the agent re-read its plan without
    // restructuring the conversation history.
    if (opts?.extraUserText && opts.extraUserText.trim().length > 0) {
      blocks.push({
        type: 'text',
        text: `[User interrupt — read this BEFORE continuing the task]\n${opts.extraUserText.trim()}`,
      });
    }
    state.messages.push({
      role: 'user',
      // The SDK's TS for `content` is the tool_result block type only,
      // but the API accepts mixed tool_result + text blocks at runtime.
      // `as any` is the cleanest way to satisfy the older type defs.
      content: blocks as any,
    });
    state.pendingToolUseIds = [];
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },

  appendUserTurn(state: AnthropicState, opts): void {
    // Append a fresh user-role message — image first (if present), then
    // any uploaded attachments, then prompt text. Mirrors the init-time
    // message construction so the agent reads it the same way.
    const content: Array<
      Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam
    > = [];
    if (opts.imageBytes && opts.imageMimeType) {
      const blk = tryImageBlockOrReason(opts.imageBytes, opts.imageMimeType);
      if (blk.ok) {
        content.push(blk.block);
      } else {
        console.warn(`[optix-anthropic-cu] appendUserTurn screenshot: ${blk.reason}`);
        content.push({ type: 'text', text: `[${blk.reason}]` });
      }
    }
    for (const att of opts.imageAttachments ?? []) {
      const blk = tryImageBlockOrReason(att.bytes, att.mimeType);
      if (blk.ok) {
        content.push(blk.block);
      } else {
        console.warn(`[optix-anthropic-cu] appendUserTurn attachment: ${blk.reason}`);
        content.push({ type: 'text', text: `[attachment skipped — ${blk.reason}]` });
      }
    }
    content.push({ type: 'text', text: opts.prompt });
    state.messages.push({ role: 'user', content });
    // Update display dims to the new screenshot's size so the computer
    // tool's coordinate space matches what the agent now sees.
    if (opts.imageWidth && opts.imageHeight) {
      state.imageWidth = opts.imageWidth;
      state.imageHeight = opts.imageHeight;
    }
    // Pending state should already be empty when we arrive here (the
    // loop reached `done` and resolved all tool_uses); reset defensively.
    state.pendingToolUseIds = [];
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },

  /** BYO-key path: re-create the SDK client with the new key. The
   *  Optix Cloud adapter overrides this in its own object to point at
   *  the Firebase relay (see `optix-cloud.ts: refreshCredential`); this
   *  base implementation is for direct-Anthropic users whose API key
   *  doesn't expire mid-session, but implementing it keeps the
   *  interface symmetric and lets a future "rotate API key" feature
   *  land without re-architecting. */
  refreshCredential(state: AnthropicState, credential: string): void {
    state.client = new Anthropic({ apiKey: credential });
  },

  /** Drop middle history when the loop driver notices we're approaching
   *  the soft token cap. Keeps the first KEEP_FIRST_TURNS + last
   *  KEEP_LAST_TURNS messages — same policy the legacy duck-typed
   *  truncation in computer-loop.ts:144-167 used to enforce. The
   *  system prompt lives outside `messages` and is unaffected. */
  truncateHistory(state: AnthropicState): void {
    const total = state.messages.length;
    if (total <= KEEP_FIRST_TURNS + KEEP_LAST_TURNS) return;
    const head = state.messages.slice(0, KEEP_FIRST_TURNS);
    const tail = state.messages.slice(total - KEEP_LAST_TURNS);
    const dropped = total - head.length - tail.length;
    state.messages = [...head, ...tail];
    console.warn(
      `[optix-anthropic-cu] history truncated: dropped ${dropped} middle messages ` +
        `(kept first ${head.length} + last ${tail.length} of ${total}).`,
    );
  },
};
