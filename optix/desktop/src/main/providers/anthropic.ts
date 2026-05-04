import Anthropic from '@anthropic-ai/sdk';
import { ModelResponseSchema, type ModelResponse } from '@shared/schemas';
import { buildSystemPrompt, extractJson, imageBytesToBase64, stripCitations, type Provider, type PromptInput } from './base';
import { ddgSearch, formatSearchResultsForLlm } from './web-search';

type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const clientCache = new Map<string, Anthropic>();

function getAnthropicClient(apiKey: string): Anthropic {
  let client = clientCache.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey });
    clientCache.set(apiKey, client);
  }
  return client;
}

function bytesToImageBlock(bytes: Uint8Array, mimeType: string | undefined): {
  type: 'image';
  source: { type: 'base64'; media_type: AnthropicImageMediaType; data: string };
} {
  const mediaType: AnthropicImageMediaType =
    mimeType === 'image/png' ||
    mimeType === 'image/webp' ||
    mimeType === 'image/gif' ||
    mimeType === 'image/jpeg'
      ? mimeType
      : 'image/jpeg';
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: imageBytesToBase64(bytes),
    },
  };
}

/** Forward Anthropic's `usage` block to the host's `onUsage` callback,
 *  if present. The four fields here cover the cost-estimator's needs;
 *  Anthropic occasionally adds new fields (e.g. server_tool_use tokens)
 *  but the cost math doesn't currently price them. */
function reportAnthropicUsage(
  input: PromptInput,
  finalMessage: Anthropic.Messages.Message,
): void {
  if (!input.onUsage) return;
  const usage = finalMessage.usage;
  if (!usage) return;
  input.onUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: (usage as any).cache_creation_input_tokens,
    cacheReadInputTokens: (usage as any).cache_read_input_tokens,
  });
}

/**
 * Run a streaming `messages.stream(...)` call, forwarding text deltas to
 * `onChunk` and returning the assembled final message (same shape as
 * `messages.create` returns).
 */
async function streamAndCollect(
  client: Anthropic,
  params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  signal: AbortSignal | undefined,
  onChunk: ((delta: string) => void) | undefined,
  onSearch?: (query: string) => void,
): Promise<Anthropic.Messages.Message> {
  const stream = client.messages.stream(params, { signal });
  // Anthropic can emit multiple text blocks per message — particularly when
  // server-side web_search runs. We only want the FIRST text block to reach
  // the renderer; otherwise the streaming JSON extractor sees a second
  // round of fields (steps, warnings) and renders extras that aren't in the
  // final parsed response.
  let firstTextBlockIndex: number | null = null;
  let firstTextBlockClosed = false;
  for await (const event of stream) {
    // Detect server-side web search start mid-stream so the renderer can flip
    // its "Searching the web" badge before the response completes.
    if (event.type === 'content_block_start') {
      const block = (event as any).content_block;
      const idx = (event as any).index;
      if (block?.type === 'server_tool_use' && block?.name === 'web_search') {
        const q = block.input?.query;
        if (typeof q === 'string') onSearch?.(q);
      }
      // First text block we see becomes the canonical one for streaming.
      if (block?.type === 'text' && firstTextBlockIndex === null) {
        firstTextBlockIndex = typeof idx === 'number' ? idx : 0;
      }
    }
    if (event.type === 'content_block_stop') {
      const idx = (event as any).index;
      if (firstTextBlockIndex !== null && idx === firstTextBlockIndex) {
        firstTextBlockClosed = true;
      }
    }
    if (
      event.type === 'content_block_delta' &&
      (event as any).delta?.type === 'text_delta'
    ) {
      // Only forward deltas from the canonical first text block.
      const idx = (event as any).index;
      if (firstTextBlockClosed) continue;
      if (firstTextBlockIndex !== null && idx !== firstTextBlockIndex) continue;
      const text = stripCitations((event as any).delta.text as string);
      if (text) onChunk?.(text);
    }
  }
  return await stream.finalMessage();
}

/**
 * Shared Anthropic-protocol prompt runner. Used by both the direct
 * Anthropic provider and the Optix Cloud relay provider — they speak the
 * exact same wire protocol, so all the message-building, web-search
 * fallback, and response-parsing logic lives here. The only thing that
 * differs between the two providers is how the `client` is constructed
 * (apiKey vs Bearer token + relay baseURL).
 *
 * Exported so `optix-cloud.ts` can inject its relay-bound client.
 */
export async function runAnthropicPrompt(
  client: Anthropic,
  input: PromptInput,
): Promise<ModelResponse> {
  const userContent: Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam> = [];
    if (input.imageBytes) userContent.push(bytesToImageBlock(input.imageBytes, input.imageMimeType));
    // User-attached reference images go after the screenshot, before the
    // prompt text — that order keeps the screenshot first (it's usually
    // the primary context) while ensuring uploads aren't ignored.
    for (const att of input.imageAttachments ?? []) {
      userContent.push(bytesToImageBlock(att.bytes, att.mimeType));
    }
    userContent.push({ type: 'text', text: input.prompt });

    // Build prior-turn message pairs (alternating user/assistant) from
    // the conversation history. Without these the model treats every
    // submit as the first message, even when conversationMode shows a
    // visible thread above. We don't re-attach the prior screenshots —
    // just the text — to keep tokens manageable; the model carries the
    // narrative thread but visual context is from the *current* shot.
    const priorMessages: Anthropic.Messages.MessageParam[] = [];
    for (const t of input.priorTurns ?? []) {
      priorMessages.push({ role: 'user', content: t.prompt });
      priorMessages.push({ role: 'assistant', content: t.assistantText });
    }

    // Non-search path — streamed.
    if (!input.webSearchEnabled) {
      console.log('[optix-anthropic] streaming non-search path');
      const finalMessage = await streamAndCollect(
        client,
        {
          model: input.modelId,
          max_tokens: 2048,
          system: buildSystemPrompt(input.mode, { webSearchEnabled: false, overlayEnabled: input.overlayEnabled }),
          messages: [...priorMessages, { role: 'user', content: userContent }],
        },
        input.signal,
        input.onChunk,
      );

      reportAnthropicUsage(input, finalMessage);

      const textBlock = finalMessage.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('Anthropic response contained no text block.');
      }

      // Strip Anthropic's <cite> tags before parsing — they appear inside
      // the JSON's string fields and would otherwise pollute answer / steps.
      const raw = extractJson(stripCitations(textBlock.text));
      return ModelResponseSchema.parse(raw);
    }

    // Search path — try Anthropic's native server-side web_search_20250305 tool first.
    const system = buildSystemPrompt(input.mode, { webSearchEnabled: true, overlayEnabled: input.overlayEnabled });
    const initialMessages: Anthropic.Messages.MessageParam[] = [
      ...priorMessages,
      { role: 'user', content: userContent },
    ];

    try {
      console.log('[optix-anthropic] streaming native web_search path');
      const finalMessage = await streamAndCollect(
        client,
        {
          model: input.modelId,
          max_tokens: 4096,
          system,
          messages: initialMessages,
          // Beta server-side web search tool — not yet in SDK types.
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] as any,
        } as any,
        input.signal,
        input.onChunk,
        input.onSearch, // fired mid-stream when content_block_start sees a server_tool_use
      );

      reportAnthropicUsage(input, finalMessage);

      // Extract source URLs from native `web_search_tool_result` blocks. Each
      // block's `content` is an array of `{url, title, ...}` results.
      for (const block of finalMessage.content) {
        if ((block as any).type === 'web_search_tool_result') {
          const items = (block as any).content;
          if (Array.isArray(items)) {
            for (const it of items) {
              const url = it?.url;
              if (typeof url === 'string') {
                input.onSource?.({ url, title: typeof it.title === 'string' ? it.title : '' });
              }
            }
          }
        }
      }

      const textBlock = finalMessage.content.find(b => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        throw new Error('Anthropic response contained no text block.');
      }

      // Strip Anthropic's <cite> tags before parsing — they appear inside
      // the JSON's string fields and would otherwise pollute answer / steps.
      const raw = extractJson(stripCitations(textBlock.text));
      return ModelResponseSchema.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[optix] Anthropic native web_search failed, falling back to DuckDuckGo:', message);
    }

    // Fallback loop — custom `web_search` function tool backed by ddgSearch.
    const webSearchTool: Anthropic.Messages.Tool = {
      name: 'web_search',
      description:
        'Search the public web via DuckDuckGo. Returns a list of result titles, URLs, and snippets. Use when you need up-to-date information or facts beyond your training data.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to run.',
          },
        },
        required: ['query'],
      },
    };

    const messages: Anthropic.Messages.MessageParam[] = [
      ...priorMessages,
      { role: 'user', content: userContent },
    ];

    const MAX_ITERATIONS = 5;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Intermediate tool-use turns: keep using non-streaming since we just
      // need the tool_use block, not any user-visible text. Switch to
      // streaming once the model starts producing the final answer (we don't
      // know stop_reason ahead of time — but only the final turn typically
      // emits substantive text deltas, so streaming every turn is also safe).
      // We use streaming for every turn for simplicity; text deltas during
      // tool-use turns are usually empty or short preambles.
      console.log(`[optix-anthropic] streaming DDG fallback turn ${i}`);
      const finalMessage = await streamAndCollect(
        client,
        {
          model: input.modelId,
          max_tokens: 4096,
          system,
          messages,
          tools: [webSearchTool],
          // Force a search on the first turn so Claude can't just say "I'll
          // look that up" without actually calling the tool.
          tool_choice: i === 0
            ? { type: 'tool', name: 'web_search' }
            : { type: 'auto' },
        },
        input.signal,
        // Only forward chunks on non-tool-use turns. We don't know the
        // stop_reason until the stream finishes, but by then the deltas have
        // already been emitted — so we always forward and rely on the fact
        // that tool-use turns produce minimal text. This matches the
        // "streaming is fine for every turn" reasoning above.
        input.onChunk,
      );

      // Each iteration's usage is reported individually — the audit /
      // chat-history layer SUMS them per turn, so the model gets billed
      // for both the search-tool call and the final text turn correctly.
      reportAnthropicUsage(input, finalMessage);

      if (finalMessage.stop_reason === 'tool_use') {
        // Claude can emit MULTIPLE tool_use blocks in one turn. Anthropic's
        // protocol requires every tool_use to be paired with a matching
        // tool_result in the very next user message — missing any one of
        // them causes a 400 "tool_use ids were found without tool_result
        // blocks immediately after" error. So we collect them all, run a
        // search per block, and reply with one tool_result per tool_use.
        const toolUseBlocks = finalMessage.content.filter(
          (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
        );
        if (toolUseBlocks.length === 0) {
          throw new Error('Anthropic signalled tool_use but returned no tool_use block.');
        }

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const tu of toolUseBlocks) {
          const query = ((tu.input as any)?.query ?? '') as string;
          input.onSearch?.(query);
          let toolResultText: string;
          try {
            const results = await ddgSearch(query);
            for (const r of results) {
              if (r.url) input.onSource?.({ url: r.url, title: r.title });
            }
            toolResultText = formatSearchResultsForLlm(query, results);
          } catch (searchErr) {
            const msg = searchErr instanceof Error ? searchErr.message : String(searchErr);
            toolResultText = `Web search failed: ${msg}`;
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: toolResultText,
          });
        }

        // Echo the assistant turn that issued the tool_uses, then reply
        // with a single user message containing all tool_results.
        messages.push({ role: 'assistant', content: finalMessage.content });
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      if (finalMessage.stop_reason === 'end_turn') {
        const textBlock = finalMessage.content.find(b => b.type === 'text');
        if (!textBlock || textBlock.type !== 'text') {
          throw new Error('Anthropic response contained no text block.');
        }
        // Strip Anthropic's <cite> tags before parsing — they appear inside
      // the JSON's string fields and would otherwise pollute answer / steps.
      const raw = extractJson(stripCitations(textBlock.text));
        return ModelResponseSchema.parse(raw);
      }

      // Unexpected stop reason (max_tokens, etc.) — try to parse whatever text we got.
      const textBlock = finalMessage.content.find(b => b.type === 'text');
      if (textBlock && textBlock.type === 'text') {
        // Strip Anthropic's <cite> tags before parsing — they appear inside
      // the JSON's string fields and would otherwise pollute answer / steps.
      const raw = extractJson(stripCitations(textBlock.text));
        return ModelResponseSchema.parse(raw);
      }

      throw new Error(`Anthropic fallback loop ended with unexpected stop_reason: ${finalMessage.stop_reason}`);
    }

    throw new Error(`Anthropic fallback loop exceeded ${MAX_ITERATIONS} iterations without producing a final answer.`);
}

export const anthropicProvider: Provider = {
  id: 'anthropic',

  async prompt(input: PromptInput, apiKey: string): Promise<ModelResponse> {
    return runAnthropicPrompt(getAnthropicClient(apiKey), input);
  },

  async testKey(apiKey: string): Promise<void> {
    const client = getAnthropicClient(apiKey);
    // Cheapest possible call — zero-token ping. If the key is bad, this throws.
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  },
};
