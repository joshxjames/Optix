import type { ProviderId } from '@shared/schemas';
import type { Provider } from './base';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import { kimiProvider } from './kimi';
import { googleProvider } from './google';

const providers: Record<ProviderId, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  kimi: kimiProvider,
  google: googleProvider,
};

export function getProvider(id: ProviderId): Provider {
  return providers[id];
}
