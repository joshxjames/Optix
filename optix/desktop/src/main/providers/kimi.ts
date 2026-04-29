import OpenAI from 'openai';
import { ModelResponseSchema, type ModelResponse } from '@shared/schemas';
import {
  buildSystemPrompt,
  extractJson,
  imageBytesToDataUrl,
  type Provider,
  type PromptInput,
} from './base';
import { ddgSearch, formatSearchResultsForLlm } from './web-search';

// Moonshot AI's Kimi API is OpenAI-compatible. We reuse the `openai` client
// with a custom base URL. Kimi's public endpoint is api.moonshot.ai for
// international users; api.moonshot.cn for mainland China.
const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';

// Module-level client cache keyed by apiKey. Instantiating OpenAI on every
// prompt call forces a fresh TLS handshake + DNS lookup; pooling keeps the
// underlying HTTP agent (and its keep-alive connections) warm across calls.
const clientCache = new Map<string, OpenAI>();

function getKimiClient(apiKey: string): OpenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey, baseURL: KIMI_BASE_URL, timeout: 90_000 });
    clientCache.set(apiKey, client);
  }
  return client;
}

export const kimiProvider: Provider = {
  id: 'kimi',

  async prompt(input: PromptInput, apiKey: string): Promise<ModelResponse> {
    const client = getKimiClient(apiKey);

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: input.prompt },
    ];
    if (input.imageBytes && input.imageMimeType) {
      // Guide mode leans on the strong system prompt + pre-fetched search
      // results to answer, so 'low' detail saves tokens and latency without
      // hurting quality. Action mode needs precise click coordinates from the
      // screenshot, so we keep 'high' there.
      const dataUrl = imageBytesToDataUrl(input.imageBytes, input.imageMimeType);
      const detail: 'low' | 'high' = input.mode === 'guide' ? 'low' : 'high';
      userContent.push({ type: 'image_url', image_url: { url: dataUrl, detail } });
    }
    for (const att of input.imageAttachments ?? []) {
      userContent.push({
        type: 'image_url',
        image_url: { url: imageBytesToDataUrl(att.bytes, att.mimeType), detail: 'high' },
      });
    }

    // When web search is on, pre-fetch DDG results and inject them as system
    // context before the model call. Kimi K2.5's thinking mode is incompatible
    // with forced tool_choice, and without forcing the model often says
    // "I'll search" without actually searching. Pre-search sidesteps both
    // problems: guaranteed results, streaming preserved, no tool-use loops.
    //
    // We used to prepend a vision-based "what app is this?" call to refine
    // the query. That added ~10-15s latency and the strong system prompt
    // alone does the grounding work — so we just use the raw prompt now. If
    // the user wants more targeted search, they can include the app name in
    // their prompt directly.
    // We always build the system prompt with `webSearchEnabled: false` here.
    // The shared prompt's "you have a web_search tool" language confuses the
    // model into emitting placeholders like "let me look that up" — but Kimi
    // doesn't actually have a tool to call (we pre-fetch instead). Search
    // context is appended below with explicit instructions.
    let systemPrompt = buildSystemPrompt(input.mode, { webSearchEnabled: false, overlayEnabled: input.overlayEnabled });
    if (input.webSearchEnabled) {
      const query = input.prompt;
      input.onSearch?.(query);
      const results = await ddgSearch(query, 5).catch((err) => {
        console.warn('[optix] DDG pre-search failed:', err instanceof Error ? err.message : err);
        return [];
      });
      // Surface each source URL to the IPC layer so the renderer can render
      // favicon chips. Skip empty/invalid URLs defensively.
      for (const r of results) {
        if (r.url) input.onSource?.({ url: r.url, title: r.title });
      }
      if (results.length > 0) {
        systemPrompt +=
          '\n\n---\n\n' +
          formatSearchResultsForLlm(query, results) +
          '\n\n### USING THESE RESULTS ###\n' +
          'The search results above were pre-fetched for you — you do NOT have a search tool to call. Do not say "let me look that up" or "I\'ll search" — instead, derive your answer NOW from these results plus the screenshot.\n' +
          'Treat the results as ground truth for version-specific menu paths and UI details, but ground your final answer in the application visible in the screenshot. If the results don\'t cover the question, answer from your training knowledge and visible context.';
        console.log(
          `[optix-timing] kimi pre-search query=${JSON.stringify(query)} results=${results.length}`,
        );
      }
    }

    // Prior turns prepended as alternating user/assistant text messages.
    // Without these, a follow-up Ask submit is sent stateless to Kimi
    // even when conversationMode shows a thread above. Skips prior
    // screenshots to keep tokens manageable.
    const priorMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    for (const t of input.priorTurns ?? []) {
      priorMessages.push({ role: 'user', content: t.prompt });
      priorMessages.push({ role: 'assistant', content: t.assistantText });
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...priorMessages,
      { role: 'user', content: userContent },
    ];

    return kimiStreaming(client, messages, input);
  },

  async testKey(apiKey: string): Promise<void> {
    const client = getKimiClient(apiKey);
    await client.models.list();
  },
};

// Streaming path. With or without pre-search context in the system prompt,
// tokens flow via onChunk so the renderer can render progressively.
async function kimiStreaming(
  client: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  input: PromptInput,
): Promise<ModelResponse> {
  const stream = await client.chat.completions.create(
    {
      model: input.modelId,
      max_tokens: 8192,
      stream: true,
      // Ask Kimi (OpenAI-compatible) to emit a final usage chunk so we
      // can record per-turn token counts for cost tracking.
      stream_options: { include_usage: true },
      messages,
    },
    { signal: input.signal },
  );

  let accumulated = '';
  let finishReason: string | null | undefined;
  // Kimi (OpenAI-compatible) streams the `usage` block in the FINAL
  // chunk, after stop, when `stream_options.include_usage` is true. We
  // pluck whichever chunk has it and report once at the end.
  let finalUsage: OpenAI.CompletionUsage | undefined;
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? '';
    if (delta) {
      accumulated += delta;
      input.onChunk?.(delta);
    }
    const reason = chunk.choices[0]?.finish_reason;
    if (reason) finishReason = reason;
    if (chunk.usage) finalUsage = chunk.usage;
  }
  if (finalUsage) {
    input.onUsage?.({
      inputTokens: finalUsage.prompt_tokens,
      outputTokens: finalUsage.completion_tokens,
      cacheReadInputTokens: finalUsage.prompt_tokens_details?.cached_tokens,
    });
  }

  if (!accumulated) {
    const reason = finishReason ?? 'unknown';
    throw new Error(
      `Kimi returned no content (finish_reason=${reason}). ${
        reason === 'length'
          ? 'Response was truncated by max_tokens — try a shorter prompt or simpler mode.'
          : 'The model may have refused or the request was filtered.'
      }`,
    );
  }
  if (finishReason === 'length') {
    throw new Error(
      'Kimi response was truncated by max_tokens mid-stream. Try a shorter prompt or simpler mode.',
    );
  }

  const raw = extractJson(accumulated);
  return ModelResponseSchema.parse(raw);
}
