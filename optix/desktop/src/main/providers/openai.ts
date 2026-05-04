import OpenAI from 'openai';
import { ModelResponseSchema, type ModelResponse } from '@shared/schemas';
import { buildSystemPrompt, extractJson, imageBytesToDataUrl, type Provider, type PromptInput } from './base';
import { ddgSearch, formatSearchResultsForLlm } from './web-search';

const MAX_SEARCH_ITERATIONS = 5;

const clientCache = new Map<string, OpenAI>();

function getOpenAIClient(apiKey: string): OpenAI {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new OpenAI({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

/**
 * Drop the cached OpenAI client. Called by registry fan-out after the
 * user changes / deletes their key — without this the SDK keeps the
 * old key in the pooled HTTP agent until the app restarts.
 *
 * NOTE on rate-limit behavior: the OpenAI SDK retries 429s with
 * built-in exponential backoff. It does not surface response headers
 * on errors in a stable shape, so we do NOT currently parse
 * `Retry-After`. Fallback is the SDK's default backoff. TODO: parse
 * Retry-After once `error.headers` becomes a stable contract.
 */
export function invalidateClientCache(): void {
  clientCache.clear();
}

export const openaiProvider: Provider = {
  id: 'openai',

  async prompt(input: PromptInput, apiKey: string): Promise<ModelResponse> {
    const client = getOpenAIClient(apiKey);

    const dataUrl =
      input.imageBytes && input.imageMimeType
        ? imageBytesToDataUrl(input.imageBytes, input.imageMimeType)
        : undefined;

    const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: 'text', text: input.prompt },
    ];
    if (dataUrl) {
      userContent.push({ type: 'image_url', image_url: { url: dataUrl, detail: 'high' } });
    }
    for (const att of input.imageAttachments ?? []) {
      userContent.push({
        type: 'image_url',
        image_url: { url: imageBytesToDataUrl(att.bytes, att.mimeType), detail: 'high' },
      });
    }

    if (input.webSearchEnabled) {
      return runWithWebSearch(client, input, userContent);
    }

    // Prior conversation turns prepended as alternating user/assistant
    // messages so a follow-up Ask submit reads as a continuation, not
    // a fresh first question. Skips prior screenshots — text-only.
    const priorMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    for (const t of input.priorTurns ?? []) {
      priorMessages.push({ role: 'user', content: t.prompt });
      priorMessages.push({ role: 'assistant', content: t.assistantText });
    }

    const resp = await client.chat.completions.create(
      {
        model: input.modelId,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(input.mode, { webSearchEnabled: input.webSearchEnabled, overlayEnabled: input.overlayEnabled }) },
          ...priorMessages,
          { role: 'user', content: userContent },
        ],
      },
      { signal: input.signal },
    );

    if (resp.usage) {
      input.onUsage?.({
        inputTokens: resp.usage.prompt_tokens,
        outputTokens: resp.usage.completion_tokens,
        // OpenAI reports cached input tokens via prompt_tokens_details.
        // Treat them as cache reads — same billing semantics as Anthropic.
        cacheReadInputTokens: resp.usage.prompt_tokens_details?.cached_tokens,
        // Cache CREATE counter — current OpenAI SDK types only expose
        // `cached_tokens` (read). If/when OpenAI ships a write counter
        // it'll most likely surface either as a sibling field on
        // `prompt_tokens_details` or as a top-level
        // `cache_creation_input_tokens` (mirroring Anthropic). We read
        // defensively now so the value gets billed automatically once
        // the SDK catches up — undefined today, populated later.
        cacheCreationInputTokens:
          (resp.usage.prompt_tokens_details as { cached_tokens_write?: number } | undefined)
            ?.cached_tokens_write ??
          (resp.usage as unknown as { cache_creation_input_tokens?: number })
            .cache_creation_input_tokens,
      });
    }

    const text = resp.choices[0]?.message.content;
    if (!text) throw new Error('OpenAI response contained no content.');

    const raw = extractJson(text);
    return ModelResponseSchema.parse(raw);
  },

  async testKey(apiKey: string): Promise<void> {
    const client = getOpenAIClient(apiKey);
    // Calling models.list() validates the key cheaply.
    await client.models.list();
  },
};

async function runWithWebSearch(
  client: OpenAI,
  input: PromptInput,
  userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[],
): Promise<ModelResponse> {
  const tool: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web (DuckDuckGo). Use when you need up-to-date information or the user mentions software you do not recognize.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query.' } },
        required: ['query'],
      },
    },
  };

  // Prior turns prepended as alternating user/assistant text messages.
  // Same rationale as the non-search path — without these, a follow-up
  // submit would be sent stateless even when conversationMode is on.
  const priorMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (const t of input.priorTurns ?? []) {
    priorMessages.push({ role: 'user', content: t.prompt });
    priorMessages.push({ role: 'assistant', content: t.assistantText });
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(input.mode, { webSearchEnabled: true, overlayEnabled: input.overlayEnabled }) },
    ...priorMessages,
    { role: 'user', content: userContent },
  ];

  // Per-iteration cap counts ROUNDS of model calls; this parallel cap
  // counts individual tool_calls emitted across the loop. A model that
  // emits many tool_calls per round can otherwise exhaust quota without
  // tripping MAX_SEARCH_ITERATIONS.
  const MAX_TOOL_CALLS = 10;
  let toolCallCount = 0;
  for (let iteration = 0; iteration < MAX_SEARCH_ITERATIONS; iteration++) {
    const resp = await client.chat.completions.create(
      {
        model: input.modelId,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        tools: [tool],
        tool_choice: iteration === 0 ? 'required' : 'auto',
        messages,
      },
      { signal: input.signal },
    );

    if (resp.usage) {
      // Each iteration's usage is reported separately; the host's
      // onUsage callback is additive, so total cost across the
      // tool-loop is summed correctly downstream.
      input.onUsage?.({
        inputTokens: resp.usage.prompt_tokens,
        outputTokens: resp.usage.completion_tokens,
        cacheReadInputTokens: resp.usage.prompt_tokens_details?.cached_tokens,
        // Prompt-cache writes — same defensive read as the non-search path.
        cacheCreationInputTokens:
          (resp.usage.prompt_tokens_details as { cached_tokens_write?: number } | undefined)
            ?.cached_tokens_write ??
          (resp.usage as unknown as { cache_creation_input_tokens?: number })
            .cache_creation_input_tokens,
      });
    }

    const choice = resp.choices[0];
    if (!choice) throw new Error('OpenAI response contained no choices.');

    const message = choice.message;
    const finishReason = choice.finish_reason;

    if (finishReason === 'tool_calls' && message.tool_calls && message.tool_calls.length > 0) {
      toolCallCount += message.tool_calls.length;
      if (toolCallCount > MAX_TOOL_CALLS) {
        throw new Error(
          `OpenAI web_search loop emitted ${toolCallCount} tool_calls (cap ${MAX_TOOL_CALLS}); aborting.`,
        );
      }
      messages.push(message);

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== 'function' || toolCall.function.name !== 'web_search') {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: `Unknown tool: ${toolCall.type === 'function' ? toolCall.function.name : toolCall.type}`,
          });
          continue;
        }

        let query = '';
        try {
          const args = JSON.parse(toolCall.function.arguments) as { query?: unknown };
          if (typeof args.query === 'string') query = args.query;
        } catch {
          // Fall through — empty query will yield no results.
        }

        input.onSearch?.(query);
        const results = await ddgSearch(query).catch(() => []);
        for (const r of results) {
          if (r.url) input.onSource?.({ url: r.url, title: r.title });
        }
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: formatSearchResultsForLlm(query, results),
        });
      }
      continue;
    }

    const text = message.content;
    if (!text) throw new Error('OpenAI response contained no content.');

    const raw = extractJson(text);
    return ModelResponseSchema.parse(raw);
  }

  throw new Error(
    `OpenAI web-search tool loop exceeded ${MAX_SEARCH_ITERATIONS} iterations without a final answer.`,
  );
}
