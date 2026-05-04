import type { TargetRegion } from '@shared/schemas';
import type { OcrBox } from '@main/capture/ocr';

const MAX_CENTER_DIST_PX = 200;
const MAX_LEV_DISTANCE = 2;
const MIN_FUZZY_RATIO = 0.7;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
}

/** Classic Wagner-Fischer Levenshtein. Inputs are short label strings. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  // Two-row DP — O(min(m,n)) memory.
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
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - dist / maxLen;
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
 * For each region with a label, find the nearest OCR word whose normalized
 * text matches the label closely (Levenshtein <= 2 OR fuzzy ratio > 0.7) and
 * is within MAX_CENTER_DIST_PX of the model's bbox center. When a match is
 * found, snap the region's geometry to the OCR word's bbox while preserving
 * the original label. When no match is found (icon-only buttons, etc.), the
 * region is returned unchanged.
 *
 * MVP only matches against single OCR words. Multi-word label matching
 * (concatenating adjacent words on the same line) is a follow-up.
 */
export function snapRegionsToOcr(
  regions: TargetRegion[],
  ocrBoxes: OcrBox[],
  imageDims?: { width: number; height: number },
): TargetRegion[] {
  if (regions.length === 0 || ocrBoxes.length === 0) return regions;

  // Pre-normalize OCR text so we don't redo the work per-region.
  const normalizedOcr = ocrBoxes.map((b) => ({ box: b, norm: normalize(b.text) }));

  return regions.map((region) => {
    const label = normalize(region.label);
    if (label.length === 0) return region;

    const regionCenter = centerOf(region);
    const maxDist2 = MAX_CENTER_DIST_PX * MAX_CENTER_DIST_PX;

    let best: { box: OcrBox; score: number; d2: number } | null = null;
    for (const { box, norm } of normalizedOcr) {
      if (norm.length === 0) continue;
      const d2 = dist2(regionCenter, centerOf(box.bbox));
      if (d2 > maxDist2) continue;

      const lev = levenshtein(label, norm);
      const ratio = fuzzyRatio(label, norm);
      const passes = lev <= MAX_LEV_DISTANCE || ratio > MIN_FUZZY_RATIO;
      if (!passes) continue;

      // Score: prefer lower Levenshtein, break ties with closer center.
      // Pack into a single number where lev dominates.
      const score = lev * 1e9 + d2;
      if (best === null || score < best.score) {
        best = { box, score, d2 };
      }
    }

    if (!best) {
      // Diagnostic: when no OCR word cleared the distance + text gates,
      // surface the input so the caller has a signal that snap silently
      // returned the model's original (likely loose) region. Mirrors the
      // analogous log in snap-to-uia.ts.
      console.warn(
        '[snap-to-ocr] no match within distance, returning original region',
        {
          label: region.label,
          regionCenter,
          maxDistPx: MAX_CENTER_DIST_PX,
          ocrCount: ocrBoxes.length,
        },
      );
      return region;
    }
    // Clamp to image bounds when caller supplied dimensions. Without this
    // an OCR box that runs to the very edge of the screenshot can emit
    // x+width slightly past imageWidth depending on tesseract's rounding,
    // and downstream crops produce empty slices.
    const bbox = best.box.bbox;
    if (imageDims && imageDims.width > 0 && imageDims.height > 0) {
      const clampedX = Math.max(0, Math.min(imageDims.width - 1, bbox.x));
      const clampedY = Math.max(0, Math.min(imageDims.height - 1, bbox.y));
      const clampedRight = Math.max(clampedX + 1, Math.min(imageDims.width, bbox.x + bbox.width));
      const clampedBottom = Math.max(clampedY + 1, Math.min(imageDims.height, bbox.y + bbox.height));
      const clampedW = clampedRight - clampedX;
      const clampedH = clampedBottom - clampedY;
      if (clampedW <= 0 || clampedH <= 0) {
        // Snapped box is fully outside the image — fall back to the
        // model's original region rather than emit a degenerate bbox.
        console.warn(
          '[snap-to-ocr] snapped bbox fully outside image, falling back to original region',
          { label: region.label, bbox, imageDims },
        );
        return region;
      }
      if (
        clampedX !== bbox.x ||
        clampedY !== bbox.y ||
        clampedW !== bbox.width ||
        clampedH !== bbox.height
      ) {
        console.warn(
          `[snap-to-ocr] clipped bbox to image=${imageDims.width}x${imageDims.height} for label="${region.label}"`,
        );
      }
      return {
        label: region.label,
        x: clampedX,
        y: clampedY,
        width: clampedW,
        height: clampedH,
      };
    }
    return {
      label: region.label,
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
    };
  });
}

/**
 * Convenience: report how many regions were actually moved by snapping.
 * Useful for the [optix-snap] log line.
 */
export function countSnapped(
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
