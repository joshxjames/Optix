// User-facing documentation. Each article is a structured tree of
// blocks the DocsViewer renders into the widget. Articles are grouped
// by `category` for the list view; ordering inside a category follows
// the order they appear in this file.
//
// The body uses a tiny block model rather than free-form Markdown so
// the renderer is simple, consistent, and doesn't need a Markdown
// dependency. Add new article kinds (e.g. tables) only when an
// existing one really doesn't fit.

export type DocBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'code'; text: string }
  /** Embedded interactive form. The DocsViewer dispatches on `formId` to
   *  render the right component — keeps the article model declarative
   *  while allowing one-off interactive surfaces inside otherwise-static
   *  copy. Add a new `formId` literal alongside the matching component
   *  in DocsViewer when a new form is needed. */
  | { kind: 'form'; formId: 'support' };

export type DocArticle = {
  id: string;
  category: string;
  title: string;
  /** One-line summary used in the list view. */
  summary: string;
  blocks: DocBlock[];
};

export const DOC_CATEGORIES: string[] = [
  'Getting started',
  'The three modes',
  'Composing prompts',
  'Header & layout',
  'Agent tools',
  'Approvals & safety',
  'History & logs',
  'Automations',
  'Settings reference',
  'Optix Cloud',
  'Tips',
  'Support',
];

export const DOC_ARTICLES: DocArticle[] = [
  // -------------------------------------------------------------------------
  // Getting started
  // -------------------------------------------------------------------------
  {
    id: 'overview',
    category: 'Getting started',
    title: 'What Optix is',
    summary: 'A floating AI widget that can answer, act, and automate.',
    blocks: [
      {
        kind: 'p',
        text: "Optix is a small floating widget that sits on top of whatever you're working on. It can answer questions about what's on screen, act on your behalf using mouse + keyboard + the file system + a shell, and record what it does so you can replay the same task later with one tap.",
      },
      {
        kind: 'p',
        text: 'It runs locally as an Electron app. You bring your own API keys for the model provider; Optix never sends your data anywhere except to the provider you chose.',
      },
      { kind: 'h', text: 'The three modes' },
      {
        kind: 'ul',
        items: [
          'Ask — single-shot Q&A. The model looks at your screen and answers, but does not act.',
          'Access — full agent loop. The model can click, type, run shell commands, read and write files, and search the web.',
          'Automate — Access plus recording. Run a task once with the Record toggle on, and it gets saved as a routine you can replay later via /OA-N.',
        ],
      },
      { kind: 'h', text: 'What makes Optix different' },
      {
        kind: 'ul',
        items: [
          'Provider-agnostic: Anthropic, OpenAI, Kimi, and Google work out of the box.',
          'You own the keys, the screenshots, the audit log, and the routines — all stored on your machine.',
          'A real approval system: per-task, per-action, or never, with a hard boundary that always gates anything outside your chosen workspace folder.',
          'Recording captures semantic anchors (UIA element name + window title), not just pixel coordinates — replays survive layout shifts.',
        ],
      },
    ],
  },
  {
    id: 'first-run',
    category: 'Getting started',
    title: 'Your first prompt',
    summary: 'Set up a provider, pick Ask, type a question.',
    blocks: [
      { kind: 'h', text: '1. Add an API key' },
      {
        kind: 'p',
        text: 'Click the Settings icon (⚙) in the widget header, choose a provider, paste your API key, and hit Save. Test verifies the key against the provider; the key itself goes into your OS keychain.',
      },
      { kind: 'h', text: '2. Pick Ask mode' },
      {
        kind: 'p',
        text: "The mode tabs are at the top-left of the controls row. Ask is the safest place to start — it doesn't act on your machine.",
      },
      { kind: 'h', text: '3. Type a question and press Send' },
      {
        kind: 'p',
        text: 'Optix takes a screenshot of your active window, sends it to the model alongside your prompt, and streams the answer back. The screenshot stays on your machine — only the bytes are sent to the provider you picked.',
      },
      {
        kind: 'note',
        text: 'Cmd/Ctrl + Enter submits the prompt without leaving the keyboard.',
      },
    ],
  },
  {
    id: 'hotkey',
    category: 'Getting started',
    title: 'Show / hide with the hotkey',
    summary: 'Toggle the widget from anywhere with one shortcut.',
    blocks: [
      {
        kind: 'p',
        text: 'A global hotkey toggles the widget — bring it forward when you need it, send it away when you don\'t. The default is Ctrl+Shift+Space (Cmd+Shift+Space on macOS).',
      },
      {
        kind: 'p',
        text: 'Customise the binding in Settings → Hotkey. The change registers immediately. If your chosen combo conflicts with another app\'s shortcut, the registration silently fails — pick something less common.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // The three modes
  // -------------------------------------------------------------------------
  {
    id: 'mode-ask',
    category: 'The three modes',
    title: 'Ask mode',
    summary: 'Single-shot Q&A about what\'s on your screen.',
    blocks: [
      {
        kind: 'p',
        text: 'Ask is for getting an answer, a description, or a walk-through — not for taking action. Each prompt is a single API call: the model sees your screenshot, your question, and any prior turns if Conversation mode is on.',
      },
      { kind: 'h', text: 'When to use Ask' },
      {
        kind: 'ul',
        items: [
          '"Where do I find X in this app?"',
          '"What does this error mean?"',
          '"Walk me through setting up Y, step by step."',
          '"Summarise this article."',
        ],
      },
      { kind: 'h', text: 'What it can do' },
      {
        kind: 'ul',
        items: [
          'Stream a response (you see tokens land as they arrive).',
          'Use web search if your provider supports it.',
          'Highlight an answer on screen via the overlay button (when the model returns target regions).',
        ],
      },
      { kind: 'h', text: 'What it can\'t do' },
      {
        kind: 'ul',
        items: [
          'Click anything.',
          'Read or write your files.',
          'Run shell commands.',
          'Reference saved automations via /OA-N.',
        ],
      },
    ],
  },
  {
    id: 'mode-access',
    category: 'The three modes',
    title: 'Access mode',
    summary: 'Full Computer Use agent — clicks, files, shell, web.',
    blocks: [
      {
        kind: 'p',
        text: 'Access mode runs an autonomous agent loop on your machine. The model decides what to do, takes an action, sees the result (a fresh screenshot or tool output), and decides the next action — until the task is done or you stop it.',
      },
      { kind: 'h', text: 'What the agent can do' },
      {
        kind: 'ul',
        items: [
          'Click, type, scroll, drag, press keys via robotjs.',
          'List directories, read files, search files, write files, create directories.',
          'Run non-interactive shell commands (npm install, pytest, git status, etc.).',
          'Set a written plan you can approve before it executes the steps.',
          'Ask you a clarifying question with up to four pre-written answer options.',
          'Search the web (when enabled in Settings).',
        ],
      },
      { kind: 'h', text: 'How runs end' },
      {
        kind: 'ul',
        items: [
          'Done — the agent emits a wrap-up message and stops calling tools.',
          'Stopped — you cancelled (single-button pause then cancel, or the keyboard).',
          'Capped — hit the 100-turn safety limit.',
          'Error — provider error, missing API key, etc.',
          'Abandoned — you started a new chat or quit the app while a paused conversation was alive.',
        ],
      },
      {
        kind: 'note',
        text: "Access also supports the slash menu — type / to invoke a saved automation as part of an ad-hoc Access prompt (e.g. \"check the build status with /OA-3, then summarise\").",
      },
    ],
  },
  {
    id: 'mode-automate',
    category: 'The three modes',
    title: 'Automate mode',
    summary: 'Access mode with optional recording + replay.',
    blocks: [
      {
        kind: 'p',
        text: 'Automate is identical to Access at runtime — same tools, same approval gates, same plan flow. The two extras are: a Record toggle that saves the next run as a reusable routine, and the slash menu for invoking saved routines.',
      },
      { kind: 'h', text: 'When to use Automate' },
      {
        kind: 'ul',
        items: [
          "You're about to run a task you'll repeat (weekly invoice sending, daily build check, recurring data prep).",
          "You want to invoke an existing routine via /OA-N as part of a larger prompt.",
        ],
      },
      {
        kind: 'p',
        text: 'See the Automations section for everything routine-related: how recording works, what gets captured, how replay handles screen-state shifts, and how to edit a routine after the fact.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Composing prompts
  // -------------------------------------------------------------------------
  {
    id: 'prompt-input',
    category: 'Composing prompts',
    title: 'The prompt field',
    summary: 'Submit, attach, and reference routines from one input.',
    blocks: [
      { kind: 'h', text: 'Submitting' },
      {
        kind: 'ul',
        items: [
          'Click the Send button, or',
          'Press Cmd/Ctrl + Enter from inside the textarea.',
        ],
      },
      { kind: 'h', text: 'Sending images' },
      {
        kind: 'p',
        text: 'The 📎 button opens a file picker. Selected images are attached to the next prompt — you\'ll see thumbnails inside the prompt frame. Hit Send and they ride along with your message + the screenshot.',
      },
      { kind: 'h', text: 'Mid-loop interrupts' },
      {
        kind: 'p',
        text: 'While an Access or Automate run is going, the prompt field stays editable. Anything you type gets queued for the agent\'s next turn — you\'ll see "⏎ Queued for next turn" appear under the prompt area to confirm it landed. The agent acknowledges your interrupt in its next response and adjusts course.',
      },
      { kind: 'h', text: 'Smart capture reuse' },
      {
        kind: 'p',
        text: "Optix avoids re-screenshotting when nothing relevant changed. If you submit a follow-up within ~30s while still in the same window, the previous screenshot is reused — saving the capture latency.",
      },
    ],
  },
  {
    id: 'slash-menu',
    category: 'Composing prompts',
    title: 'Slash menu and /OA-N tokens',
    summary: 'Reference saved automations from any prompt.',
    blocks: [
      {
        kind: 'p',
        text: 'Type / anywhere in the prompt — at the start of a sentence or in the middle — and the slash menu opens above the input. It lists every saved automation, filtered as you type.',
      },
      { kind: 'h', text: 'Keyboard navigation' },
      {
        kind: 'ul',
        items: [
          '↑ / ↓ — cycle through filtered routines.',
          'Enter — pick the highlighted routine.',
          'Esc — close the menu and remove the / token.',
          'Click — pick a routine with the mouse.',
        ],
      },
      { kind: 'h', text: 'How references render' },
      {
        kind: 'p',
        text: 'When you pick a routine, the / token is replaced in place with /OA-N (where N is the routine\'s ID). The chip renders as white-on-blue inside the textarea so the reference is visible at a glance.',
      },
      { kind: 'h', text: 'Multiple routines per prompt' },
      {
        kind: 'p',
        text: 'You can chain references: "Run /OA-3 then run /OA-7 and post a summary." Each token is resolved independently and the agent receives one hint block per referenced routine.',
      },
      {
        kind: 'note',
        text: 'The slash menu is available in Access AND Automate. It\'s not available in Ask mode (which is a single-shot, not an agent loop).',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Header & layout
  // -------------------------------------------------------------------------
  {
    id: 'pause-cancel',
    category: 'Header & layout',
    title: 'Pause and cancel',
    summary: 'One button does both: click to pause, double-click to cancel.',
    blocks: [
      {
        kind: 'p',
        text: 'During an Access or Automate run, the action row holds a single circular control. Its icon tells you what state the run is in:',
      },
      {
        kind: 'ul',
        items: [
          'Pause bars — the run is going. Click to pause; double-click to cancel.',
          'Play arrow (highlighted) — the run is paused. Click to resume; double-click to cancel.',
          'Stop square — the run is in an Ask single-shot. One click cancels.',
          'Stop square (dim) — nothing is in flight; the button is disabled.',
        ],
      },
      { kind: 'h', text: 'Why pause is asymmetric' },
      {
        kind: 'p',
        text: "Pausing is instant — the agent stops at the next safe boundary right away. Resuming is delayed by ~220 ms so a follow-up double-click can cancel without the run briefly continuing first. The pause button stays highlighted while paused, mirroring the active-folder treatment.",
      },
      {
        kind: 'note',
        text: "Pausing only works for the agent loop, not for an in-flight Ask request. The model is generating tokens on the provider's servers — nothing local can pause it. Cancel works in all three modes.",
      },
    ],
  },
  {
    id: 'compact-mode',
    category: 'Header & layout',
    title: 'Compact mode',
    summary: 'Minimise to a header strip, snap to bottom-right.',
    blocks: [
      {
        kind: 'p',
        text: 'The dash button (–) in the header collapses the widget to its header strip. Click ▴ to expand again.',
      },
      {
        kind: 'ul',
        items: [
          'Compact view always snaps to the bottom-right corner of whichever monitor you\'re on — predictable dock spot.',
          'Drag is locked while compact, so the dock stays put.',
          'Expanding restores the same height the widget had before, anchored at the bottom edge.',
          'The transition is animated (~180ms ease-out).',
        ],
      },
    ],
  },
  {
    id: 'drag-region',
    category: 'Header & layout',
    title: 'Moving the widget',
    summary: 'Where you can grab to drag.',
    blocks: [
      {
        kind: 'p',
        text: 'The expanded widget is draggable from any non-interactive surface — header chrome, the empty area in the controls row, the prompt frame border, the actions row gaps, and notification banners.',
      },
      {
        kind: 'p',
        text: "Buttons, the textarea, the chat body, and the attachment thumbs ignore drag so clicking and selecting text work the way you'd expect. In compact mode the whole strip is locked to the bottom-right.",
      },
    ],
  },
  {
    id: 'clear-chat',
    category: 'Header & layout',
    title: 'Clear chat',
    summary: 'Abort and start fresh without losing your saved plan.',
    blocks: [
      {
        kind: 'p',
        text: "The new-chat icon at the right of the controls row aborts whatever's in flight, drops the conversation thread, clears the active turn, empties the prompt and attachments, and resets to idle. It's disabled when there's nothing to clear.",
      },
      {
        kind: 'p',
        text: "It does NOT clear your saved plan — that's managed separately from the plan view's Clear button. Most \"new chat\" flows still want the plan around.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Agent tools
  // -------------------------------------------------------------------------
  {
    id: 'tool-computer',
    category: 'Agent tools',
    title: 'Computer tool — clicks, typing, scroll',
    summary: 'How the agent drives your mouse and keyboard.',
    blocks: [
      {
        kind: 'p',
        text: 'The computer tool is the agent\'s low-level UI control surface. Every visible interaction maps to one of:',
      },
      {
        kind: 'ul',
        items: [
          'left_click / right_click / middle_click / double_click / triple_click — at a screen pixel coordinate.',
          'left_click_drag — start coord → end coord.',
          'mouse_move / left_mouse_down / left_mouse_up — for fine-grained drag composition.',
          'type — typed character-by-character via robotjs.',
          'key — a single key or combo (e.g. ctrl+s, alt+tab).',
          'hold_key — hold a key for N seconds (game inputs, long-press).',
          'scroll — direction + amount.',
          'screenshot — explicit screen capture (the agent normally gets one for free after each action).',
          'wait — pause between actions when the UI needs settle time.',
          'cursor_position — read the current mouse position.',
        ],
      },
      {
        kind: 'note',
        text: "Coordinates are pixels in the screenshot, mapped 1:1 to the screen. With weaker vision models (Kimi, Gemini), Optix snaps clicks to nearby UIA elements automatically — Anthropic and OpenAI hit pixels accurately and skip the snap.",
      },
    ],
  },
  {
    id: 'tool-file',
    category: 'Agent tools',
    title: 'File tools — read, write, list, search',
    summary: 'Filesystem access without leaving the agent loop.',
    blocks: [
      {
        kind: 'ul',
        items: [
          'list_directory — entries with type tag (D/F/L) and size, capped at 500 per call.',
          'read_file — UTF-8 text, capped at 100 KB.',
          'search_files — glob or substring, capped at 200 hits with depth 8; skips hidden, node_modules, __pycache__.',
          'write_file — overwrites or creates. The model must explicitly send "" for an empty file.',
          'create_directory — creates one new level (no silent deep mkdirs).',
        ],
      },
      { kind: 'h', text: 'Workspace boundary' },
      {
        kind: 'p',
        text: 'When you set an Agent workspace folder, file actions inside it follow your approval mode (silent in never, gated in per-action / per-task). Anything outside it is a hard boundary — always gated, even in never mode.',
      },
      {
        kind: 'p',
        text: 'Symlink escapes are caught: paths get realpath-resolved before any check, so a symlink in your workspace pointing at /etc/passwd doesn\'t bypass the scope check.',
      },
    ],
  },
  {
    id: 'tool-shell',
    category: 'Agent tools',
    title: 'Shell — run_command',
    summary: 'Non-interactive shell commands with timeouts and output caps.',
    blocks: [
      {
        kind: 'p',
        text: 'Use this for the things you\'d type in a terminal: package installs, tests, builds, git ops, batch file work. The agent calls run_command with a command string and an optional cwd.',
      },
      { kind: 'h', text: 'Defaults and limits' },
      {
        kind: 'ul',
        items: [
          'Default timeout: 60 s. Hard cap: 120 s.',
          'Output cap: 16 KB. The TAIL is kept (build/test logs are most informative at the end).',
          'cwd default: your workspace folder if set, else your home directory.',
          'Output comes back as exit code + stdout/stderr (interleaved with [stderr] tags so the model can tell which stream produced what).',
        ],
      },
      { kind: 'h', text: 'What it can\'t do' },
      {
        kind: 'ul',
        items: [
          "Interactive REPLs (sudo password prompts, ssh password, npm init wizards) — they hang and timeout.",
          "Long-running services (npm run dev, file watchers, vite dev server) — they exceed the timeout.",
          'Anything destructive without your explicit Approve. Out-of-workspace cwd always prompts; per-task and per-action both gate every shell command.',
        ],
      },
    ],
  },
  {
    id: 'tool-plan',
    category: 'Agent tools',
    title: 'Plan tool',
    summary: 'The agent writes a plan, you approve it.',
    blocks: [
      {
        kind: 'p',
        text: 'For complex multi-step tasks (coding, multi-file edits, long automation chains), the agent calls the plan tool first with a numbered list of concrete steps. The run pauses, the plan renders inline, and you choose:',
      },
      {
        kind: 'ul',
        items: [
          'Approve — the plan is saved to disk and echoed back to the agent so it can reference it as it executes.',
          'Deny — the plan is rejected; the agent has to revise.',
          'Type feedback — send a correction so the agent can revise (e.g. "skip step 4, do these steps in /tmp instead of ~").',
        ],
      },
      { kind: 'h', text: 'One plan at a time' },
      {
        kind: 'p',
        text: 'Calling the plan tool again overwrites the saved plan — the right move when scope changes mid-task. The plan persists across runs and across app restarts; it\'s only cleared when you click Clear in the plan view, or when the agent revises it.',
      },
      {
        kind: 'p',
        text: 'When a plan exists, the Plan icon in the controls row lights up. Click to open the plan view at any time. The plan is also pinned at the top of the body as a banner so you can glance at it during the run.',
      },
    ],
  },
  {
    id: 'tool-ask-user',
    category: 'Agent tools',
    title: 'Ask user — multi-choice prompts',
    summary: 'The agent pauses to ask you a clarifying question.',
    blocks: [
      {
        kind: 'p',
        text: "When the agent can't reliably infer the next step (which folder, which file, which option) it pauses and asks. You see the question + up to four pre-written answer options as buttons. If the agent enabled freeform input, you also get a text box for typing a custom answer.",
      },
      {
        kind: 'p',
        text: 'Pick an option (or type) and the agent resumes with your answer as the tool result for that turn. Multi-round questioning is fine — the agent can ask again if your answer prompts a follow-up.',
      },
    ],
  },
  {
    id: 'tool-web-search',
    category: 'Agent tools',
    title: 'Web search',
    summary: 'Toggleable. Native where available, DuckDuckGo as fallback.',
    blocks: [
      {
        kind: 'p',
        text: 'Turn on Web search in Settings to give the agent a search tool. Anthropic and Gemini route through their providers\' native grounded-search; the OpenAI and Kimi paths fall back to DuckDuckGo HTML and feed the results into the model.',
      },
      {
        kind: 'p',
        text: 'Result URLs are filtered to http/https only — javascript: and other schemes are dropped before the model sees them, so a poisoned search response can\'t trick the agent into asking you to open a dangerous link.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Approvals & safety
  // -------------------------------------------------------------------------
  {
    id: 'approval-modes',
    category: 'Approvals & safety',
    title: 'Approval modes',
    summary: 'Per-task, per-action, or never — pick how chatty the gate is.',
    blocks: [
      { kind: 'h', text: 'Per-task (default)' },
      {
        kind: 'p',
        text: 'You confirm once at the start of each Access loop. After that, only file writes (write_file) and shell commands gate individually — every other action runs silently. Good middle ground for most use.',
      },
      { kind: 'h', text: 'Per-action' },
      {
        kind: 'p',
        text: 'Every action except a no-op screenshot gates. You see Approve / Deny / Type feedback for each one. Slowest, safest, best for unfamiliar tasks.',
      },
      { kind: 'h', text: 'Never' },
      {
        kind: 'p',
        text: "No prompts. The agent runs through to completion. The Stop button is your safety. Out-of-workspace file ops and shell commands STILL gate even in never mode — that's the hard boundary.",
      },
      {
        kind: 'note',
        text: "Switch modes anytime in Settings — the change applies to the next loop, not the one that's currently running.",
      },
    ],
  },
  {
    id: 'workspace',
    category: 'Approvals & safety',
    title: 'Workspace folder',
    summary: 'A trusted directory the agent can work in without prompts.',
    blocks: [
      {
        kind: 'p',
        text: 'Click the folder icon in the controls row to pick a workspace. While set, file actions and shell commands inside that folder follow your approval mode normally. Anything outside it gates with explicit Approve/Deny/Type feedback, regardless of mode.',
      },
      { kind: 'h', text: 'Why it\'s session-only' },
      {
        kind: 'p',
        text: "Workspace scope grants in-scope actions a degree of trust. To keep that intentional, the workspace doesn't persist across launches — every session starts with no scope set. Pick the folder you want, work, close. Next session you'll explicitly set it again.",
      },
    ],
  },
  {
    id: 'pricing-cap',
    category: 'Approvals & safety',
    title: 'Cost ceiling',
    summary: 'Stop a run when its estimated USD cost crosses a number you set.',
    blocks: [
      {
        kind: 'p',
        text: 'Set Cost ceiling (USD) in Settings to cap a single Access loop. After every turn, Optix estimates the cost from the provider\'s reported token usage and the per-model price table. If the running total exceeds your ceiling, the loop stops with a "stopped — estimated cost exceeded ceiling" message.',
      },
      {
        kind: 'p',
        text: "Costs are estimates — they're as accurate as the per-model rates baked into Optix's pricing table. If a provider changes prices and we haven't updated, your real bill might differ slightly.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // History & logs
  // -------------------------------------------------------------------------
  {
    id: 'access-logs',
    category: 'History & logs',
    title: 'Access Logs',
    summary: 'Every Access run, with messages, turns, actions, and cost.',
    blocks: [
      {
        kind: 'p',
        text: "Open via Settings → Access Logs. The list shows every Access run newest-first. Each row carries an outcome badge (✓ done, ✗ stopped, ⊘ capped, ! error, ◌ abandoned), the relative time, the prompt, and quick stats: messages, turns, actions, estimated cost.",
      },
      { kind: 'h', text: 'Detail view' },
      {
        kind: 'p',
        text: 'Click a row to drill in. The meta card shows outcome, time range, message/turn/action counts, model + provider, screenshot resolution, and total cost. Below that, every user message gets its own section with the agent\'s turns nested underneath. Each turn shows API latency, token usage (input ↓ / output ↑ / cache write ⤓ / cache read ⤒), the model\'s narration, and every action with its result.',
      },
      { kind: 'h', text: 'Export and delete' },
      {
        kind: 'p',
        text: 'The detail header has buttons to export the run as Markdown, plain text, or raw JSON, and a Delete button to remove the log.',
      },
    ],
  },
  {
    id: 'ask-logs',
    category: 'History & logs',
    title: 'Ask Logs',
    summary: 'Saved Ask conversations with attachment thumbnails.',
    blocks: [
      {
        kind: 'p',
        text: "Open via Settings → Ask Logs. Each row shows the provider badge, time, conversation title (auto-derived from the first prompt), turn count, screenshot count, and estimated cost.",
      },
      {
        kind: 'p',
        text: "Detail mirrors the Access Logs layout. Each turn renders the user message and any attached images as inline thumbnails, then the agent's answer + its numbered steps. Thumbnails are lazy-loaded from disk via IPC so a long history doesn't pay a heavy upfront cost.",
      },
      {
        kind: 'p',
        text: 'Conversations only get saved when Conversation mode is on — single-shot Asks are not persisted (they live only in the current session\'s view).',
      },
    ],
  },
  {
    id: 'plan-view',
    category: 'History & logs',
    title: 'Plan view',
    summary: "Read or clear the agent's active plan.",
    blocks: [
      {
        kind: 'p',
        text: 'When a plan is saved, the Plan icon in the controls row lights up. Click to open the plan view. You see the plan content (Markdown-style numbered list, rendered as preformatted text), an optional rationale line if the agent provided one, and the created/updated timestamps.',
      },
      {
        kind: 'p',
        text: "The Clear button discards the plan. Useful when you want to start a fresh task and don't want the previous plan biasing the agent.",
      },
      {
        kind: 'p',
        text: "There's also a pinned banner at the top of the chat body when a plan is active — click it to jump straight to the plan view.",
      },
    ],
  },
  {
    id: 'automations-list',
    category: 'History & logs',
    title: 'Automations list',
    summary: 'Every routine you\'ve recorded, with edit and run.',
    blocks: [
      {
        kind: 'p',
        text: 'Open via Settings → Automations. Each row shows the OA-N badge (the routine\'s ID), relative update time, the routine name, and stats: turns, actions, cost.',
      },
      {
        kind: 'p',
        text: 'Click a row to enter the detail view, where you can rename, edit the original prompt, reorder actions with ↑/↓, delete actions, save your edits, run the routine, or delete it entirely. Each action shows its target element name (humanised — "text field" rather than "ControlType.Edit") and the window it was performed in.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Automations
  // -------------------------------------------------------------------------
  {
    id: 'recording',
    category: 'Automations',
    title: 'Recording a routine',
    summary: 'Toggle Record, run a task, get a reusable automation.',
    blocks: [
      { kind: 'h', text: 'Step by step' },
      {
        kind: 'ul',
        items: [
          'Switch to Automate mode.',
          'Click the Record button — it lights up red to show recording is armed.',
          'Type your task and press Send.',
          'Run normally: the agent performs actions and you approve them as you would in Access mode.',
          'When the run completes, the routine saves automatically and the Record toggle resets.',
        ],
      },
      { kind: 'h', text: 'What gets captured' },
      {
        kind: 'ul',
        items: [
          'Your original prompt.',
          'Every successful action (failed actions are skipped — they wouldn\'t replay productively).',
          'The agent\'s narration per turn (its reasoning trail).',
          'The UIA element name + control type at each click point (e.g. "Submit" of type Button).',
          'The foreground window title at every action.',
          'Total turns + token cost + initial screenshot resolution.',
        ],
      },
      {
        kind: 'note',
        text: 'Recording is per-run — the toggle resets after each save. Click it again before your next prompt to record another routine.',
      },
    ],
  },
  {
    id: 'replay',
    category: 'Automations',
    title: 'Replaying a routine',
    summary: 'Type / and pick. Add free text around the token if you want.',
    blocks: [
      {
        kind: 'p',
        text: 'In Access or Automate mode, type / to open the slash menu, pick a routine, hit Send. The agent receives your prompt plus a hint block with every recorded action — element name, window, the agent\'s previous reasoning — and re-runs the task.',
      },
      { kind: 'h', text: 'Hint-based, not verbatim' },
      {
        kind: 'p',
        text: "The agent doesn't blindly replay coordinates. It gets a numbered list of actions with semantic anchors (\"click the Submit button in window 'Login'\") and is told: prefer matching by element name + window over raw pixel coordinates, adapt where current state differs (window moved, dialog already closed, file already exists), but stay faithful to the recorded sequence.",
      },
      {
        kind: 'p',
        text: 'This way recordings survive minor layout shifts. The trade-off: replay still costs API tokens because the model is in the loop. If you want zero-cost verbatim replay, that\'s a future feature.',
      },
      { kind: 'h', text: 'Composing routines into prompts' },
      {
        kind: 'p',
        text: 'You can wrap free text around the token: "Run /OA-3 then take a screenshot and tell me what you see." Multiple tokens are supported: "Do /OA-1 followed by /OA-7." Each gets its own hint block.',
      },
    ],
  },
  {
    id: 'editing-routines',
    category: 'Automations',
    title: 'Editing a routine',
    summary: 'Rename, reprompt, reorder actions, drop ones that misfired.',
    blocks: [
      {
        kind: 'p',
        text: 'Open Settings → Automations, click a routine, and you land in the detail view. Editable fields:',
      },
      {
        kind: 'ul',
        items: [
          'Name — the title that shows in the slash menu and list.',
          'Original prompt — the text fed back to the agent on replay (you can change scope, add notes, etc.).',
          'Actions — reorder with ↑/↓, delete with ✕ if a step misfired and you want to skip it next time.',
        ],
      },
      {
        kind: 'p',
        text: 'Save persists the edits to disk and bumps the updatedAt timestamp. Run executes the (possibly edited) routine right then; the Run button is only present when there\'s a way to run from the current view.',
      },
      {
        kind: 'note',
        text: 'Per-action data (the click coordinate, the typed text, the shell command) is currently not editable from the UI — only reorder and delete. If you need to change the substance of an action, re-record the routine.',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Settings reference
  // -------------------------------------------------------------------------
  {
    id: 'settings-provider',
    category: 'Settings reference',
    title: 'Provider, model, API key',
    summary: 'Pick a provider, plug in a key, choose a model.',
    blocks: [
      { kind: 'h', text: 'Provider' },
      {
        kind: 'p',
        text: 'Anthropic, OpenAI, Kimi (Moonshot), or Google Gemini. Each provider has its own API key and its own list of supported models.',
      },
      { kind: 'h', text: 'Model' },
      {
        kind: 'p',
        text: "The dropdown lists curated models for the active provider. Pick \"Custom\" and paste a model id if you need one that isn't in the list (e.g. a beta model your account has access to).",
      },
      { kind: 'h', text: 'API key' },
      {
        kind: 'p',
        text: 'Save writes the key to your OS keychain (Windows Credential Manager, macOS Keychain). Test makes a tiny request to verify it works. Remove deletes it. Keys never leak into log files, audit JSON, or settings — they live only in the keychain and a short-lived in-process cache.',
      },
    ],
  },
  {
    id: 'settings-behaviour',
    category: 'Settings reference',
    title: 'Behaviour toggles',
    summary: 'Conversation, web search, overlay, privacy.',
    blocks: [
      {
        kind: 'ul',
        items: [
          'Conversation mode — multi-turn chats: prior turns are kept as context for the model. With it off, every prompt is a one-shot.',
          'Web search — gives the agent a search tool. Native via Anthropic / Gemini, DuckDuckGo HTML fallback for OpenAI / Kimi.',
          'Show overlay — when on, the model includes target regions for walkthrough steps so you can highlight the answer on screen.',
          'Pause capture (privacy) — stops sending screenshots to the model. The agent runs blind; useful while you\'re entering credentials or other sensitive data.',
        ],
      },
    ],
  },
  {
    id: 'settings-agent',
    category: 'Settings reference',
    title: 'Agent settings',
    summary: 'Approval mode, cost ceiling, workspace folder.',
    blocks: [
      {
        kind: 'ul',
        items: [
          'Approval mode — Per-task / Per-action / Never. See "Approval modes" for what each does.',
          'Cost ceiling (USD) — stop a run when its estimated cost exceeds this. Empty = no cap.',
          "Workspace folder — set via the folder icon in the controls row. Inside this folder, file ops follow your approval mode; outside, they always gate. Session-only — doesn't persist across launches.",
        ],
      },
    ],
  },
  {
    id: 'settings-data',
    category: 'Settings reference',
    title: 'Where your data lives',
    summary: 'Audit logs, plans, routines, conversations on disk.',
    blocks: [
      {
        kind: 'p',
        text: 'Optix stores everything under your OS user-data directory:',
      },
      {
        kind: 'ul',
        items: [
          'Windows: %APPDATA%\\@optix\\desktop',
          'macOS: ~/Library/Application Support/@optix/desktop',
          'Linux: ~/.config/@optix/desktop',
        ],
      },
      {
        kind: 'p',
        text: 'Inside that directory:',
      },
      {
        kind: 'ul',
        items: [
          'audit/loops/ — one JSON per Access run, sorted by timestamp.',
          'conversations/<id>/ — one folder per Ask conversation, with conversation.json + an images/ subfolder for attachments.',
          'routines/<id>.json — one file per saved automation.',
          'plans/current.json — the single global active plan.',
        ],
      },
      {
        kind: 'p',
        text: "API keys are NOT in any of those — they live in your OS keychain. Settings are in the standard electron-store config file in the same user-data directory.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Optix Cloud
  // -------------------------------------------------------------------------
  {
    id: 'cloud-overview',
    category: 'Optix Cloud',
    title: 'What Optix Cloud is',
    summary: "Managed Claude access — no API key required, billed monthly.",
    blocks: [
      {
        kind: 'p',
        text: 'Optix Cloud is a managed plan that runs your prompts through our backend instead of your own API key. You sign in with email, pick a tier, and Claude Opus 4.7 is included — Ask, Access, and Automate all work the same as the BYO-key path.',
      },
      {
        kind: 'h',
        text: 'Why use it',
      },
      {
        kind: 'ul',
        items: [
          "No API key to manage or rotate — sign in with email and you're done.",
          'Predictable monthly billing instead of pay-per-token Anthropic invoices.',
          'Web search, prompt caching, and Computer Use all included.',
          'Usage meter in Settings shows exactly where you are in your monthly allowance.',
        ],
      },
      {
        kind: 'h',
        text: 'When to stick with BYO key',
      },
      {
        kind: 'p',
        text: 'If you already pay Anthropic directly, want a non-Claude provider (OpenAI, Gemini, Kimi), or run very low volume where pay-per-use beats a flat monthly fee — keep your existing setup. Switching providers is a single radio button in Settings; nothing about Optix Cloud is required.',
      },
      {
        kind: 'note',
        text: "Your data still stays local. The relay forwards request bodies to Anthropic verbatim and never logs them — only token counts, for billing.",
      },
    ],
  },
  {
    id: 'cloud-plans',
    category: 'Optix Cloud',
    title: 'Pricing and plans',
    summary: 'Starter and Pro tiers, monthly token allowances, what happens at the cap.',
    blocks: [
      {
        kind: 'h',
        text: 'Starter — $49 / month',
      },
      {
        kind: 'ul',
        items: [
          '5 million tokens per month',
          'Claude Opus 4.7 included',
          'Ask + Access + Automate',
          'Web search included',
        ],
      },
      {
        kind: 'h',
        text: 'Pro — $99 / month',
      },
      {
        kind: 'ul',
        items: [
          '15 million tokens per month',
          'Claude Opus 4.7 included',
          'Ask + Access + Automate',
          'Web search included',
          'Priority support',
        ],
      },
      {
        kind: 'h',
        text: 'How tokens are counted',
      },
      {
        kind: 'p',
        text: "Every API call that goes through the relay — Ask, Access, Automate, web search — adds to your monthly count. Input, output, cache-read, and cache-create tokens are all summed. The Settings panel shows the running total live, e.g. \"7.5k / 15M\".",
      },
      {
        kind: 'h',
        text: 'When you hit the cap',
      },
      {
        kind: 'p',
        text: "The relay returns a 429 error and your next prompt fails with a clear message. The cap resets on the first day of each calendar month (UTC). If you hit the limit mid-month and need more, upgrading to Pro takes effect immediately — Stripe prorates the difference.",
      },
    ],
  },
  {
    id: 'cloud-signin-and-subscribe',
    category: 'Optix Cloud',
    title: 'Signing in and subscribing',
    summary: 'Magic link via email, Stripe Checkout in your browser, back to the widget.',
    blocks: [
      {
        kind: 'p',
        text: 'Sign-in is email-only — no password, no account creation form. The widget sends a one-time link to your inbox; clicking it signs you in.',
      },
      {
        kind: 'h',
        text: 'Step by step',
      },
      {
        kind: 'ul',
        items: [
          'In Settings, switch the active provider to Optix Cloud.',
          "Enter your email and click \"Send sign-in link\".",
          'Check your inbox and click the link — your default browser opens briefly, you see a "Signed in" page, then the widget updates automatically.',
          'Pick Starter or Pro from the pricing cards. Stripe Checkout opens in your browser.',
          'Pay with card or Apple/Google Pay. After payment, the browser shows "Subscription confirmed" and the widget unlocks within a second or two.',
        ],
      },
      {
        kind: 'p',
        text: "The handoff between widget and browser uses a localhost listener bound to 127.0.0.1 — only your own machine can reach it, and it shuts down the moment the callback arrives or after 10 minutes if you abandon the flow.",
      },
      {
        kind: 'note',
        text: "If your browser doesn't auto-fire the magic link, paste the link from your inbox into the same browser. Don't paste it back into the widget — the widget can't read browser URL bars.",
      },
    ],
  },
  {
    id: 'cloud-manage-subscription',
    category: 'Optix Cloud',
    title: 'Managing your subscription',
    summary: 'Upgrade, downgrade, cancel, and reactivate from Settings.',
    blocks: [
      {
        kind: 'p',
        text: "When you're subscribed, Settings shows your email + plan + monthly usage on top, with action buttons on the right.",
      },
      {
        kind: 'h',
        text: 'Upgrade or Downgrade',
      },
      {
        kind: 'p',
        text: "If you're on Starter, the button reads Upgrade and switches you to Pro. If you're on Pro, it reads Downgrade and switches you to Starter. The change is immediate — Stripe prorates the difference for the rest of the current cycle, and your token allowance updates the moment Stripe confirms (usually a second or two).",
      },
      {
        kind: 'h',
        text: 'Cancel Plan',
      },
      {
        kind: 'p',
        text: "Cancelling does NOT cut off access — you keep Optix Cloud until the end of the current paid period, then it auto-stops. The Settings panel shows \"ends on <date>\" so you know when. Until that date you can hit Reactivate to undo the cancellation; no second payment, just back to active.",
      },
      {
        kind: 'h',
        text: 'Sign out',
      },
      {
        kind: 'p',
        text: "Sign out logs you out of Optix Cloud locally but does NOT cancel your subscription. To stop being billed you need to click Cancel Plan — those are independent actions.",
      },
      {
        kind: 'h',
        text: 'Privacy',
      },
      {
        kind: 'p',
        text: "The relay forwards every request body byte-for-byte to Anthropic and never logs the content. What's stored on our side: your email, your plan + tier, the current period end, and per-month token totals (input, output, cache hits, request count). Nothing about WHAT you asked or what Claude replied is recorded.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Tips
  // -------------------------------------------------------------------------
  {
    id: 'tip-good-prompts',
    category: 'Tips',
    title: 'Writing prompts the agent follows well',
    summary: "Be specific about scope. Use plans for complex work.",
    blocks: [
      {
        kind: 'ul',
        items: [
          "Set the workspace folder before any file work. It cuts approval noise inside scope and prevents accidental writes outside it.",
          "For complex multi-step tasks, ask the agent to make a plan first. Approving an explicit plan is much faster than approving 30 separate actions.",
          "Be specific about names: \"open the 'invoices' folder on the desktop\" beats \"open my invoices folder.\"",
          "If the agent picks the wrong target on a click, type feedback in the per-action gate (\"click the Submit button in the dialog, not the search bar\") — it'll re-pick.",
          "Record routines for anything you do more than twice. Replay via /OA-N is one keystroke once it exists.",
        ],
      },
    ],
  },
  {
    id: 'tip-troubleshooting',
    category: 'Tips',
    title: 'Troubleshooting',
    summary: "Common surprises and how to recover.",
    blocks: [
      { kind: 'h', text: '"Your credit balance is too low"' },
      {
        kind: 'p',
        text: 'Top up your provider account, or switch to a different provider with credit (Settings → Provider).',
      },
      { kind: 'h', text: 'Run won\'t cancel cleanly' },
      {
        kind: 'p',
        text: 'Double-click the pause/cancel button. If a recording was active, it gets discarded — partial recordings would replay weirdly.',
      },
      { kind: 'h', text: 'The agent keeps clicking the wrong thing' },
      {
        kind: 'p',
        text: "Switch to per-action approval and type feedback explicitly: \"the Submit button is the green one near the bottom, not the form field.\" The model will try again with that hint. If you're on Kimi or Google, switching to Anthropic or OpenAI will usually help — visual click accuracy varies a lot by model.",
      },
      { kind: 'h', text: 'Slash menu won\'t open' },
      {
        kind: 'p',
        text: "You're in Ask mode — the slash menu is Access/Automate only. Switch modes; the / token will activate the menu the next time you type it.",
      },
      { kind: 'h', text: 'Compact widget won\'t move' },
      {
        kind: 'p',
        text: "By design — compact mode is locked at the bottom-right of the current monitor. Expand to drag, then collapse again when you're done.",
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Support
  // -------------------------------------------------------------------------
  {
    id: 'getting-help',
    category: 'Support',
    title: 'Getting help',
    summary: 'Reach out about a bug, feature request, or anything else.',
    blocks: [
      {
        kind: 'p',
        text: "If something isn't working, you've found a bug, or you want to suggest a feature, send a message via the form below. Replies usually come within 1–2 business days.",
      },
      {
        kind: 'p',
        text: "Common things to mention: which mode you were in (Ask / Access / Automate), which provider, what the agent did vs what you expected, and any error messages from the toast or the audit log.",
      },
      { kind: 'h', text: 'Before you submit' },
      {
        kind: 'ul',
        items: [
          "Check the Audit log button in the header — most Access/Automate runs leave a JSON record there with messages, actions, errors, and timing.",
          "Try the same prompt with a different provider — visual click accuracy varies a lot, especially on Kimi and Gemini.",
          "If the widget itself is misbehaving (won't open, hotkey stuck, etc.), restart the app first; some bugs only repro on cold-start and we want to know.",
          "For privacy-related concerns, mention that explicitly — those go to the top of the queue.",
        ],
      },
      { kind: 'h', text: 'Send a message' },
      { kind: 'form', formId: 'support' },
      {
        kind: 'note',
        text: "Diagnostic info (app version, OS, active provider) is included automatically so we can reproduce issues faster. If the in-app send fails, the form will offer a one-click fallback to open your email client with the same message pre-filled.",
      },
    ],
  },
];
