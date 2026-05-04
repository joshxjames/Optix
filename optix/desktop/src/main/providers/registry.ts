import type { ProviderId } from '@shared/schemas';
import type { Provider } from './base';
import { anthropicProvider, invalidateClientCache as invalidateAnthropicCache } from './anthropic';
import { openaiProvider, invalidateClientCache as invalidateOpenAICache } from './openai';
import { kimiProvider, invalidateClientCache as invalidateKimiCache } from './kimi';
import { googleProvider, invalidateClientCache as invalidateGoogleCache } from './google';
import { optixCloudProvider, invalidateClientCache as invalidateOptixCloudCache } from './optix-cloud';

const providers: Record<ProviderId, Provider> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  kimi: kimiProvider,
  google: googleProvider,
  optixCloud: optixCloudProvider,
};

export function getProvider(id: ProviderId): Provider {
  return providers[id];
}

// Per-provider cache invalidation map. Keyed by ProviderId so the
// IPC layer can target the provider whose key actually changed,
// rather than blowing away every provider's pooled HTTP agent on
// any settings write.
const cacheInvalidators: Record<ProviderId, () => void> = {
  anthropic: invalidateAnthropicCache,
  openai: invalidateOpenAICache,
  kimi: invalidateKimiCache,
  google: invalidateGoogleCache,
  optixCloud: invalidateOptixCloudCache,
};

/**
 * Drop the pooled SDK client for a single provider. Call this after
 * the user changes / deletes the API key for `id` so the next prompt
 * reads the fresh key from the keychain instead of serving stale auth
 * from the in-memory cache.
 */
export function invalidateProviderCache(id: ProviderId): void {
  cacheInvalidators[id]?.();
}

/**
 * Drop every provider's pooled SDK client. Used when we don't know
 * which provider the change applies to (e.g. global sign-out, or a
 * settings reset path).
 */
export function invalidateAllProviderCaches(): void {
  for (const fn of Object.values(cacheInvalidators)) fn();
}
