import keytar from 'keytar';
import type { ProviderId } from '@shared/schemas';

const SERVICE = 'optix.desktop';

function accountFor(providerId: ProviderId): string {
  return `provider:${providerId}`;
}

// Cache API keys in-process after first read. Each `getApiKey` call hits
// the OS keychain (~5–50ms on Windows), and provider.ipc.ts awaits one per
// prompt — so caching here cuts user-facing latency on every request after
// the first. Cache is invalidated on set/delete so the next read picks up
// the new value.
const keyCache = new Map<ProviderId, string | null>();

export async function getApiKey(providerId: ProviderId): Promise<string | null> {
  if (keyCache.has(providerId)) {
    return keyCache.get(providerId) ?? null;
  }
  const value = await keytar.getPassword(SERVICE, accountFor(providerId));
  keyCache.set(providerId, value);
  return value;
}

export async function setApiKey(providerId: ProviderId, apiKey: string): Promise<void> {
  await keytar.setPassword(SERVICE, accountFor(providerId), apiKey);
  keyCache.set(providerId, apiKey);
}

export async function deleteApiKey(providerId: ProviderId): Promise<void> {
  await keytar.deletePassword(SERVICE, accountFor(providerId));
  keyCache.set(providerId, null);
}

export async function hasApiKey(providerId: ProviderId): Promise<boolean> {
  const key = await getApiKey(providerId);
  return key !== null && key.length > 0;
}
