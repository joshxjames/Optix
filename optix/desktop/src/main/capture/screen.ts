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
 * TODO(multi-display): exposing the affordance here is only half the fix —
 * the renderer's `navigator.mediaDevices.getDisplayMedia` flow still routes
 * through `setDisplayMediaRequestHandler` in main/index.ts, which always
 * hands back the primary source. A full multi-display capture path requires
 * (a) the renderer telling main which display the user picked, and (b) the
 * request handler honouring that selection rather than calling the no-arg
 * `getPrimarySource()`. Out of scope here.
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

export function invalidateSourceIdCache(): void {
  cachedSource = null;
  cachedAt = 0;
}
