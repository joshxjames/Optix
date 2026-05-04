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
//
// TTL: cache entries are dropped after CACHE_TTL_MS so a key rotated
// out-of-band (e.g. another process writes the OS keychain directly)
// is eventually picked up. set/delete invalidate immediately for the
// in-process happy path.
//
// NOTE on zeroization: JS strings are immutable — there is no portable
// way to overwrite the underlying buffer. `wipeAllCachedKeys()` drops
// references promptly so the GC can reclaim them, but a residual copy
// may sit in memory until then. This is best-effort, not a guarantee.
const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { value: string | null; expiresAt: number };
const keyCache = new Map<ProviderId, CacheEntry>();

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

function cacheGet(providerId: ProviderId): CacheEntry | undefined {
  const entry = keyCache.get(providerId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    keyCache.delete(providerId);
    return undefined;
  }
  return entry;
}

function cacheSet(providerId: ProviderId, value: string | null): void {
  keyCache.set(providerId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function getApiKey(providerId: ProviderId): Promise<string | null> {
  const entry = cacheGet(providerId);
  if (entry) return entry.value;
  try {
    const value = await keytar.getPassword(SERVICE, accountFor(providerId));
    cacheSet(providerId, value);
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
    // Drop stale entry promptly; next read repopulates from OS keychain.
    keyCache.delete(providerId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[optix-keychain] setPassword failed for ${providerId}: ${msg}`);
    throw new Error(KEYCHAIN_WRITE_ERROR);
  }
}

export async function deleteApiKey(providerId: ProviderId): Promise<void> {
  try {
    await keytar.deletePassword(SERVICE, accountFor(providerId));
    keyCache.delete(providerId);
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

/** Drop a cached entry (or all entries) so the next read fetches fresh
 *  from the OS keychain. Wired in by settings.ipc.ts on key change so a
 *  rotation in Settings takes effect immediately for in-flight callers
 *  that share this process. */
export function clearKeyCache(providerId?: ProviderId): void {
  if (providerId) {
    keyCache.delete(providerId);
  } else {
    keyCache.clear();
  }
}

/** Best-effort cache wipe for app teardown. Strings in JS are immutable
 *  so we can't truly zero the underlying memory — we just drop every
 *  reference so the GC can reclaim them ASAP. Call from `before-quit`.
 *  TODO: src/main/index.ts before-quit handler should invoke this. */
export function wipeAllCachedKeys(): void {
  // Overwrite each entry's value field before clearing — symbolic, since
  // the original string remains in memory until GC, but it removes the
  // reference held by this Map immediately.
  for (const entry of keyCache.values()) {
    entry.value = null;
  }
  keyCache.clear();
}
