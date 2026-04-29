// OpenAI Computer Use adapter — uses the Responses API with the
// `computer_use_preview` tool. Conversation is stateless (we resend the
// full input array each turn) for parity with the Anthropic adapter and
// so the audit log captures everything.
//
// Why fetch and not the SDK: the openai npm package version we ship
// (v4.73.1) doesn't yet include the Responses API namespace. Calling the
// HTTPS endpoint directly avoids forcing an SDK upgrade and gives us
// full control of the request shape.

import { app } from 'electron';
import {
  AskUserActionSchema,
  ComputerToolActionSchema,
  FileToolActionSchema,
  LabelToolActionSchema,
  PlanToolActionSchema,
  ShellToolActionSchema,
  type AgentAction,
  type ComputerToolAction,
} from '@shared/schemas';
import { imageBytesToDataUrl } from '@main/providers/base';
import { readPlanSync } from '@main/storage/plan-store';
import type {
  AgentInitOpts,
  AgentProviderAdapter,
  AgentToolResult,
  AgentToolUse,
  AgentTurnResult,
} from './types';

const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

// Items the Responses API stores in `input` and emits in `output`. We
// only care about the discriminator, so it's typed loosely.
type ResponseItem = Record<string, any>;

type OpenAIState = {
  apiKey: string;
  modelId: string;
  imageWidth: number;
  imageHeight: number;
  instructions: string;
  /** Cumulative list of items we send on every request — initial user
   *  message, then assistant output items from each turn, then tool
   *  outputs we feed back. */
  input: ResponseItem[];
  /** Successfully-parsed tool calls from the most recent assistant turn,
   *  keyed by call_id. */
  pendingActions: Map<string, AgentAction>;
  /** call_ids that failed input validation; synthesised as error
   *  function_call_output / computer_call_output blocks on the next turn. */
  pendingErrors: Map<string, string>;
  /** Order-preserving list of call_ids from the most recent turn. */
  pendingCallIds: string[];
  /** call_id → 'computer' | 'function'. Lets `appendResults` build the
   *  right output item type without re-walking the input array. */
  pendingCallKind: Map<string, 'computer' | 'function'>;
};

// ---------------------------------------------------------------------------
// System / instructions builder (mirrors Anthropic adapter prose, retuned
// for the OpenAI tool naming).
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

function buildInstructions(workspaceFolder: string | null): string {
  const lines = [
    "You are Optix, an AI assistant that performs tasks on the user's computer.",
    '',
    'You have three surfaces:',
    '1. **File-system tools** (`list_directory`, `read_file`, `search_files`, `write_file`, `create_directory`) — fast and exact. Prefer these whenever the task can be done by reading, listing, searching, or modifying files directly.',
    '2. **`computer_use_preview` tool** — primary tool for visual UI work where there is no file-path equivalent.',
    '3. **Label-based tools** (`click_label`, `scroll_label`, `type_into_label`) — secondary fallback. Use when a computer-tool click misses, or for icons/buttons whose pixel positions are unstable (taskbar, system tray). The host resolves the label via Windows UI Automation.',
    '',
    'Loop:',
    '1. Inspect the current state.',
    '2. Take ONE action. After each action you receive an updated screenshot or tool result.',
    '3. When the task is complete, reply with a brief plain-text summary and STOP using tools.',
    '4. If you hit an unrecoverable problem, describe it in a text reply and stop.',
    '',
    'Coordinates: use the screenshot pixel coordinates directly — they map 1:1 to the screen.',
    '',
    'Tool input contract: when calling `write_file`, you MUST include the `content` field — pass an empty string if you genuinely want a zero-byte file.',
    '',
    "Safety: do NOT perform destructive operations unless the user's request explicitly asks for them.",
    '',
    'Inference over interrogation: when the user references something they recently created or asked about (e.g. "open that folder", "now add a file there"), default to the most recent matching subject without asking. Specifically: if you just created a directory and the next instruction implies file work, treat THAT directory as the working location for the next step — not the workspace root.',
    '',
    'Asking the user (`ask_user`): pause and ask ONLY when (a) the next action depends on information you cannot reliably infer, AND (b) guessing wrong would damage / cause rework / write to the wrong place. Do NOT ask for trivial reversible decisions or anything you can derive from context. Cap options at 4 concrete answers. Keep the question to one sentence.',
    '',
    'Planning (`plan`): for complex multi-step tasks (coding, multi-file edits, long automation), call `plan` first with a numbered list of concrete steps before executing. The user approves, denies, or sends feedback. Skip planning for trivial single-action tasks. Only one plan exists at a time — calling `plan` again overwrites it, which is right when scope changes mid-task. Revise the plan if the original approach won\'t work.',
    '',
    'Running commands (`run_command`): prefer this over opening a terminal visually for non-interactive shell work — installs, tests, builds, git, batch file ops. Pass `cwd` explicitly when path-sensitive; default cwd is the workspace folder (or home dir if none). Avoid interactive REPLs and long-running services — they\'ll timeout. For destructive commands (rm, force-push), confirm via `ask_user` first.',
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
    lines.push(
      `Workspace: \`${workspaceFolder}\`. Stay inside this folder for file-system actions whenever possible. Any file action targeting a path outside this folder will be paused for explicit user approval — regardless of the user's other approval settings.`,
    );
  }
  const plan = readPlanSync();
  if (plan) {
    lines.push('');
    lines.push('---');
    lines.push(
      `Active plan (you set this previously and the user approved it${plan.updatedAt !== plan.createdAt ? '; revised since then' : ''}):`,
    );
    lines.push('');
    lines.push(plan.content);
    lines.push('');
    lines.push(
      'Continue executing this plan. The user already has it pinned in their UI — you do NOT need to re-screenshot or call any tool just to "read" or "describe" the plan. If the user asks what the plan is, answer directly from the text above. Only call `plan` again if scope genuinely changes.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definitions (Responses-API shape: `computer_use_preview` for the
// agent tool, plain `function` types for our file tools).
// ---------------------------------------------------------------------------

function buildTools(displayWidth: number, displayHeight: number): unknown[] {
  return [
    {
      type: 'computer_use_preview',
      display_width: displayWidth,
      display_height: displayHeight,
      environment: 'windows',
    },
    {
      type: 'function',
      name: 'list_directory',
      description:
        'List the contents of a directory. Returns one line per entry: type tag (D=dir, F=file, L=symlink), size in bytes for files, and the entry name. Capped at ~500 entries.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to list.' },
        },
        required: ['path'],
      },
    },
    {
      type: 'function',
      name: 'read_file',
      description:
        'Read the full contents of a UTF-8 text file. Files larger than 100 KB are rejected.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to read.' },
        },
        required: ['path'],
      },
    },
    {
      type: 'function',
      name: 'search_files',
      description:
        'Recursively search for filenames matching a pattern under a root directory. Pattern is glob-like or a plain substring (case-insensitive). Capped at 200 results, depth 8.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Absolute path of the directory to search under.' },
          pattern: { type: 'string', description: 'Glob (`*.md`) or plain substring.' },
        },
        required: ['root', 'pattern'],
      },
    },
    {
      type: 'function',
      name: 'write_file',
      description:
        'Write a UTF-8 text file. Overwrites if it exists. Creates at most one missing parent directory level.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the file to write.' },
          content: { type: 'string', description: 'Full content to write.' },
        },
        required: ['path', 'content'],
      },
    },
    {
      type: 'function',
      name: 'create_directory',
      description:
        'Create a directory at the given path. Creates any missing parents recursively.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to create.' },
        },
        required: ['path'],
      },
    },
    // ---- Label-based tools (fallback when computer-tool clicks miss) ------
    {
      type: 'function',
      name: 'click_label',
      description:
        'Click a UI element by its visible label or accessibility name. The host resolves via Windows UI Automation. Use as fallback when computer-tool clicks miss, or for icons/buttons with unstable pixel positions.',
      parameters: {
        type: 'object',
        properties: { label: { type: 'string' } },
        required: ['label'],
      },
    },
    {
      type: 'function',
      name: 'scroll_label',
      description: 'Scroll on a UI element identified by its visible label.',
      parameters: {
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
      type: 'function',
      name: 'type_into_label',
      description: 'Click a labelled element to focus it, then type text.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['label', 'text'],
      },
    },
    {
      type: 'function',
      name: 'ask_user',
      description:
        'Pause and ask the user a clarifying question with up to 4 pre-written options. Use ONLY when the next action depends on information you cannot reliably infer (paths, names, ambiguous references) AND a wrong guess would damage / require rework. Do NOT use for trivial reversible decisions or anything you can derive from context. The picked option\'s `value` comes back as your function_call_output.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label', 'value'],
            },
          },
          allowFreeform: { type: 'boolean' },
        },
        required: ['question', 'options'],
      },
    },
    {
      type: 'function',
      name: 'run_command',
      description:
        'Execute a non-interactive shell command. Captures stdout/stderr and exit code. Use for package installs, tests, builds, git, file batch ops. Requires user approval (per-task / per-action modes both gate; "never" mode runs). Out-of-workspace cwd always gates. Avoid interactive REPLs and long-running services — they\'ll time out.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Absolute path. Defaults to workspace folder, else home dir.' },
          timeoutMs: { type: 'number', description: 'Capped at 120000ms.' },
        },
        required: ['command'],
      },
    },
    {
      type: 'function',
      name: 'plan',
      description:
        'Write or revise a structured plan for the current task BEFORE executing. Use for complex multi-step tasks (coding, multi-file edits, long automation). Only one plan exists at a time — calling again overwrites it. The user approves / denies / sends feedback. On approval the plan is persisted and echoed back to you as your function_call_output.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown body — numbered/bulleted steps with concrete details.' },
          rationale: { type: 'string', description: 'Optional one-line note on why this plan was created/revised.' },
        },
        required: ['content'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Action translation: OpenAI's computer-use action shapes → our internal
// ComputerToolAction. Names and parameter conventions differ.
// ---------------------------------------------------------------------------

function openAIComputerToInternal(action: any): ComputerToolAction | null {
  const t = action?.type;
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'click': {
      const button = action.button ?? 'left';
      const coord: [number, number] = [action.x, action.y];
      if (button === 'left') return { action: 'left_click', coordinate: coord };
      if (button === 'right') return { action: 'right_click', coordinate: coord };
      if (button === 'wheel' || button === 'middle')
        return { action: 'middle_click', coordinate: coord };
      // back / forward — not in our internal set; degrade to left_click.
      return { action: 'left_click', coordinate: coord };
    }
    case 'double_click':
      return { action: 'double_click', coordinate: [action.x, action.y] };
    case 'drag': {
      const path = Array.isArray(action.path) ? action.path : [];
      if (path.length < 2) return null;
      const start = path[0];
      const end = path[path.length - 1];
      return {
        action: 'left_click_drag',
        start_coordinate: [start.x, start.y],
        coordinate: [end.x, end.y],
      };
    }
    case 'keypress': {
      // OpenAI sends keys as an array (e.g. ["ctrl","a"] or ["Enter"]).
      const keys = Array.isArray(action.keys) ? action.keys.join('+') : String(action.keys ?? '');
      return { action: 'key', text: keys };
    }
    case 'move':
      return { action: 'mouse_move', coordinate: [action.x, action.y] };
    case 'screenshot':
      return { action: 'screenshot' };
    case 'scroll': {
      // OpenAI uses scroll_x/scroll_y (deltas). Translate to our
      // direction + amount. Pick the dominant axis.
      const sy = Number(action.scroll_y ?? 0);
      const sx = Number(action.scroll_x ?? 0);
      const useY = Math.abs(sy) >= Math.abs(sx);
      const direction = useY
        ? sy >= 0 ? 'down' : 'up'
        : sx >= 0 ? 'right' : 'left';
      const amount = Math.max(1, Math.round(Math.abs(useY ? sy : sx) / 100));
      return {
        action: 'scroll',
        coordinate: [action.x ?? 0, action.y ?? 0],
        scroll_direction: direction,
        scroll_amount: amount,
      };
    }
    case 'type':
      return { action: 'type', text: String(action.text ?? '') };
    case 'wait':
      return { action: 'wait', duration: Number(action.ms ?? 1000) / 1000 };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

function parseComputerCall(item: any): ParseResult {
  const internal = openAIComputerToInternal(item.action);
  if (!internal) {
    return {
      ok: false,
      error: `Unknown or unsupported computer-use action: ${JSON.stringify(item.action)}`,
    };
  }
  try {
    return {
      ok: true,
      action: { tool: 'computer', data: ComputerToolActionSchema.parse(internal) },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid computer action: ${msg}` };
  }
}

function parseFunctionCall(item: any): ParseResult {
  try {
    const args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
    const labelTools = ['click_label', 'scroll_label', 'type_into_label'];
    if (labelTools.includes(item.name)) {
      const data = LabelToolActionSchema.parse({ action: item.name, ...args });
      return { ok: true, action: { tool: 'label', data } };
    }
    if (item.name === 'ask_user') {
      const data = AskUserActionSchema.parse({ action: 'ask_user', ...args });
      return { ok: true, action: { tool: 'meta', data } };
    }
    if (item.name === 'plan') {
      const data = PlanToolActionSchema.parse({ action: 'set_plan', ...args });
      return { ok: true, action: { tool: 'plan', data } };
    }
    if (item.name === 'run_command') {
      const data = ShellToolActionSchema.parse({ action: 'run_command', ...args });
      return { ok: true, action: { tool: 'shell', data } };
    }
    const data = FileToolActionSchema.parse({ action: item.name, ...args });
    return { ok: true, action: { tool: 'file', data } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid input for tool "${item.name}": ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postResponses(
  apiKey: string,
  body: unknown,
  signal: AbortSignal,
): Promise<any> {
  const res = await fetch(RESPONSES_ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI Responses ${res.status}: ${text}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const openaiAgentAdapter: AgentProviderAdapter<OpenAIState> = {
  id: 'openai',

  init(opts: AgentInitOpts): OpenAIState {
    const userContent: Array<{ type: string; image_url?: string; text?: string }> = [
      {
        type: 'input_image',
        image_url: imageBytesToDataUrl(opts.imageBytes, opts.imageMimeType),
      },
    ];
    for (const att of opts.imageAttachments ?? []) {
      userContent.push({
        type: 'input_image',
        image_url: imageBytesToDataUrl(att.bytes, att.mimeType),
      });
    }
    userContent.push({ type: 'input_text', text: opts.prompt });
    const initialUser = { role: 'user', content: userContent };
    return {
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      imageWidth: opts.imageWidth,
      imageHeight: opts.imageHeight,
      instructions: buildInstructions(opts.workspaceFolder),
      input: [initialUser],
      pendingActions: new Map(),
      pendingErrors: new Map(),
      pendingCallIds: [],
      pendingCallKind: new Map(),
    };
  },

  async step(state: OpenAIState, abortSignal: AbortSignal): Promise<AgentTurnResult> {
    const tools = buildTools(state.imageWidth, state.imageHeight);
    const body = {
      model: state.modelId,
      instructions: state.instructions,
      tools,
      input: state.input,
      truncation: 'auto',
      // The reasoning summary doesn't help our UI; skip it to save tokens.
      reasoning: { summary: 'concise' },
      // Computer-use models in the Responses API always run with this tool;
      // the model picks per-turn.
    };

    const t0 = performance.now();
    const resp = await postResponses(state.apiKey, body, abortSignal);
    const apiMs = Math.round(performance.now() - t0);

    // Echo the assistant's full output array into our running input so
    // the next request includes the same context.
    const output: ResponseItem[] = Array.isArray(resp.output) ? resp.output : [];
    state.input.push(...output);

    // Walk output items, splitting into tool calls + text.
    const toolUses: AgentToolUse[] = [];
    const parseErrors = new Map<string, string>();
    const callIds: string[] = [];
    const callKind = new Map<string, 'computer' | 'function'>();
    const textParts: string[] = [];
    for (const item of output) {
      if (item.type === 'computer_call') {
        const id = item.call_id as string;
        callIds.push(id);
        callKind.set(id, 'computer');
        const r = parseComputerCall(item);
        if (r.ok) toolUses.push({ id, action: r.action });
        else parseErrors.set(id, r.error);
      } else if (item.type === 'function_call') {
        const id = item.call_id as string;
        callIds.push(id);
        callKind.set(id, 'function');
        const r = parseFunctionCall(item);
        if (r.ok) toolUses.push({ id, action: r.action });
        else parseErrors.set(id, r.error);
      } else if (item.type === 'message') {
        // Message content is an array of input_text/output_text blocks.
        const content = Array.isArray(item.content) ? item.content : [];
        for (const c of content) {
          if (c.type === 'output_text' && typeof c.text === 'string') {
            textParts.push(c.text);
          }
        }
      }
      // reasoning items: present but we don't surface them in the UI.
    }
    const finalText = textParts.join('\n').trim();

    state.pendingCallIds = callIds;
    state.pendingCallKind = callKind;
    state.pendingActions = new Map(toolUses.map((tu) => [tu.id, tu.action]));
    state.pendingErrors = parseErrors;

    const done = callIds.length === 0;
    const usage = resp.usage ?? {};
    // Responses API surfaces auto-cached prompt tokens via
    // `input_tokens_details.cached_tokens`. Cast through unknown — the
    // SDK types vary by version and the field is sometimes absent.
    const cachedTokens = (usage as unknown as {
      input_tokens_details?: { cached_tokens?: number };
    }).input_tokens_details?.cached_tokens;

    return {
      toolUses,
      parseErrorIds: Array.from(parseErrors.keys()),
      finalText: done ? finalText || '(no further actions)' : finalText || undefined,
      done,
      apiMs,
      stopReason: resp.status as string | undefined,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      // OpenAI has no "cache creation" concept (caching is automatic),
      // so only the read side is populated.
      cacheReadInputTokens: cachedTokens,
    };
  },

  appendResults(
    state: OpenAIState,
    results: AgentToolResult[],
    opts?: { extraUserText?: string },
  ): void {
    const byId = new Map(results.map((r) => [r.toolUseId, r]));
    for (const id of state.pendingCallIds) {
      const kind = state.pendingCallKind.get(id) ?? 'function';
      const parseErr = state.pendingErrors.get(id);
      const r = byId.get(id);

      if (kind === 'computer') {
        // computer_call_output: `output` is an input_image (success) or
        // input_text (failure / no screenshot).
        if (parseErr) {
          state.input.push({
            type: 'computer_call_output',
            call_id: id,
            output: { type: 'input_text', text: parseErr },
          });
        } else if (r?.errorText) {
          state.input.push({
            type: 'computer_call_output',
            call_id: id,
            output: { type: 'input_text', text: r.errorText },
          });
        } else if (r?.screenshotBytes && r?.screenshotMimeType) {
          state.input.push({
            type: 'computer_call_output',
            call_id: id,
            output: {
              type: 'input_image',
              image_url: imageBytesToDataUrl(r.screenshotBytes, r.screenshotMimeType),
            },
          });
        } else {
          state.input.push({
            type: 'computer_call_output',
            call_id: id,
            output: { type: 'input_text', text: r?.text ?? '' },
          });
        }
      } else {
        // function_call_output: `output` is a plain string.
        const text = parseErr ?? r?.errorText ?? r?.text ?? '';
        state.input.push({
          type: 'function_call_output',
          call_id: id,
          output: text,
        });
      }
    }

    // Mid-loop user interrupt — push a fresh user message AFTER all the
    // tool outputs so the model sees it on the next turn. Responses API
    // accepts free-form user messages alongside computer/function call
    // outputs; this avoids the more invasive "rewrite the in-flight call"
    // alternative.
    if (opts?.extraUserText && opts.extraUserText.trim().length > 0) {
      state.input.push({
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `[User interrupt — read this BEFORE continuing the task]\n${opts.extraUserText.trim()}`,
          },
        ],
      });
    }

    state.pendingCallIds = [];
    state.pendingCallKind = new Map();
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },

  appendUserTurn(state: OpenAIState, opts): void {
    // Append a fresh user-role message at the end of `state.input`. The
    // Responses API treats consecutive user messages just fine; the next
    // `step()` reads everything as one continuous conversation.
    const userContent: Array<{ type: string; image_url?: string; text?: string }> = [];
    if (opts.imageBytes && opts.imageMimeType) {
      userContent.push({
        type: 'input_image',
        image_url: imageBytesToDataUrl(opts.imageBytes, opts.imageMimeType),
      });
    }
    for (const att of opts.imageAttachments ?? []) {
      userContent.push({
        type: 'input_image',
        image_url: imageBytesToDataUrl(att.bytes, att.mimeType),
      });
    }
    userContent.push({ type: 'input_text', text: opts.prompt });
    state.input.push({ role: 'user', content: userContent });
    if (opts.imageWidth && opts.imageHeight) {
      state.imageWidth = opts.imageWidth;
      state.imageHeight = opts.imageHeight;
    }
    state.pendingCallIds = [];
    state.pendingCallKind = new Map();
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },
};
