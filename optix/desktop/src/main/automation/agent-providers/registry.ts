import type { ProviderId } from '@shared/schemas';
import type { AgentProviderAdapter } from './types';
import { anthropicAgentAdapter } from './anthropic';
import { openaiAgentAdapter } from './openai';
import { geminiAgentAdapter } from './gemini';
import { kimiAgentAdapter } from './kimi';

const adapters: Partial<Record<ProviderId, AgentProviderAdapter>> = {
  anthropic: anthropicAgentAdapter,
  openai: openaiAgentAdapter,
  google: geminiAgentAdapter,
  kimi: kimiAgentAdapter,
};

export function getAgentProvider(id: ProviderId): AgentProviderAdapter {
  const adapter = adapters[id];
  if (!adapter) {
    throw new Error(
      `Computer Use is not yet supported on provider "${id}". Switch to Anthropic in Settings, or wait for the OpenAI / Gemini / Kimi adapters to ship.`,
    );
  }
  return adapter;
}

/** Returns true if Computer Use (Access mode) is available for this
 *  provider. The renderer can call this to gate the Access tab — though
 *  for now we let the user select Access on any provider and surface the
 *  unsupported error at start time so the message is loud. */
export function hasAgentSupport(id: ProviderId): boolean {
  return id in adapters;
}
