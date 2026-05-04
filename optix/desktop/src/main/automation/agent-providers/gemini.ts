// Gemini Computer Use adapter — declares the agent's actions as flat
// function tools (one tool per action kind) and treats the model's
// function calls as our `AgentAction` discriminator.
//
// Trade-off: standard Gemini models aren't fine-tuned for screen-pixel
// coordinate generation the way Anthropic Opus 4.7 and OpenAI's
// computer-use-preview are. Click accuracy will be lower; the file-system
// tools are unaffected. This still gives Gemini users a working agent —
// just one that's better at FS-heavy tasks than UI-heavy ones.
//
// We use REST directly because the @google/generative-ai SDK v0.21
// shipped before the more recent function-calling-with-images
// conveniences and we need precise control over the contents array shape.

import { app } from 'electron';
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

type Content = { role: 'user' | 'model'; parts: Part[] };
type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: { content: string } } };

type GeminiState = {
  apiKey: string;
  modelId: string;
  imageWidth: number;
  imageHeight: number;
  systemInstruction: string;
  contents: Content[];
  /** The model's emitted function calls (good ones), keyed by synthetic
   *  ids — Gemini doesn't tag calls with ids the way Anthropic/OpenAI do,
   *  so we mint our own per-turn. */
  pendingActions: Map<string, AgentAction>;
  /** Synthetic-id → original function name. Needed because tool results
   *  reference the function NAME, not an id. */
  pendingNames: Map<string, string>;
  /** Synthetic ids for tool_uses that failed parsing. */
  pendingErrors: Map<string, string>;
  /** Order-preserving list of synthetic ids from the most recent turn. */
  pendingIds: string[];
  /** Counter for synthetic-id minting — monotonic across the loop. */
  callCounter: number;
};

// ---------------------------------------------------------------------------
// System instruction
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

function buildSystemInstruction(
  workspaceFolder: string | null,
  imageWidth: number,
  imageHeight: number,
): string {
  const lines = [
    "You are Optix, an AI assistant that performs tasks on the user's computer.",
    '',
    'You have function tools for three kinds of work:',
    '1. **File-system functions** (`list_directory`, `read_file`, `search_files`, `write_file`, `create_directory`) — fast and exact. Prefer these whenever the task can be done by reading, listing, searching, or modifying files directly.',
    '2. **Label-based functions** (`click_label`, `scroll_label`, `type_into_label`) — STRONGLY PREFERRED for any UI interaction where the target has a visible text label or accessibility name. The host resolves the label to coordinates via Windows UI Automation, so you do not need to compute pixel positions. Use these whenever you can describe the target by name (e.g. "Submit button", "Firefox icon", "Tools menu", "Address bar").',
    '3. **Pixel-coordinate functions** (`left_click`, `right_click`, `double_click`, `triple_click`, `type_text`, `key_press`, `scroll_at`, `mouse_move`, `take_screenshot`, `wait`) — fallback for when the target has no clear label. Coordinate accuracy may be unreliable, so prefer label-based functions whenever possible.',
    '',
    'Loop:',
    '1. Inspect the current state.',
    '2. Take ONE action by calling exactly one function. After each call you receive an updated screenshot or tool result.',
    '3. When the task is complete, reply with a brief plain-text summary and DO NOT call any more functions — that ends the session.',
    '4. If you hit an unrecoverable problem, describe it in a text reply and stop.',
    '',
    `Coordinate space: the screenshot is ${imageWidth} pixels wide × ${imageHeight} pixels tall, with (0,0) at the top-left. All coordinates you pass to click/scroll/move functions map 1:1 to the screen.`,
    '',
    'Targeting tips:',
    '  • Aim for the visual center of a button or icon, not its edge.',
    '  • For taskbar icons, the click point is in the bottom strip of the screen — check the screenshot to confirm the icon is actually there before clicking.',
    "  • For scroll_at, click inside the scrollable content area (web page body, document text). Scrolling on the URL bar, tabs, or taskbar won't move content. Reasonable scroll_amount values: 3–5 to advance roughly one screen.",
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
// Function-tool declarations
// ---------------------------------------------------------------------------

const COORD_PROPS = {
  x: { type: 'number', description: 'X pixel in screenshot space.' },
  y: { type: 'number', description: 'Y pixel in screenshot space.' },
};
// Target label is the visible name / accessibility label of the element
// being clicked. The host uses it to refine rough coordinates onto the
// precise UI element via Windows UI Automation.
const COORD_PROPS_WITH_TARGET = {
  ...COORD_PROPS,
  target: {
    type: 'string',
    description:
      'Visible label or accessibility name of the element you are clicking (e.g. "Firefox icon", "Submit", "Address bar"). Required whenever the target has a visible label.',
  },
};

function buildFunctionDeclarations(): unknown[] {
  return [
    // Computer-use functions
    {
      name: 'left_click',
      description: 'Single left-click at the given pixel coordinate. Always include `target` (the visible label of the element) when it has a name — the host uses it to refine rough coordinates onto the precise element.',
      parameters: { type: 'object', properties: COORD_PROPS_WITH_TARGET, required: ['x', 'y'] },
    },
    {
      name: 'right_click',
      description: 'Right-click at the given pixel coordinate. Include `target` whenever the element has a label.',
      parameters: { type: 'object', properties: COORD_PROPS_WITH_TARGET, required: ['x', 'y'] },
    },
    {
      name: 'double_click',
      description: 'Double-click at the given pixel coordinate. Include `target` whenever the element has a label.',
      parameters: { type: 'object', properties: COORD_PROPS_WITH_TARGET, required: ['x', 'y'] },
    },
    {
      name: 'triple_click',
      description: 'Triple-click at the given pixel coordinate. Include `target` whenever the element has a label.',
      parameters: { type: 'object', properties: COORD_PROPS_WITH_TARGET, required: ['x', 'y'] },
    },
    {
      name: 'mouse_move',
      description: 'Move the mouse to the given pixel coordinate without clicking. Include `target` whenever the element has a label.',
      parameters: { type: 'object', properties: COORD_PROPS_WITH_TARGET, required: ['x', 'y'] },
    },
    {
      name: 'type_text',
      description: 'Type the given text into the currently-focused input.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'key_press',
      description:
        'Press a single key or key combination. Use xdotool-style names: "Return", "Escape", "ctrl+a", "ctrl+shift+t".',
      parameters: {
        type: 'object',
        properties: { keys: { type: 'string' } },
        required: ['keys'],
      },
    },
    {
      name: 'scroll_at',
      description: 'Scroll the element under the given pixel by N "clicks" of the wheel. Include `target` (the label of the scrollable area) when known.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number', description: 'Positive integer count of wheel clicks.' },
          target: { type: 'string', description: 'Visible label of the scrollable element, if any.' },
        },
        required: ['x', 'y', 'direction', 'amount'],
      },
    },
    {
      name: 'take_screenshot',
      description: 'Take a fresh screenshot to inspect current screen state.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'wait',
      description: 'Pause for N seconds.',
      parameters: {
        type: 'object',
        properties: { seconds: { type: 'number' } },
        required: ['seconds'],
      },
    },
    // File-system functions
    {
      name: 'list_directory',
      description: 'List the contents of a directory.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file (max 100 KB).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'search_files',
      description: 'Recursively search for filenames matching a pattern under a root directory.',
      parameters: {
        type: 'object',
        properties: {
          root: { type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['root', 'pattern'],
      },
    },
    {
      name: 'write_file',
      description: 'Write a UTF-8 text file. Overwrites if it exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'create_directory',
      description: 'Create a directory (recursive).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    // ---- Label-based tools (preferred: avoid pixel coords) -----------------
    {
      name: 'click_label',
      description:
        'PREFERRED for clicks. Click the UI element identified by its visible label or accessibility name (e.g. "Submit", "Firefox icon", "Tools menu"). The host resolves the label to coordinates via Windows UI Automation. Use this whenever the target has a name — far more reliable than pixel coordinates.',
      parameters: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description: 'Visible text or accessibility name. e.g. "Submit", "OK", "Address bar".',
          },
        },
        required: ['label'],
      },
    },
    {
      name: 'scroll_label',
      description:
        'PREFERRED for scrolling. Scroll on the UI element identified by its visible label or accessibility name.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number', description: 'Wheel clicks; 3-5 to advance one screen.' },
        },
        required: ['label', 'direction', 'amount'],
      },
    },
    {
      name: 'type_into_label',
      description:
        'PREFERRED for typing into a specific input. Click the labelled element, then type text into it.',
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
      name: 'ask_user',
      description:
        'Pause and ask the user a clarifying question with up to 4 pre-written options. Use ONLY when the next action depends on information you cannot reliably infer (paths, names, ambiguous references) AND a wrong guess would damage / require rework. Do NOT use for trivial reversible decisions or anything you can derive from context. The picked option\'s `value` comes back as your function_response.',
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
      name: 'plan',
      description:
        'Write or revise a structured plan for the current task BEFORE executing. Use for complex multi-step tasks (coding, multi-file edits, long automation). Only one plan exists at a time — calling again overwrites it. The user approves / denies / sends feedback. On approval the plan is persisted and echoed back to you as your function_response.',
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
// Translation: function name + args → AgentAction
// ---------------------------------------------------------------------------

type ParseResult =
  | { ok: true; action: AgentAction }
  | { ok: false; error: string };

function parseFunctionCall(name: string, args: Record<string, unknown>): ParseResult {
  try {
    // Computer-use functions
    if (
      name === 'left_click' ||
      name === 'right_click' ||
      name === 'double_click' ||
      name === 'triple_click' ||
      name === 'mouse_move'
    ) {
      const data = ComputerToolActionSchema.parse({
        action: name,
        coordinate: [args.x, args.y],
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
    // File-system functions
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
// HTTP
// ---------------------------------------------------------------------------

async function postGenerate(
  apiKey: string,
  modelId: string,
  body: unknown,
  signal: AbortSignal,
): Promise<any> {
  // Use the v1beta endpoint — function calling lives there for now.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${text}`);
  }
  return await res.json();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const geminiAgentAdapter: AgentProviderAdapter<GeminiState> = {
  id: 'google',

  init(opts: AgentInitOpts): GeminiState {
    const parts: Part[] = [
      {
        inlineData: {
          mimeType: opts.imageMimeType,
          data: imageBytesToBase64(opts.imageBytes),
        },
      },
    ];
    for (const att of opts.imageAttachments ?? []) {
      parts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: imageBytesToBase64(att.bytes),
        },
      });
    }
    parts.push({ text: opts.prompt });
    const initialUser: Content = { role: 'user', parts };
    return {
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      imageWidth: opts.imageWidth,
      imageHeight: opts.imageHeight,
      systemInstruction: buildSystemInstruction(opts.workspaceFolder, opts.imageWidth, opts.imageHeight),
      contents: [initialUser],
      pendingActions: new Map(),
      pendingNames: new Map(),
      pendingErrors: new Map(),
      pendingIds: [],
      callCounter: 0,
    };
  },

  async step(state: GeminiState, abortSignal: AbortSignal): Promise<AgentTurnResult> {
    const body = {
      contents: state.contents,
      systemInstruction: { parts: [{ text: state.systemInstruction }] },
      tools: [{ functionDeclarations: buildFunctionDeclarations() }],
      // Force tool use mode AUTO so the model can pick whether to call or
      // emit a final text reply.
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { maxOutputTokens: 2048 },
    };

    const t0 = performance.now();
    const resp = await postGenerate(state.apiKey, state.modelId, body, abortSignal);
    const apiMs = Math.round(performance.now() - t0);

    const candidate = resp.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];

    // Echo the assistant turn's parts back into history so the next request
    // includes the same context.
    state.contents.push({ role: 'model', parts });

    const toolUses: AgentToolUse[] = [];
    const parseErrors = new Map<string, string>();
    const callIds: string[] = [];
    const callNames = new Map<string, string>();
    const textParts: string[] = [];
    for (const part of parts) {
      if ('functionCall' in part && part.functionCall) {
        const id = `gem-${state.callCounter++}`;
        callIds.push(id);
        callNames.set(id, part.functionCall.name);
        const r = parseFunctionCall(part.functionCall.name, part.functionCall.args ?? {});
        if (r.ok) toolUses.push({ id, action: r.action });
        else parseErrors.set(id, r.error);
      } else if ('text' in part && typeof part.text === 'string') {
        textParts.push(part.text);
      }
    }
    const finalText = textParts.join('\n').trim();

    state.pendingIds = callIds;
    state.pendingNames = callNames;
    state.pendingActions = new Map(toolUses.map((tu) => [tu.id, tu.action]));
    state.pendingErrors = parseErrors;

    const done = callIds.length === 0;
    const usage = resp.usageMetadata ?? {};
    // Gemini context-cached calls report reused tokens via
    // `cachedContentTokenCount`. Map it onto cache_read so the cost
    // estimator treats it the same way as Anthropic/OpenAI cache reads.
    const cachedTokens = (usage as unknown as { cachedContentTokenCount?: number })
      .cachedContentTokenCount;

    return {
      toolUses,
      parseErrorIds: Array.from(parseErrors.keys()),
      finalText: done ? finalText || '(no further actions)' : finalText || undefined,
      done,
      apiMs,
      stopReason: candidate?.finishReason as string | undefined,
      inputTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      cacheReadInputTokens: cachedTokens,
    };
  },

  appendResults(
    state: GeminiState,
    results: AgentToolResult[],
    opts?: { extraUserText?: string },
  ): void {
    const byId = new Map(results.map((r) => [r.toolUseId, r]));
    const responseParts: Part[] = [];
    for (const id of state.pendingIds) {
      // Gemini's protocol requires `functionResponse.name` to echo the
      // ORIGINAL functionCall name. A missing entry here means our
      // pending-state bookkeeping diverged from what we emitted last
      // turn; the conversation is unrecoverable. Fail loudly rather
      // than send `'unknown'` and watch the model react to a phantom
      // tool name.
      const name = state.pendingNames.get(id);
      if (!name) {
        throw new Error(
          `Gemini adapter: missing function name for pending call ${id} — adapter state is corrupt.`,
        );
      }
      const parseErr = state.pendingErrors.get(id);
      const r = byId.get(id);

      let payload: string;
      if (parseErr) payload = `ERROR: ${parseErr}`;
      else if (r?.errorText) payload = `ERROR: ${r.errorText}`;
      else if (r?.text) payload = r.text;
      else if (r?.screenshotBytes && r?.screenshotMimeType)
        payload = '[fresh screenshot follows in next user turn]';
      else payload = '';

      responseParts.push({
        functionResponse: {
          name,
          response: { content: payload },
        },
      });
    }

    // Function responses go in a single user turn for Gemini.
    state.contents.push({ role: 'user', parts: responseParts });

    // For computer-use function results that have screenshots, ALSO add a
    // separate user turn carrying the image — Gemini's functionResponse
    // schema doesn't natively accept images, so we deliver them as a
    // follow-on user message.
    const screenshotParts: Part[] = [];
    for (const r of results) {
      if (r.screenshotBytes && r.screenshotMimeType) {
        screenshotParts.push({
          inlineData: {
            mimeType: r.screenshotMimeType,
            data: imageBytesToBase64(r.screenshotBytes),
          },
        });
      }
    }
    if (screenshotParts.length > 0) {
      state.contents.push({
        role: 'user',
        parts: [
          ...screenshotParts,
          { text: 'Updated screenshot(s) above.' },
        ],
      });
    }

    // Mid-loop user interrupt — appended as an extra user turn after the
    // function-response + screenshot turns. Gemini accepts consecutive
    // user turns; the model reads them as one logical user message.
    if (opts?.extraUserText && opts.extraUserText.trim().length > 0) {
      state.contents.push({
        role: 'user',
        parts: [
          {
            text: `[User interrupt — read this BEFORE continuing the task]\n${opts.extraUserText.trim()}`,
          },
        ],
      });
    }

    state.pendingIds = [];
    state.pendingNames = new Map();
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },

  appendUserTurn(state: GeminiState, opts): void {
    // Append a fresh user-role content message at the end. Mirrors
    // init: image first (if present), attachments next, prompt last.
    const parts: Part[] = [];
    if (opts.imageBytes && opts.imageMimeType) {
      parts.push({
        inlineData: {
          mimeType: opts.imageMimeType,
          data: imageBytesToBase64(opts.imageBytes),
        },
      });
    }
    for (const att of opts.imageAttachments ?? []) {
      parts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: imageBytesToBase64(att.bytes),
        },
      });
    }
    parts.push({ text: opts.prompt });
    state.contents.push({ role: 'user', parts });
    if (opts.imageWidth && opts.imageHeight) {
      state.imageWidth = opts.imageWidth;
      state.imageHeight = opts.imageHeight;
    }
    state.pendingIds = [];
    state.pendingNames = new Map();
    state.pendingActions = new Map();
    state.pendingErrors = new Map();
  },
};
