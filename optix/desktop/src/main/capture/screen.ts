import { desktopCapturer, screen } from 'electron';
import type { DesktopCapturerSource } from 'electron';

// `desktopCapturer.getSources` is expensive on Windows (~2–3s) because it
// captures thumbnails as part of source enumeration even when we request
// `thumbnailSize: { width: 0, height: 0 }`. We cache the full source object
// per display so `setDisplayMediaRequestHandler` can hand back a real source
// without re-enumerating every call.

// Cached primary source kept for the no-arg fast path (the common case).
// Per-display lookups bypass the cache to keep the surface small — the
// extra enumeration cost only matters for the primary call which the
// app pre-warms at startup.
let cachedSource: DesktopCapturerSource | null = null;
let cachedAt = 0;
let pendingLookup: Promise<DesktopCapturerSource> | null = null;
// Source IDs are stable unless displays change. A long TTL means the user's
// first capture pays the enumeration cost once per session (pre-warmed at app
// start).
const SOURCE_TTL_MS = 10 * 60 * 1000;

/**
 * Resolve a `DesktopCapturerSource` for the requested display, defaulting to
 * the primary display when no `displayId` is supplied. The no-arg form
 * preserves prior behaviour and uses the cached source.
 *
 * TODO(multi-display): the renderer's `navigator.mediaDevices.getDisplayMedia`
 * flow still routes through `setDisplayMediaRequestHandler` in
 * main/index.ts:124, which always calls the no-arg form and hands back the
 * primary source. To finish the fix, that handler needs to look up the
 * foreground HWND's bounds (no helper exists yet — would need a new
 * `getForegroundWindowBounds()` next to `captureForegroundHwnd` in
 * automation/foreground.ts) and pass the matching display id into
 * `getSourceForDisplay()` below. Cache invalidation on display-changed
 * events is already wired in index.ts so stale source ids can't persist.
 */
export async function getPrimarySource(
  displayId?: number,
): Promise<DesktopCapturerSource> {
  // Per-display lookup: skip the cache and look up directly. Rare path —
  // only used by callers that need a non-primary display source.
  if (typeof displayId === 'number') {
    const t0 = performance.now();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
    });
    if (sources.length === 0) {
      throw new Error('No screen sources available. Has screen-recording permission been granted?');
    }
    const match = sources.find((s) => s.display_id === displayId.toString());
    if (!match) {
      throw new Error(`No capture source for display id ${displayId}.`);
    }
    console.log(`[optix-timing] source lookup (display=${displayId}) took ${Math.round(performance.now() - t0)}ms (fresh)`);
    return match;
  }

  const now = Date.now();
  if (cachedSource && now - cachedAt < SOURCE_TTL_MS) {
    return cachedSource;
  }
  if (pendingLookup) return pendingLookup;

  pendingLookup = (async () => {
    try {
      const primary = screen.getPrimaryDisplay();
      const t0 = performance.now();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (sources.length === 0) {
        throw new Error('No screen sources available. Has screen-recording permission been granted?');
      }
      const match = sources.find((s) => s.display_id === primary.id.toString()) ?? sources[0];
      if (!match) throw new Error('Unable to resolve primary display capture source.');
      cachedSource = match;
      cachedAt = Date.now();
      console.log(`[optix-timing] source lookup took ${Math.round(performance.now() - t0)}ms (fresh)`);
      return match;
    } finally {
      pendingLookup = null;
    }
  })();
  return pendingLookup;
}

export async function getPrimarySourceId(): Promise<string> {
  return (await getPrimarySource()).id;
}

/**
 * Resolve a capture source for the display containing the given screen-space
 * bounds (typically a foreground window's rect). Falls back to the primary
 * source when the lookup fails, so callers can use this unconditionally
 * without losing the existing single-display behaviour.
 *
 * Bypasses the primary-source cache because the matched display can change
 * on every call (user dragged the foreground window between monitors).
 */
export async function getSourceForDisplay(
  bounds: { x: number; y: number; width: number; height: number },
): Promise<DesktopCapturerSource> {
  try {
    const display = screen.getDisplayMatching(bounds);
    return await getPrimarySource(display.id);
  } catch {
    // Any lookup failure (no matching display id, getSources rejects) falls
    // back to the cached primary so capture still works on the wrong display
    // rather than failing outright.
    return getPrimarySource();
  }
}

export function invalidateSourceIdCache(): void {
  cachedSource = null;
  cachedAt = 0;
}
