// Kimi (Moonshot) Computer Use adapter — uses the OpenAI-compatible chat
// completions endpoint with custom function tools (one tool per action
// kind). Click accuracy will be the lowest of our four providers because
// Kimi K2 / Moonshot vision models aren't trained on screen-pixel
// coordinates the way computer-use-tuned models are. File-system
// operations should work fine since they're just function calling on
// strings.

import OpenAI from 'openai';
import {
  AskUserActionSchema,
  ComputerToolActionSchema,
  FileToolActionSchema,
  LabelToolActionSchema,
  PlanToolActionSchema,
  ShellToolActionSchema,
  type AgentAction,
} from '@shared/schemas';
import { imageBytesToDataUrl } from '@main/providers/base';
import { readPlanSync } from '@main/storage/plan-store';
import { getUiaElements, type UiaElement } from '@main/capture/uia';
import type {
  AgentInitOpts,
  AgentProviderAdapter,
  AgentToolResult,
  AgentToolUse,
  AgentTurnResult,
} from './types';

const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';

const clientCache = new Map<string, OpenAI>();

function getClient(apiKey: string): OpenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey, baseURL: KIMI_BASE_URL, timeout: 90_000 });
    clientCache.set(apiKey, client);
  }
  return client;
}

type KimiState = {
  apiKey: string;
  modelId: string;
  imageWidth: number;
  imageHeight: number;
  systemPrompt: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  /** tool_call_id → action (for successful parses). */
  pendingActions: Map<string, AgentAction>;
  /** tool_call_id → error message (for parse failures). */
  pendingErrors: Map<string, string>;
  /** Order-preserving list of tool_call_ids from the most recent turn. */
  pendingIds: string[];
};

// ---------------------------------------------------------------------------
// System prompt — same shape as the other adapters; reuses the flat
// function names since we declare them the same way.
// ---------------------------------------------------------------------------

import { app } from 'electron';

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

function buildSystemPrompt(
  workspaceFolder: string | null,
  imageWidth: number,
  imageHeight: number,
): string {
  const lines = [
    "You are Optix, an AI assistant that performs tasks on the user's computer.",
    '',
    `Screenshots are ${imageWidth}×${imageHeight} pixels — for visual reference only. You do NOT have pixel-coordinate functions. All UI interaction goes through labels, keyboard, or files.`,
    '',
    'Available tools, in PREFERENCE ORDER:',
    '1. **File-system** (`list_directory`, `read_file`, `search_files`, `write_file`, `create_directory`) — preferred whenever the task involves files, directories, or text content.',
    '2. **Label-based UI** (`click_label`, `scroll_label`, `type_into_label`) — click/scroll/type into a UI element identified by its visible label or accessibility name. The host resolves the label via Windows UI Automation. Pass the visible text exactly: e.g. `click_label("Submit")`, `click_label("Address bar")`, `click_label("Tools menu")`. If a label fails, the error lists what elements WERE visible — pick from that list and retry.',
    '3. **Keyboard** (`key_press`, `type_text`) — for global navigation. `key_press("Win+r")` opens Run. `key_press("Win+e")` opens Explorer. `key_press("Tab")` moves focus. `key_press("Return")` submits.',
    '4. **Pixel-coordinate fallback** (`left_click`, `right_click`, `double_click`, `triple_click`, `scroll_at`) — LAST RESORT. Your pixel coordinates are unreliable; results may miss the intended target. Always include `target` (the visible label of the element) so the host can snap your rough coords onto the right element. Use only when the target has no label AND no keyboard shortcut.',
    '5. **Inspection** (`take_screenshot`, `wait`) — refresh the screenshot or pause briefly.',
    '',
    '**CRITICAL: typing into a specific input field.**',
    'When you need to type into a NAMED text input (Email, Password, Search, Username, any field with a label or placeholder), you MUST use `type_into_label("<field name>", "<text>")`. It focuses the right field for you. NEVER do `key_press(<some shortcut>)` followed by `type_text(...)` for a multi-input form — `type_text` lands wherever focus happens to be, and you cannot reliably know which field is focused. The only acceptable use of `type_text` is:',
    '  • Right after `key_press("Win+r")` (Run dialog has one input)',
    '  • Right after `key_press("Tab")` to advance through a known field sequence',
    '  • Right after a successful `click_label` of an input field (focus is now on it)',
    '',
    'Decision flow:',
    '  1. Can the task be done with files? Use file functions.',
    '  2. Typing into a named input? Use `type_into_label` (single call — clicks AND types).',
    '  3. Clicking a named element? Use `click_label`.',
    '  4. Global navigation (open app, switch window, submit form)? Use `key_press` shortcut.',
    '',
    'When `click_label` cannot find an element (e.g. Firefox icon in the taskbar), fall back to a keyboard alternative — `key_press("Win+r")` then `type_text("firefox")` then `key_press("Return")` — rather than retrying.',
    '',
    'Loop:',
    '1. Inspect the current state.',
    '2. Take ONE action by calling exactly one function.',
    '3. When the task is complete, reply with a brief plain-text summary and DO NOT call any more functions.',
    '4. If you hit an unrecoverable problem, describe it in a text reply and stop.',
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
      `Workspace: \`${workspaceFolder}\`. Stay inside this folder for file-system actions whenever possible. Any file action targeting a path outside this folder will be paused for explicit user approval.`,
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
// Function tool declarations (OpenAI-compatible: each is a `function` tool)
// ---------------------------------------------------------------------------

const COORD_PROPS = {
  x: { type: 'number', description: 'X pixel in screenshot space.' },
  y: { type: 'number', description: 'Y pixel in screenshot space.' },
};
// Target label is the visible name / accessibility label of the element
// being clicked. The host uses it to refine rough coordinates onto the
// precise UI element via Windows UI Automation, the same way Ask mode
// snaps overlay regions. Always include this when the target has a name.
const COORD_PROPS_WITH_TARGET = {
  ...COORD_PROPS,
  target: {
    type: 'string',
    description:
      'Visible label or accessibility name of the element you are clicking (e.g. "Firefox icon", "Submit", "Address bar"). Required whenever the target has a visible label — the host uses it to disambiguate from nearby elements when your pixel coordinates are slightly off.',
  },
};

function buildTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const fn = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
  ): OpenAI.Chat.Completions.ChatCompletionTool => ({
    type: 'function',
    function: { name, description, parameters: parameters as any },
  });
  // Kimi gets coord-based tools as a FALLBACK only. Empirically Kimi's
  // pixel-coordinate generation is unreliable; the strong recommendation
  // is for the model to use label-based / keyboard tools first. The
  // coord tools exist for the cases where neither label nor keyboard
  // can reach the target, with the knowledge that the result may miss.
  return [
    fn('type_text', 'Type the given text into the currently-focused input. No coordinates needed — focus must already be on the right field (use type_into_label or click_label first).', {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    }),
    fn(
      'key_press',
      'Press a single key or key combo. Use xdotool-style names: "Return", "Escape", "Tab", "ctrl+a", "Win+r" (open Run dialog), "Win+e" (Explorer). Keyboard shortcuts are the most reliable way to navigate without coordinates.',
      {
        type: 'object',
        properties: { keys: { type: 'string' } },
        required: ['keys'],
      },
    ),
    fn('take_screenshot', 'Take a fresh screenshot to inspect current screen state.', {
      type: 'object',
      properties: {},
    }),
    fn('wait', 'Pause for N seconds.', {
      type: 'object',
      properties: { seconds: { type: 'number' } },
      required: ['seconds'],
    }),
    // ---- Pixel-coordinate fallbacks (UNRELIABLE — see prompt) ---------
    // Always pass `target` (visible label) when known; the host uses it
    // to refine your rough coords onto the right element via UIA.
    fn(
      'left_click',
      'FALLBACK ONLY. Click at a pixel coordinate. Use this only when click_label cannot reach the target and no keyboard shortcut applies. Always include `target` (the visible label) — the host uses it to refine your coords onto the right element.',
      {
        type: 'object',
        properties: COORD_PROPS_WITH_TARGET,
        required: ['x', 'y'],
      },
    ),
    fn(
      'right_click',
      'FALLBACK ONLY. Right-click at a pixel coordinate. Always include `target` when the element has a label.',
      {
        type: 'object',
        properties: COORD_PROPS_WITH_TARGET,
        required: ['x', 'y'],
      },
    ),
    fn(
      'double_click',
      'FALLBACK ONLY. Double-click at a pixel coordinate. Always include `target` when the element has a label.',
      {
        type: 'object',
        properties: COORD_PROPS_WITH_TARGET,
        required: ['x', 'y'],
      },
    ),
    fn(
      'triple_click',
      'FALLBACK ONLY. Triple-click at a pixel coordinate. Always include `target` when the element has a label.',
      {
        type: 'object',
        properties: COORD_PROPS_WITH_TARGET,
        required: ['x', 'y'],
      },
    ),
    fn(
      'scroll_at',
      'FALLBACK ONLY. Scroll at a pixel coordinate. Prefer scroll_label when the scrollable area has a name. Reasonable scroll_amount values: 3-5 to advance one screen.',
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number' },
          target: { type: 'string', description: 'Visible label of the scrollable element, if any.' },
        },
        required: ['x', 'y', 'direction', 'amount'],
      },
    ),
    fn('list_directory', 'List the contents of a directory.', {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }),
    fn('read_file', 'Read a UTF-8 text file (max 100 KB).', {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }),
    fn(
      'search_files',
      'Recursively search for filenames matching a pattern under a root directory.',
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['root', 'pattern'],
      },
    ),
    fn('write_file', 'Write a UTF-8 text file. Overwrites if it exists.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    }),
    fn('create_directory', 'Create a directory (recursive).', {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }),
    // ---- Label-based tools (preferred for Kimi: avoid pixel coords) -------
    fn(
      'click_label',
      'PREFERRED for clicks. Click the UI element identified by its visible label or accessibility name (e.g. "Submit", "Firefox icon", "Tools menu"). The host resolves the label to coordinates via Windows UI Automation and clicks. Use this whenever you can describe the target by name — it is far more reliable than pixel coordinates.',
      {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description:
              'The visible text or accessibility name of the element. e.g. "Submit", "OK", "File menu", "Address bar".',
          },
        },
        required: ['label'],
      },
    ),
    fn(
      'scroll_label',
      'PREFERRED for scrolling. Scroll on the UI element identified by its visible label or accessibility name. The host resolves the label to coordinates via UI Automation and scrolls. Use this whenever the scroll target has a name.',
      {
        type: 'object',
        properties: {
          label: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: {
            type: 'number',
            description: 'Wheel clicks; 3-5 to advance roughly one screen.',
          },
        },
        required: ['label', 'direction', 'amount'],
      },
    ),
    fn(
      'type_into_label',
      'PREFERRED for typing into a specific input. Click the UI element identified by its label, then type text into it.',
      {
        type: 'object',
        properties: {
          label: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['label', 'text'],
      },
    ),
    // ---- Meta tools — pause for direct user interaction ------------------
    fn(
      'ask_user',
      'Pause and ask the user a clarifying question with up to 4 pre-written options. Use ONLY when the next action depends on information you cannot reliably infer (paths, names, ambiguous references) AND a wrong guess would damage / require rework. Do NOT use for trivial reversible decisions or anything you can derive from context. The picked option\'s `value` comes back as your tool_result.',
      {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            maxItems: 4,
            minItems: 1,
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
    ),
    // ---- Shell tool — run non-interactive commands ----------------------
    fn(
      'run_command',
      'Execute a non-interactive shell command. Captures stdout/stderr and exit code. Use for package installs, tests, builds, git, file batch ops. Requires user approval (per-task / per-action modes both gate; "never" mode runs). Out-of-workspace cwd always gates. Avoid interactive REPLs and long-running services — they\'ll time out.',
      {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Absolute path. Defaults to workspace folder, else home dir.' },
          timeoutMs: { type: 'number', description: 'Capped at 120000ms.' },
        },
        required: ['command'],
      },
    ),
    // ---- Plan tool — propose a structured plan for complex tasks --------
    fn(
      'plan',
      'Write or revise a structured plan for the current task BEFORE executing. Use for complex multi-step tasks (coding, multi-file edits, long automation). Only one plan exists at a time — calling again overwrites it. The user approves / denies / sends feedback. On approval the plan is persisted and echoed back to you as your tool_result.',
      {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown body — numbered/bulleted steps with concrete details.' },
          rationale: { type: 'string', description: 'Optional one-line note on why this plan was created/revised.' },
        },
        required: ['content'],
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Function call → AgentAction (same translation as the Gemini adapter)
// ---------------------------------------------------------------------------

type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

function parseFunctionCall(name: string, args: Record<string, unknown>): ParseResult {
  try {
    // Pixel-coordinate fallbacks. Each carries an optional `target` label
    // so the executor's snap can refine rough coords onto the right
    // element via UIA — same approach Ask mode uses for overlay regions.
    if (
      name === 'left_click' ||
      name === 'right_click' ||
      name === 'double_click' ||
      name === 'triple_click'
    ) {
      const data = ComputerToolActionSchema.parse({
        action: name,
        coordinate: [args.x, args.y],
        target: typeof args.target === 'string' ? args.target : undefined,
      });
      return { ok: true, action: { tool: 'computer', data } };
    }
    if (name === 'scroll_at') {
      const data = ComputerToolActionSchema.parse({
        action: 'scroll',
        coordinate: [args.x, args.y],
        scroll_direction: args.direction,
        scroll_amount: args.amount,
        target: typeof args.target === 'string' ? args.target : undefined,
      });
      return { ok: true, action: { tool: 'computer', data } };
    }
    if (name === 'type_text') {
      const data = ComputerToolActionSchema.parse({
        action: 'type',
        text: String(args.text ?? ''),
      });
      return { ok: true, action: { tool: 'computer', data } };
    }
    if (name === 'key_press') {
      const data = ComputerToolActionSchema.parse({
        action: 'key',
        text: String(args.keys ?? ''),
      });
      return { ok: true, action: { tool: 'computer', data } };
    }
    if (name === 'take_screenshot') {
      return { ok: true, action: { tool: 'computer', data: { action: 'screenshot' } } };
    }
    if (name === 'wait') {
      return {
        ok: true,
        action: {
          tool: 'computer',
          data: { action: 'wait', duration: Number(args.seconds ?? 1) },
        },
      };
    }
    if (
      name === 'list_directory' ||
      name === 'read_file' ||
      name === 'search_files' ||
      name === 'write_file' ||
      name === 'create_directory'
    ) {
      const data = FileToolActionSchema.parse({ action: name, ...args });
      return { ok: true, action: { tool: 'file', data } };
    }
    if (
      name === 'click_label' ||
      name === 'scroll_label' ||
      name === 'type_into_label'
    ) {
      const data = LabelToolActionSchema.parse({ action: name, ...args });
      return { ok: true, action: { tool: 'label', data } };
    }
    if (name === 'ask_user') {
      const data = AskUserActionSchema.parse({ action: 'ask_user', ...args });
      return { ok: true, action: { tool: 'meta', data } };
    }
    if (name === 'plan') {
      const data = PlanToolActionSchema.parse({ action: 'set_plan', ...args });
      return { ok: true, action: { tool: 'plan', data } };
    }
    if (name === 'run_command') {
      const data = ShellToolActionSchema.parse({ action: 'run_command', ...args });
      return { ok: true, action: { tool: 'shell', data } };
    }
    return { ok: false, error: `Unknown function: ${name}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid input for "${name}": ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// UIA element-list formatter for system-prompt injection. Sorted by area
// (largest first) on the heuristic that big elements are major UI affordances
// (buttons, panels, text fields). Capped at 30 entries — past that the model
// drowns in noise. Names without text are skipped.
// ---------------------------------------------------------------------------

function formatUiaForPrompt(elements: UiaElement[]): string {
  if (elements.length === 0) return '';
  const named = elements.filter(
    (e) =>
      (e.name.trim().length > 0 || e.helpText.trim().length > 0) &&
      e.bounds.width > 0 &&
      e.bounds.height > 0,
  );
  if (named.length === 0) return '';
  const sorted = [...named].sort(
    (a, b) =>
      b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
  );
  const top = sorted.slice(0, 30);
  const lines = top.map((e) => {
    const label = e.name.trim() || e.helpText.trim();
    const tip =
      e.helpText.trim() && e.helpText.trim() !== e.name.trim()
        ? ` — ${e.helpText.trim()}`
        : '';
    return `  • "${label}"${tip}`;
  });
  return [
    'CURRENT UI ELEMENTS detected by Windows UI Automation. Use these EXACT label strings with click_label / type_into_label / scroll_label:',
    ...lines,
    '',
    'If the element you need is not on this list, it may not be reachable by label — try a keyboard shortcut, or use a pixel-coordinate function as a last resort.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const kimiAgentAdapter: AgentProviderAdapter<KimiState> = {
  id: 'kimi',

  init(opts: AgentInitOpts): KimiState {
    const dataUrl = imageBytesToDataUrl(opts.imageBytes, opts.imageMimeType);
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
    ];
    for (const att of opts.imageAttachments ?? []) {
      userContent.push({
        type: 'image_url',
        image_url: { url: imageBytesToDataUrl(att.bytes, att.mimeType), detail: 'high' },
      });
    }
    userContent.push({ type: 'text', text: opts.prompt });
    return {
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      imageWidth: opts.imageWidth,
      imageHeight: opts.imageHeight,
      systemPrompt: buildSystemPrompt(opts.workspaceFolder, opts.imageWidth, opts.imageHeight),
      messages: [
        { role: 'system', content: buildSystemPrompt(opts.workspaceFolder, opts.imageWidth, opts.imageHeight) },
        { role: 'user', content: userContent },
      ],
      pendingActions: new Map(),
      pendingErrors: new Map(),
      pendingIds: [],
    };
  },

  async step(state: KimiState, abortSignal: AbortSignal): Promise<AgentTurnResult> {
    const client = getClient(state.apiKey);
    // Pull the UIA element list in parallel with anything else we'd do.
    // Kimi's coordinate generation is the weak link, so we hand it a
    // labelled vocabulary every turn — it can pick from real elements
    // instead of guessing. ~150-300ms cost, well-amortised against an
    // 8-15s API call.
    const uiaPromise = getUiaElements().catch(() => [] as UiaElement[]);

    const uiaElements = await uiaPromise;
    const uiaNote = formatUiaForPrompt(uiaElements);
    // Build a request-time messages array with the system prompt
    // augmented by the current UIA snapshot. The augmentation is
    // INTENTIONALLY STATELESS — we don't persist the UIA-injected
    // system prompt into `state.messages`, because:
    //   1. UIA elements change every turn (new screen state means a
    //      new label vocabulary), so a stale snapshot in history would
    //      mislead the model.
    //   2. Re-injecting fresh on every step keeps the conversation
    //      prefix stable, which matters for any provider-side prompt
    //      caching the host is layering on top.
    // The contract: every call into `step()` must pull a fresh UIA
    // snapshot — the renderer / loop driver doesn't supply elements
    // explicitly; we fetch them here. Don't switch to passing UIA via
    // state without also re-thinking that turn-by-turn freshness.
    const requestMessages =
      uiaNote.length > 0
        ? [
            { role: 'system', content: state.systemPrompt + '\n\n' + uiaNote },
            ...state.messages.slice(1),
          ]
        : state.messages;

    const t0 = performance.now();
    const resp = await client.chat.completions.create(
      {
        model: state.modelId,
        messages: requestMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools: buildTools(),
        tool_choice: 'auto',
        max_tokens: 2048,
      },
      { signal: abortSignal },
    );
    const apiMs = Math.round(performance.now() - t0);

    const choice = resp.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      throw new Error('Kimi returned no message.');
    }

    // Echo the assistant turn into the conversation. Some Kimi models
    // (the thinking-tier ones) reject the next request unless we include
    // `reasoning_content` on the prior assistant message — preserve any
    // such field by spreading the raw message object. The cast lets us
    // pass through fields the OpenAI SDK type doesn't know about.
    const assistantTurn: Record<string, unknown> = {
      role: 'assistant',
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    };
    const rc = (msg as unknown as { reasoning_content?: unknown }).reasoning_content;
    if (rc !== undefined) assistantTurn.reasoning_content = rc;
    // Double-cast through `unknown` because the open-record source type
    // doesn't structurally overlap with the SDK's union — TypeScript
    // refuses the direct cast. The shape is correct at runtime
    // (`role`/`content`/`tool_calls` are all set just above).
    state.messages.push(
      assistantTurn as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    );

    const toolUses: AgentToolUse[] = [];
    const parseErrors = new Map<string, string>();
    const callIds: string[] = [];
    for (const tc of msg.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      callIds.push(tc.id);
      let args: Record<string, unknown> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (err) {
        parseErrors.set(tc.id, `Invalid JSON for ${tc.function.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const r = parseFunctionCall(tc.function.name, args);
      if (r.ok) toolUses.push({ id: tc.id, action: r.action });
      else parseErrors.set(tc.id, r.error);
    }

    const finalText = (msg.content ?? '').trim();

    state.pendingIds = callIds;
    state.pendingActions = new Map(toolUses.map((tu) => [tu.id, tu.action]));
    state.pendingErrors = parseErrors;

    const done = callIds.length === 0;
    const usage = resp.usage;
    // Moonshot's OpenAI-compatible response exposes auto-cached prompt
    // tokens at `prompt_tokens_details.cached_tokens` (mirrors OpenAI).
    const cachedTokens = (usage as unknown as {
      prompt_tokens_details?: { cached_tokens?: number };
    } | undefined)?.prompt_tokens_details?.cached_tokens;

    return {
      toolUses,
      parseErrorIds: Array.from(parseErrors.keys()),
      finalText: done ? finalText || '(no further actions)' : finalText || undefined,
      done,
      apiMs,
      stopReason: choice?.finish_reason ?? undefined,
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      cacheReadInputTokens: cachedTokens,
    };
  },

  appendResults(
    state: KimiState,
    results: AgentToolResult[],
    opts?: { extraUserText?: string },
  ): void {
    const byId = new Map(results.map((r) => [r.toolUseId, r]));
    for (const id of state.pendingIds) {
      const parseErr = state.pendingErrors.get(id);
      const r = byId.get(id);

      // Tool messages can include text content. For computer-use results
      // with screenshots, we deliver the screenshot in a follow-on user
      // message because Kimi's tool message schema is text-only.
      const text = parseErr
        ? `ERROR: ${parseErr}`
        : r?.errorText
          ? `ERROR: ${r.errorText}`
          : r?.text
            ? r.text
            : r?.screenshotBytes
              ? '[fresh screenshot follows]'
              : '';
      state.messages.push({
        role: 'tool',
        tool_call_id: id,
        content: text,
      });
    }

    // Deliver any post-action screenshots as a single follow-on user
    // message so the model can see the new screen state.
    const screenshots = results.filter(
      (r) => r.screenshotBytes && r.screenshotMimeType,
    );
    if (screenshots.length > 0) {
      const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      for (const s of screenshots) {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: imageBytesToDataUrl(s.screenshotBytes!, s.screenshotMimeType!),
            detail: 'high',
          },
        });
      }
      userContent.push({ type: 'text', text: 'Updated screenshot(s) above.' });
      state.messages.push({ role: 'user', content: userContent });
    }

    // Mid-loop user interrupt — appended as a fresh user turn after the
    // tool messages + any screenshot follow-on. The model reads it on
    // the next request and can re-plan.
    if (opts?.extraUserText && opts.extraUserText.trim().length > 0) {
      state.messages.push({
        role: 'user',
        content: `[User interrupt — read this BEFORE continuing the task]\n${opts.extraUserText.trim()}`,
      });
    }

    state.pendingIds = [];
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },

  appendUserTurn(state: KimiState, opts): void {
    // Append a fresh user-role chat message at the end of state.messages.
    // Kimi accepts mixed image + text content in a single user message
    // the same way as init.
    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (opts.imageBytes && opts.imageMimeType) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: imageBytesToDataUrl(opts.imageBytes, opts.imageMimeType),
          detail: 'high',
        },
      });
    }
    for (const att of opts.imageAttachments ?? []) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: imageBytesToDataUrl(att.bytes, att.mimeType),
          detail: 'high',
        },
      });
    }
    userContent.push({ type: 'text', text: opts.prompt });
    state.messages.push({ role: 'user', content: userContent });
    if (opts.imageWidth && opts.imageHeight) {
      state.imageWidth = opts.imageWidth;
      state.imageHeight = opts.imageHeight;
    }
    state.pendingIds = [];
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },
};
