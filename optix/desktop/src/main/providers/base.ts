import type {
  ImageAttachment,
  Mode,
  ModelResponse,
  PriorTurn,
  ProviderId,
  TokenUsage,
} from '@shared/schemas';

// Round 9.2: explicit undefined for exactOptionalPropertyTypes
export type PromptInput = {
  mode: Mode;
  prompt: string;
  modelId: string;
  /** Raw image bytes — provider converts to its own format (data URL, raw base64, etc.) */
  imageBytes?: Uint8Array | undefined;
  /** MIME type of `imageBytes`, e.g. 'image/jpeg'. */
  imageMimeType?: string | undefined;
  /** User-attached reference images (uploaded via the paperclip button).
   *  Each provider should add an image block per attachment to the user-
   *  message content, BEFORE the prompt text but AFTER the screenshot
   *  (when present). */
  imageAttachments?: ImageAttachment[] | undefined;
  /** Past Q&A pairs from the same conversation — each provider should
   *  prepend them to the message history as alternating user/assistant
   *  turns so the model has context for follow-up questions. Empty when
   *  conversationMode is off or this is the first turn. */
  priorTurns?: PriorTurn[] | undefined;
  signal: AbortSignal;
  /** Called for each token delta during streaming providers. Other providers ignore. */
  onChunk?: ((delta: string) => void) | undefined;
  /** Whether the provider should enable its web-search tool. */
  webSearchEnabled?: boolean | undefined;
  /** Fired with the search query when the model invokes web search. */
  onSearch?: ((query: string) => void) | undefined;
  /** Fired for each source URL the model consulted (after dedup happens upstream). */
  onSource?: ((source: { url: string; title: string }) => void) | undefined;
  /** Fired once with the API's token usage block for cost-tracking.
   *  Each provider extracts the values it has (Anthropic exposes the
   *  full set including cache hits; OpenAI/Gemini expose the basics).
   *  Missing fields stay undefined; the cost estimator treats those
   *  as zero. Called after the provider's final response is parsed,
   *  before the function returns. */
  onUsage?: ((usage: TokenUsage) => void) | undefined;
  /** Whether the model should include target-region bounding boxes in walkthrough steps. */
  overlayEnabled?: boolean | undefined;
};

// Round 9.2: explicit undefined for exactOptionalPropertyTypes
export type SystemPromptOptions = {
  webSearchEnabled?: boolean | undefined;
  overlayEnabled?: boolean | undefined;
};

export interface Provider {
  readonly id: ProviderId;
  prompt(input: PromptInput, apiKey: string): Promise<ModelResponse>;
  testKey(apiKey: string): Promise<void>;
}

// The system prompt we send to every model. Asking for JSON *and* validating
// with Zod gives us two layers of defense against malformed output.
export function buildSystemPrompt(mode: Mode, options: SystemPromptOptions = {}): string {
  // Region instructions are only included when the user has the overlay
  // enabled. Skipping them when off saves significant prompt tokens (the
  // coordinate explanation is verbose) and tells the model not to spend
  // output tokens on coordinates that won't be used.
  const regionGuidance = options.overlayEnabled
    ? ' For each walkthrough step that points at a specific UI element visible in the screenshot, populate `targetRegion` with a tight bounding box: `label` is the element\'s visible text or a short description, and `x`/`y`/`width`/`height` are integer pixel coordinates in the screenshot\'s coordinate space (origin top-left). Skip `targetRegion` for steps that aren\'t about a specific element.'
    : ' Leave `targetRegion` and `targetRegions` empty — the user has overlay disabled.';

  // The LOCATE rule is a separate, prominent block — models tend to
  // skip targetRegions even when instructed inline. Hoisting it to its
  // own section with explicit before/after intent + a concrete example
  // gets compliance up materially.
  const locateRule = options.overlayEnabled
    ? [
        '### LOCATE QUERIES — ALWAYS POPULATE `targetRegions` ###',
        'When the user\'s prompt is a LOCATE intent — phrases like "where is X", "show me X", "find X", "point to X", "point it out", "highlight X", "can you show me", or any follow-up that asks you to visually indicate something — you MUST populate the top-level `targetRegions` array with at least one bounding box. NO EXCEPTIONS. This is an accessibility requirement: many users rely on the visual overlay because they have trouble parsing prose directions. Prose alone is NOT an acceptable answer to a LOCATE query.',
        'Concrete rules:',
        '  • If the element is visible in the screenshot: draw a tight box around it. Approximate coordinates are fine — within ~30 pixels is plenty; the user just needs a visual anchor. Do NOT skip the box because you\'re unsure of exact pixels.',
        '  • If the element is NOT visible in the current screenshot but you know where it lives in the UI (e.g. inside a closed menu, behind a tab, offscreen due to scroll): draw the box around the visible anchor that gets to it (the menu button, the tab header, the scrollbar) and say in `answer` that the user needs to open/scroll to it.',
        '  • If you genuinely cannot identify any visual reference whatsoever: this is the ONE narrow case where `targetRegions` may be empty — but you must add a `warnings` entry explaining "could not locate visually; please rephrase or scroll to bring the element into view" AND lower `confidence` below 0.5. Do not hide behind a confidently-described prose answer with empty regions.',
        'A descriptive answer with empty `targetRegions` is a HARD FAILURE. If you found yourself writing "fourth row, between X and Y" or "top-right corner of the toolbar" — that prose proves you have enough spatial information to draw a bounding box. Draw it.',
        'Coordinate format: integer pixels in the screenshot\'s pixel space, origin top-left. `label` is the element\'s visible text or a short description.',
        'Example LOCATE response shape:',
        '  { "intent": "Locate the X button", "confidence": 0.9, "answer": "Top-right of the toolbar.", "steps": [], "targetRegions": [{ "label": "X button", "x": 1450, "y": 60, "width": 40, "height": 40 }], "warnings": [], "requiresApproval": false }',
        '',
      ]
    : [];

  const modeGuidance: Record<Mode, string> = {
    guide:
      'GUIDE mode: classify the user\'s question into one of three intents and respond accordingly:' +
      ' (1) DESCRIBE ("what is this?", "describe this") → concise `answer` (3 sentences max), empty `steps`, empty `targetRegions`.' +
      ' (2) LOCATE ("where is X?", "show me X", "find X", "point to X", "point it out") → one-sentence `answer` naming the element\'s location in plain language, empty `steps`, **`targetRegions` MUST be populated** (see LOCATE block above). A LOCATE answer without `targetRegions` fails the user — they have no visual indicator to follow.' +
      ' (3) WALKTHROUGH ("how do I…?", "walk me through…") → short `answer` then populate `steps` with one-sentence ordered instructions referencing on-screen labels by their exact visible text.' +
      ' When web-search results are provided, use them to verify menu paths for the specific app/version before writing steps.' +
      regionGuidance,
    action:
      'ACTION mode: the user wants the agent to *perform* tasks on their machine, not describe them. ' +
      'Populate `proposedActions` with one or more executable actions; leave `steps` and `targetRegions` EMPTY (`[]`) — those are for Guide mode. ' +
      'Each proposed action must use exactly one of these `kind` values: ' +
      '  • `click` — click at a screen location. Must include `x` and `y` (integer pixel coordinates in the screenshot\'s coordinate space, origin top-left) and a one-sentence `description` (what the click does, e.g. "open the Tools menu in Audacity"). ' +
      '  • `type` — type a string of text into the currently-focused input. Must include `text` and `description`. ' +
      '  • `scroll` — scroll the currently-focused element. Must include `direction: "up" | "down"`, `amount` (positive integer, treated as approximate pixels), and `description`. ' +
      '  • `openUrl` — open a URL in the user\'s default browser. Must include `url` (absolute https URL) and `description`. ' +
      'Always set `requiresApproval` to true — every action will be reviewed and approved by the user before it runs. ' +
      'Use `answer` for a one-sentence summary of what the sequence will accomplish. Do NOT also write the steps in `answer` or `steps` — the action list IS the answer.',
    // The Automate tab routes through the Computer Use loop, not the
    // single-shot Ask path that consumes this prompt — so this branch
    // is unreachable in practice. We supply a placeholder so the
    // exhaustive `Record<Mode>` typing stays satisfied.
    automate: 'AUTOMATE mode is handled by the Computer Use loop, not single-shot Ask.',
  };

  return [
    'You are Optix, a desktop AI teacher. The user\'s question is about the application visible in the attached screenshot, NOT software in general — e.g. "how do I run a benchmark?" while looking at Audacity means Audacity\'s built-in feature, not a third-party tool. Only deviate if the user explicitly names a different app.',
    '',
    ...(options.webSearchEnabled
      ? [
          '### WEB SEARCH — MANDATORY USAGE ###',
          'You have a `web_search` tool. You MUST call it BEFORE answering whenever the user asks about:',
          '  • a specific menu path, button label, or dialog in a software application',
          '  • where a feature lives in an app (e.g. "find the benchmark in Audacity")',
          '  • how to perform a step-by-step task in any app',
          '  • whether a feature exists or what it\'s called in a specific version',
          'Your training may be outdated or wrong — a hedged "I think it\'s in Help…" answer is WORSE than searching first.',
          'Skip search ONLY when the question is about something plainly visible in the screenshot itself (e.g. "what does this error dialog say?"). When in doubt, search.',
          'Do not describe that you are "about to check" — actually call the tool. Cap `confidence` at 0.7 if you answered without searching.',
          '',
          '### NO FUTURE-ACTION PROMISES ###',
          'Every response is a single self-contained turn — there is NO follow-up. If you say "let me check the docs" or "I\'ll verify by searching" you must do that NOW (call `web_search` again) BEFORE returning the JSON, not promise it for later. By the time you emit the response, all searching is done. If you have insufficient information after the searches you\'ve already run, write the best answer you can and lower `confidence` to reflect uncertainty — never end with a promise of future action.',
          '',
        ]
      : []),
    `Current mode: ${mode.toUpperCase()}. ${modeGuidance[mode]}`,
    '',
    // LOCATE-rule block — only present in Guide mode with overlay on,
    // and only as a hoisted high-visibility section. Empty otherwise.
    ...(mode === 'guide' ? locateRule : []),
    'You MUST respond with a single JSON object matching this TypeScript shape, and nothing else.',
    '**Fields MUST appear in exactly this order** so the streaming UI can render `intent` and `confidence` as a header before the longer `answer` text begins streaming:',
    '',
    '{',
    '  "intent": string,           // one short sentence: what you understood the user wants — FIRST',
    '  "confidence": number,       // 0..1',
    '  "answer": string,           // the main natural-language response — comes after the header fields',
    options.overlayEnabled
      ? '  "steps": Array<{ "order": number, "text": string, "targetRegion"?: { "label": string, "x": number, "y": number, "width": number, "height": number } }>,'
      : '  "steps": Array<{ "order": number, "text": string }>,',
    options.overlayEnabled
      ? '  "targetRegions": Array<{ "label": string, "x": number, "y": number, "width": number, "height": number }>,'
      : '  // targetRegions: leave [] (overlay disabled)',
    '  "warnings": string[],       // e.g. irreversible actions, destructive steps, unclear UI',
    '  // proposedActions: reserved (Phase 3) — return []',
    '  "requiresApproval": boolean // true for any "do" action',
    '}',
    '',
    'If the user\'s request is unsafe, ambiguous, or outside your knowledge, say so in `answer` and `warnings`, and return empty `steps`.',
    'Do not wrap the JSON in markdown. Do not add explanatory text around it.',
  ].join('\n');
}

// Strip inline citation wrappers that Anthropic's web_search_20250305 tool
// embeds in the model's text — `<cite index="2-2,2-3">...</cite>`. Keep the
// inner text, drop the tags. Safe to apply to providers that don't emit
// citations (no-op).
export function stripCitations(text: string): string {
  return text.replace(/<\/?cite[^>]*>/g, '');
}

// Walk a parsed ModelResponse-shaped object and strip <cite> tags from
// the user-facing text fields (`answer`, `intent`, plus per-step `text`
// and `warnings`). Why post-parse instead of running `stripCitations`
// over the raw JSON string: a `<cite>` close tag landing on a string
// boundary inside the JSON could otherwise corrupt the structure, and
// the regex has no way to distinguish "inside a JSON string" from
// "between fields". Running it on already-parsed values sidesteps that
// entirely. Mutates in place; returns the same object for chaining.
export function stripCitationsFromParsed(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.answer === 'string') obj.answer = stripCitations(obj.answer);
  if (typeof obj.intent === 'string') obj.intent = stripCitations(obj.intent);
  if (Array.isArray(obj.warnings)) {
    obj.warnings = obj.warnings.map((w) => (typeof w === 'string' ? stripCitations(w) : w));
  }
  if (Array.isArray(obj.steps)) {
    for (const step of obj.steps) {
      if (step && typeof step === 'object') {
        const s = step as Record<string, unknown>;
        if (typeof s.text === 'string') s.text = stripCitations(s.text);
      }
    }
  }
  return obj;
}

// Helpers for image-bytes → provider-specific format conversion. We pass
// raw `Uint8Array` over IPC (faster than base64 string) and base64-encode
// once here in main when constructing each request. Node's
// `Buffer.toString('base64')` is dramatically faster than browser
// `canvas.toDataURL` (~10-30ms vs ~140ms for a 200KB JPEG).
export function imageBytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function imageBytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${imageBytesToBase64(bytes)}`;
}

// Some models return JSON wrapped in code fences or prose; this extracts the
// first JSON object from whatever they returned.
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  const candidate = fenced ? fenced[1] : text;
  if (!candidate) throw new Error('Empty model response.');
  const trimmed = candidate.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Model response did not contain a JSON object.');
  }
  const jsonSlice = trimmed.slice(firstBrace, lastBrace + 1);
  // Bound the parse — a runaway model that streams hundreds of KB of
  // braces would otherwise let `JSON.parse` allocate without limit.
  if (jsonSlice.length > 100_000) throw new Error('Response payload too large');
  try {
    return JSON.parse(jsonSlice);
  } catch (err) {
    throw new Error(`Model returned invalid JSON: ${(err as Error).message}`);
  }
}
