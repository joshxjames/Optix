import {
  GoogleGenerativeAI,
  type FunctionDeclaration,
  type Part,
} from '@google/generative-ai';
import { ModelResponseSchema, type ModelResponse } from '@shared/schemas';
import {
  buildSystemPrompt,
  extractJson,
  imageBytesToBase64,
  type Provider,
  type PromptInput,
} from './base';
import { ddgSearch, formatSearchResultsForLlm } from './web-search';

/** Module-level cache of GoogleGenerativeAI clients keyed by apiKey. */
const clientCache = new Map<string, GoogleGenerativeAI>();

function getGoogleClient(apiKey: string): GoogleGenerativeAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new GoogleGenerativeAI(apiKey);
    clientCache.set(apiKey, client);
  }
  return client;
}

/**
 * Drop the cached Google client. Called by the registry fan-out after
 * the user changes / deletes their key — without this the SDK keeps
 * the old key embedded until restart.
 *
 * NOTE on rate-limit behavior: @google/generative-ai doesn't expose a
 * stable response-headers shape on errors, so we don't currently parse
 * `Retry-After`. Fallback is the SDK's default behavior (the SDK
 * surfaces the API error and we let the caller retry at the IPC layer).
 */
export function invalidateClientCache(): void {
  clientCache.clear();
}

/** Race the SDK promise against the user's abort signal. */
function withAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  // Pre-check — if the caller already aborted before invoking the SDK,
  // the listener below would never fire (no `abort` event coming) and
  // we'd let the network call proceed pointlessly. Reject immediately.
  if (signal?.aborted) {
    return Promise.reject(new Error('Already aborted before request started'));
  }
  const abort = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Request aborted.')), { once: true });
  });
  return Promise.race([work, abort]);
}

/** Forward Gemini's usage metadata to the host's `onUsage` callback.
 *  Gemini exposes `promptTokenCount` / `candidatesTokenCount` plus an
 *  optional `cachedContentTokenCount` for context-cached calls; the
 *  cost estimator treats `cachedContentTokenCount` as cache reads
 *  (Anthropic-equivalent semantics). */
function reportGoogleUsage(input: PromptInput, result: unknown): void {
  if (!input.onUsage) return;
  // GenerativeAI SDK types don't allow indexing usageMetadata as a
  // bag, but at runtime it has the standard fields plus occasional
  // additions. Read defensively via a wide cast.
  const meta = (result as { response?: { usageMetadata?: Record<string, number> } })
    ?.response?.usageMetadata;
  if (!meta) return;
  input.onUsage({
    inputTokens: meta.promptTokenCount,
    outputTokens: meta.candidatesTokenCount,
    cacheReadInputTokens: meta.cachedContentTokenCount,
    // Gemini's API exposes a cache-CREATE token count on responses that
    // wrote a fresh cache entry — only some endpoints / model versions
    // populate it, hence the `any` cast. Mirrors Anthropic's
    // cache_creation_input_tokens semantics so the cost estimator can
    // bill it consistently.
    cacheCreationInputTokens: (meta as any).cacheCreationInputTokenCount,
  });
}

// Round 9.2: NonNullable<> on parameters — the SDK type widens to
// `Schema | undefined`, which exactOptionalPropertyTypes rejects when
// assigned into the declared `parameters?: Schema` slot.
const WEB_SEARCH_FUNCTION: FunctionDeclaration = {
  name: 'web_search',
  description:
    'Search the public web via DuckDuckGo and return a list of result titles, URLs, and snippets. Use it whenever the user\'s request needs up-to-date or external information beyond what is visible on the screen.',
  // The SDK's type for `parameters` is `Schema`; the plain JSON-Schema-ish shape
  // below is what @google/generative-ai ^0.21 accepts at runtime.
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to send to the web search engine.',
      },
    },
    required: ['query'],
  } as unknown as NonNullable<FunctionDeclaration['parameters']>,
};

export const googleProvider: Provider = {
  id: 'google',

  async prompt(input: PromptInput, apiKey: string): Promise<ModelResponse> {
    const genAI = getGoogleClient(apiKey);
    const systemInstruction = buildSystemPrompt(input.mode, { webSearchEnabled: input.webSearchEnabled, overlayEnabled: input.overlayEnabled });

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      { text: input.prompt },
    ];
    if (input.imageBytes && input.imageMimeType) {
      parts.push({
        inlineData: {
          mimeType: input.imageMimeType,
          data: imageBytesToBase64(input.imageBytes),
        },
      });
    }
    for (const att of input.imageAttachments ?? []) {
      parts.push({
        inlineData: {
          mimeType: att.mimeType,
          data: imageBytesToBase64(att.bytes),
        },
      });
    }

    // Build the conversation contents — prior turns first (alternating
    // user/model with text-only parts), then the current user turn with
    // the screenshot + attachments + prompt parts. Without prior turns
    // a follow-up Ask submit reads as stateless to Gemini even when the
    // visual thread shows a conversation.
    const priorContents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
    for (const t of input.priorTurns ?? []) {
      priorContents.push({ role: 'user', parts: [{ text: t.prompt }] });
      priorContents.push({ role: 'model', parts: [{ text: t.assistantText }] });
    }
    const fullContents = [
      ...priorContents,
      { role: 'user' as const, parts: parts as Part[] },
    ];

    // --- Path 1: web search disabled — original behavior, unchanged semantics. ---
    if (!input.webSearchEnabled) {
      const model = genAI.getGenerativeModel({
        model: input.modelId,
        systemInstruction,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      });

      // The Google SDK doesn't expose an AbortSignal on generateContent in older
      // versions; we wrap it in a race so the user's stop button still works.
      const result = await withAbort(
        input.signal,
        model.generateContent({ contents: fullContents }),
      );

      reportGoogleUsage(input, result);

      const text = result.response.text();
      if (!text) throw new Error('Google response contained no content.');

      const raw = extractJson(text);
      return ModelResponseSchema.parse(raw);
    }

    // --- Path 2: native Gemini grounding via googleSearch tool. ---
    // Note: Gemini refuses `responseMimeType: 'application/json'` together with
    // `tools`, so we drop it and rely on the system prompt + extractJson().
    try {
      const groundedModel = genAI.getGenerativeModel({
        model: input.modelId,
        systemInstruction,
        // The SDK's TS types lag behind the server: `googleSearch` is accepted
        // at runtime for Gemini 2.x grounding. Cast to satisfy the older types.
        // Round 9.2: NonNullable<> for exactOptionalPropertyTypes — the
        // optional `tools` slot doesn't accept `undefined` values.
        tools: [{ googleSearch: {} }] as unknown as NonNullable<Parameters<
          typeof genAI.getGenerativeModel
        >[0]['tools']>,
      });

      const result = await withAbort(
        input.signal,
        groundedModel.generateContent({ contents: fullContents }),
      );

      reportGoogleUsage(input, result);

      // Surface queries + cited URLs to the UI. groundingChunks contains
      // {web: {uri, title}} entries — one per source consulted.
      const candidates = result.response.candidates ?? [];
      for (const cand of candidates) {
        const meta = (cand as {
          groundingMetadata?: {
            webSearchQueries?: string[];
            groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
          };
        }).groundingMetadata;
        const queries = meta?.webSearchQueries;
        if (Array.isArray(queries)) {
          for (const q of queries) {
            if (typeof q === 'string' && q.length > 0) input.onSearch?.(q);
          }
        }
        const chunks = meta?.groundingChunks;
        if (Array.isArray(chunks)) {
          for (const ch of chunks) {
            const uri = ch?.web?.uri;
            const title = ch?.web?.title ?? '';
            if (typeof uri === 'string' && uri.length > 0) {
              input.onSource?.({ url: uri, title });
            }
          }
        }
      }

      const text = result.response.text();
      if (!text) throw new Error('Google response contained no content.');

      const raw = extractJson(text);
      return ModelResponseSchema.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // If the user aborted, don't bother falling back — propagate.
      if (input.signal.aborted) throw err;
      // eslint-disable-next-line no-console
      console.log('[optix] Google native grounding failed, falling back to DuckDuckGo:', message);
    }

    // --- Path 3: DDG fallback via function calling. ---
    const fallbackModel = genAI.getGenerativeModel({
      model: input.modelId,
      systemInstruction,
      tools: [{ functionDeclarations: [WEB_SEARCH_FUNCTION] }],
    });

    // Build an initial chat turn. We keep a rolling `contents` list and feed it
    // to generateContent each iteration — simpler than juggling a chat session
    // and still works with the SDK's typing. Prior conversation turns are
    // prepended so the DDG fallback also benefits from history.
    const contents: Array<{ role: 'user' | 'model' | 'function'; parts: Part[] }> = [
      ...priorContents,
      { role: 'user', parts: parts as Part[] },
    ];

    const MAX_ITERATIONS = 5;
    let finalText: string | null = null;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // Force a function call on the first turn so Gemini can't generate a
      // hedging text reply without invoking search.
      const toolConfig =
        iter === 0
          ? ({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['web_search'] } } as unknown as Parameters<
              typeof fallbackModel.generateContent
            >[0] extends { toolConfig?: infer T } ? T : never)
          : undefined;
      const result = await withAbort(
        input.signal,
        fallbackModel.generateContent({ contents, ...(toolConfig ? { toolConfig } : {}) } as Parameters<
          typeof fallbackModel.generateContent
        >[0]),
      );

      // Each iteration counts toward the run's total token cost.
      reportGoogleUsage(input, result);

      const candidate = result.response.candidates?.[0];
      const candParts = candidate?.content?.parts ?? [];

      // Collect function calls from this turn (there may be more than one).
      const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
      for (const p of candParts) {
        const fc = (p as { functionCall?: { name: string; args?: Record<string, unknown> } })
          .functionCall;
        if (fc && typeof fc.name === 'string') {
          calls.push({ name: fc.name, args: fc.args ?? {} });
        }
      }

      if (calls.length === 0) {
        // No tool calls — this turn should contain the final text.
        finalText = result.response.text();
        break;
      }

      // Echo the model's turn back into the history so the SDK's required
      // user/model/function alternation is preserved.
      contents.push({ role: 'model', parts: candParts as Part[] });

      const responseParts: Part[] = [];
      for (const call of calls) {
        if (call.name !== 'web_search') {
          responseParts.push({
            functionResponse: {
              name: call.name,
              response: { error: `Unknown tool "${call.name}".` },
            },
          } as Part);
          continue;
        }
        const query = typeof call.args.query === 'string' ? call.args.query : '';
        if (!query) {
          responseParts.push({
            functionResponse: {
              name: call.name,
              response: { error: 'Missing required "query" argument.' },
            },
          } as Part);
          continue;
        }
        input.onSearch?.(query);
        let formatted: string;
        try {
          const results = await ddgSearch(query);
          for (const r of results) {
            if (r.url) input.onSource?.({ url: r.url, title: r.title });
          }
          formatted = formatSearchResultsForLlm(query, results);
        } catch (ddgErr) {
          const msg = ddgErr instanceof Error ? ddgErr.message : String(ddgErr);
          formatted = `Web search for "${query}" failed: ${msg}`;
        }
        responseParts.push({
          functionResponse: {
            name: 'web_search',
            response: { query, results: formatted },
          },
        } as Part);
      }

      contents.push({ role: 'function', parts: responseParts });
    }

    if (!finalText) {
      throw new Error('Google response contained no content after web_search iterations.');
    }

    const raw = extractJson(finalText);
    return ModelResponseSchema.parse(raw);
  },

  async testKey(apiKey: string): Promise<void> {
    const genAI = getGoogleClient(apiKey);
    // Smallest possible call — 1 token generation on a flash model.
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    await model.generateContent('ping');
  },
};
