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

// Wrap every keytar call in try/catch — keytar surfaces native errors when the
// underlying OS secret store is unavailable (Windows Credential Manager
// service stopped, Linux without libsecret/GNOME Keyring). Without this guard,
// a busted keychain produces a cryptic native-bridge error that bubbles all
// the way to the renderer. On read we degrade gracefully (return null and let
// the caller's "no key configured" path take over); on write we surface a
// user-readable message that points at the actionable fix.
const KEYCHAIN_WRITE_ERROR =
  'Could not access OS keychain. On Linux, install libsecret-1-dev. ' +
  'On Windows, ensure the Credential Manager service is running.';

export async function getApiKey(providerId: ProviderId): Promise<string | null> {
  if (keyCache.has(providerId)) {
    return keyCache.get(providerId) ?? null;
  }
  try {
    const value = await keytar.getPassword(SERVICE, accountFor(providerId));
    keyCache.set(providerId, value);
    return value;
  } catch (err) {
    // Read failures degrade to "no key" — the caller's existing missing-key
    // branch produces a clean "Open Settings to add one" error. We log so
    // support can correlate user reports with a broken keychain service.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[optix-keychain] getPassword failed for ${providerId}: ${msg}`);
    return null;
  }
}

export async function setApiKey(providerId: ProviderId, apiKey: string): Promise<void> {
  try {
    await keytar.setPassword(SERVICE, accountFor(providerId), apiKey);
    keyCache.set(providerId, apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[optix-keychain] setPassword failed for ${providerId}: ${msg}`);
    throw new Error(KEYCHAIN_WRITE_ERROR);
  }
}

export async function deleteApiKey(providerId: ProviderId): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE, accountFor(providerId));
    keyCache.set(providerId, null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[optix-keychain] deletePassword failed for ${providerId}: ${msg}`);
    throw new Error(KEYCHAIN_WRITE_ERROR);
  }
}

export async function hasApiKey(providerId: ProviderId): Promise<boolean> {
  const key = await getApiKey(providerId);
  return key !== null && key.length > 0;
}
