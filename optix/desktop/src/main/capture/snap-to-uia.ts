import type { TargetRegion } from '@shared/schemas';
import type { UiaElement } from './uia';

// Spatial gate: UIA names are far more reliable than OCR text, but a UIA
// "OK" button could exist on the other side of the window. Wide enough to
// tolerate the model's loose initial coordinates.
const MAX_CENTER_DIST_PX = 600;
// Tighter thresholds (lev 3 → 2, ratio 0.65 → 0.7, jaccard 0.5 → 0.6) so
// weak/ambiguous UIA matches don't lock OCR out of having a turn. Previously
// a 0.65-ratio fuzzy hit on a wrong-side-of-the-window control would snap
// the region and skip OCR entirely; with the bar raised, those marginal
// cases fall through and OCR (which has its own spatial+text gates) gets
// to override. Strong matches (containment, ≥0.75 jaccard) still pass via
// the strong-match shortcut below.
const MAX_LEV_DISTANCE = 2;
const MIN_FUZZY_RATIO = 0.7;
const MIN_TOKEN_JACCARD = 0.6;

export function normalize(s: string): string {
  // Strip Windows accelerator ampersands ("&File" -> "File"), lowercase, then
  // drop punctuation. Also collapse whitespace so "  Multi  Tool " matches
  // "multi tool".
  return s
    .replace(/&/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Wagner-Fischer Levenshtein. Inputs are short label strings. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const del = (prev[j] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(ins, del, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

function fuzzyRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function centerOf(r: { x: number; y: number; width: number; height: number }): {
  cx: number;
  cy: number;
} {
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}

function dist2(
  a: { cx: number; cy: number },
  b: { cx: number; cy: number },
): number {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  return dx * dx + dy * dy;
}

/**
 * Score the label match against a UIA element. Combines several signals
 * because the model's labels often have extra suffix words ("button",
 * "menu", "icon") that pure Levenshtein hates:
 *   - Levenshtein distance (good for typos / one-character drift)
 *   - Fuzzy ratio (Lev normalized by max length)
 *   - Token Jaccard overlap (model's "multi tool button" vs UIA's "Multi Tool")
 *   - Substring containment (one is contained in the other)
 *
 * Returns the best score across name, helpText, and name+helpText.
 * `containment` and `tokenJaccard` provide alternate paths to a "snap"
 * decision when Lev/ratio fail because of the suffix-word problem.
 */
function tokensOf(s: string): string[] {
  return s.split(' ').filter((t) => t.length > 0);
}

function tokenJaccard(a: string, b: string): number {
  const ta = new Set(tokensOf(a));
  const tb = new Set(tokensOf(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return intersection / union;
}

function substringMatch(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

export function scoreLabelMatch(
  normLabel: string,
  el: UiaElement,
): {
  lev: number;
  ratio: number;
  jaccard: number;
  contains: boolean;
  bestText: string;
} {
  const candidates = [
    normalize(el.name),
    normalize(el.helpText),
    normalize(`${el.name} ${el.helpText}`),
  ].filter((s) => s.length > 0);

  let bestLev = Number.POSITIVE_INFINITY;
  let bestRatio = 0;
  let bestJaccard = 0;
  let bestContains = false;
  let bestText = '';
  for (const c of candidates) {
    const lev = levenshtein(normLabel, c);
    const ratio = fuzzyRatio(normLabel, c);
    const jac = tokenJaccard(normLabel, c);
    const sub = substringMatch(normLabel, c);
    // Combine: prefer the candidate that's the strongest on ANY signal.
    if (
      lev < bestLev ||
      ratio > bestRatio ||
      jac > bestJaccard ||
      (sub && !bestContains)
    ) {
      if (lev < bestLev) bestLev = lev;
      if (ratio > bestRatio) bestRatio = ratio;
      if (jac > bestJaccard) bestJaccard = jac;
      if (sub) bestContains = true;
      bestText = c;
    }
  }
  return {
    lev: bestLev,
    ratio: bestRatio,
    jaccard: bestJaccard,
    contains: bestContains,
    bestText,
  };
}

/**
 * Snap each region to the closest UIA element whose name/helpText matches
 * the region's label. Coordinates: UIA bounds come in *screen* pixels;
 * regions and the returned bounds are in *screenshot* pixels. We scale
 * UIA bounds into screenshot space using `displayBounds` + image dims.
 *
 * For each region:
 * 1. Convert every UIA bound into screenshot coords.
 * 2. Filter to candidates whose center is within MAX_CENTER_DIST_PX of the
 *    model's region center (in screenshot space).
 * 3. Score label match (lower lev + higher ratio = better).
 * 4. Pick the candidate with the best label score, tiebroken by spatial
 *    proximity.
 * 5. If best lev <= MAX_LEV_DISTANCE OR ratio >= MIN_FUZZY_RATIO, snap.
 *    Otherwise leave the region unchanged so OCR can have a turn.
 *
 * TODO(secondary-display-dpi): the caller at provider.ipc.ts:379 passes
 * `screen.getPrimaryDisplay().bounds`, which is wrong when the foreground
 * window — and therefore the captured screenshot — lives on a secondary
 * display with a different DPI/work-area. The fix belongs at the call site:
 * derive `displayBounds` from the foreground HWND's screen via
 * `screen.getDisplayMatching(hwndRect).bounds`, then forward into this
 * function. UIA bounds are screen-space so the scale ratio
 * `imageW / displayBounds.width` is only correct for the display the image
 * came from.
 */
export function snapRegionsToUia(
  regions: TargetRegion[],
  uiaElements: UiaElement[],
  displayBounds: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): TargetRegion[] {
  if (regions.length === 0 || uiaElements.length === 0) return regions;
  if (
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    imageWidth <= 0 ||
    imageHeight <= 0 ||
    displayBounds.width <= 0 ||
    displayBounds.height <= 0
  ) {
    return regions;
  }

  const scaleX = imageWidth / displayBounds.width;
  const scaleY = imageHeight / displayBounds.height;

  // Pre-translate UIA bounds into screenshot coords once.
  type Cand = {
    el: UiaElement;
    box: { x: number; y: number; width: number; height: number };
    center: { cx: number; cy: number };
  };
  // Track whether any candidate had to be clipped to fit the image — useful
  // diagnostic when UIA reports a control whose right/bottom edges spill
  // past the captured frame (multi-monitor mismatches, partial-screen caps).
  let clippedCount = 0;
  const candidates: Cand[] = [];
  for (const el of uiaElements) {
    const x = (el.bounds.x - displayBounds.x) * scaleX;
    const y = (el.bounds.y - displayBounds.y) * scaleY;
    const width = el.bounds.width * scaleX;
    const height = el.bounds.height * scaleY;
    // Clamp both lower (>= 0) and upper (<= imageW/H) bounds so the returned
    // region can never exceed the captured screenshot. Without the upper
    // clamp, a UIA control sitting partway off-screen would emit bbox
    // coords past imageWidth/imageHeight and downstream cropping would
    // produce empty / out-of-range slices.
    const rawX = Math.round(x);
    const rawY = Math.round(y);
    const rawW = Math.round(width);
    const rawH = Math.round(height);
    const clampedX = Math.max(0, Math.min(imageWidth - 1, rawX));
    const clampedY = Math.max(0, Math.min(imageHeight - 1, rawY));
    const clampedRight = Math.max(clampedX + 1, Math.min(imageWidth, rawX + rawW));
    const clampedBottom = Math.max(clampedY + 1, Math.min(imageHeight, rawY + rawH));
    const clampedW = clampedRight - clampedX;
    const clampedH = clampedBottom - clampedY;
    if (clampedW <= 0 || clampedH <= 0) continue;
    if (clampedX !== rawX || clampedY !== rawY || clampedW !== rawW || clampedH !== rawH) {
      clippedCount += 1;
    }
    const box = {
      x: clampedX,
      y: clampedY,
      width: Math.max(1, clampedW),
      height: Math.max(1, clampedH),
    };
    candidates.push({ el, box, center: centerOf(box) });
  }
  if (clippedCount > 0) {
    console.warn(
      `[snap-to-uia] clipped ${clippedCount}/${uiaElements.length} UIA bounds to image=${imageWidth}x${imageHeight} (display=${displayBounds.width}x${displayBounds.height})`,
    );
  }

  const maxDist2 = MAX_CENTER_DIST_PX * MAX_CENTER_DIST_PX;

  return regions.map((region) => {
    const normLabel = normalize(region.label);
    if (normLabel.length === 0) return region;

    const regionCenter = centerOf(region);

    type Best = {
      cand: Cand;
      lev: number;
      ratio: number;
      jaccard: number;
      contains: boolean;
      bestText: string;
      d2: number;
      score: number;
    };
    let best: Best | null = null;
    // Track top-3 considered candidates for diagnostic logging when no snap.
    const topConsidered: Best[] = [];

    for (const cand of candidates) {
      const d2 = dist2(regionCenter, cand.center);
      const { lev, ratio, jaccard, contains, bestText } = scoreLabelMatch(
        normLabel,
        cand.el,
      );

      // Strong-match shortcut: substring containment OR very high token
      // overlap should pass even if spatially far (the model's coords are
      // often loose).
      const strong = contains || jaccard >= 0.75;
      if (!strong && d2 > maxDist2) continue;

      // Combined score: label dominates, spatial is tiebreaker. Lower = better.
      // Negative jaccard component rewards token overlap; contains adds a big
      // bonus.
      const score =
        lev * 1e9 - ratio * 1e6 - jaccard * 1e7 - (contains ? 1e8 : 0) + d2;
      const entry: Best = { cand, lev, ratio, jaccard, contains, bestText, d2, score };
      if (best === null || score < best.score) best = entry;

      // Keep top-3 by score for the debug log.
      topConsidered.push(entry);
      topConsidered.sort((a, b) => a.score - b.score);
      if (topConsidered.length > 3) topConsidered.length = 3;
    }

    if (!best) {
      console.log(
        `[optix-snap] uia: no candidate within ${MAX_CENTER_DIST_PX}px for label="${region.label}"`,
      );
      return region;
    }

    const passes =
      best.lev <= MAX_LEV_DISTANCE ||
      best.ratio >= MIN_FUZZY_RATIO ||
      best.jaccard >= MIN_TOKEN_JACCARD ||
      best.contains;

    if (!passes) {
      // Diagnostic: when we found candidates but none cleared the bar, log
      // the top contenders so we can see *why* nothing matched.
      const summary = topConsidered
        .map((c) => `"${c.bestText}" (lev=${c.lev} jac=${c.jaccard.toFixed(2)} contains=${c.contains})`)
        .join(' | ');
      console.log(`[optix-snap] uia: no match for "${region.label}" — top: ${summary}`);
      return region;
    }

    return {
      label: region.label,
      x: best.cand.box.x,
      y: best.cand.box.y,
      width: best.cand.box.width,
      height: best.cand.box.height,
    };
  });
}

/**
 * How many regions were actually moved by UIA snap. Mirrors `countSnapped`
 * in snap-to-ocr.ts so the [optix-snap] log line can break out the two
 * sources separately.
 */
export function countUiaSnapped(
  before: TargetRegion[],
  after: TargetRegion[],
): number {
  let n = 0;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (!a || !b) continue;
    if (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) {
      n += 1;
    }
  }
  return n;
}
