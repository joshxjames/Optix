import { desktopCapturer, screen } from 'electron';
import type { DesktopCapturerSource } from 'electron';

// `desktopCapturer.getSources` is expensive on Windows (~2–3s) because it
// captures thumbnails as part of source enumeration even when we request
// `thumbnailSize: { width: 0, height: 0 }`. We cache the full source object
// per display so `setDisplayMediaRequestHandler` can hand back a real source
// without re-enumerating every call.

let cachedSource: DesktopCapturerSource | null = null;
let cachedAt = 0;
let pendingLookup: Promise<DesktopCapturerSource> | null = null;
// Source IDs are stable unless displays change. A long TTL means the user's
// first capture pays the enumeration cost once per session (pre-warmed at app
// start).
const SOURCE_TTL_MS = 10 * 60 * 1000;

export async function getPrimarySource(): Promise<DesktopCapturerSource> {
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
