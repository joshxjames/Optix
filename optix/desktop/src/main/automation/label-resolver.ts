// Label → screen-coordinate resolver. The agent calls a label-based tool
// (`click_label`, `scroll_label`, `type_into_label`) with a target like
// "Submit" or "Firefox icon"; this module finds the matching UI element
// via Windows UI Automation and returns the center point in screen pixels
// for robotjs to act on.
//
// We reuse the fuzzy matcher already battle-tested in `snap-to-uia.ts`
// (used by Guide-mode overlay snap) — same scoring, different consumer.
//
// Failure mode: when no element matches, we return null. The executor
// surfaces a structured tool_result error like
// `No element matching "Submit" — UIA found 47 candidates, top 3: ...`
// so the model can correct on the next turn (try a different label,
// fall back to coordinate clicks).

import { getUiaElements, type UiaElement } from '@main/capture/uia';
import { normalize, scoreLabelMatch } from '@main/capture/snap-to-uia';

// Same thresholds as the overlay snapper. Tuned across many app surfaces
// during the Guide-mode work.
const MAX_LEV_DISTANCE = 3;
const MIN_FUZZY_RATIO = 0.65;
const MIN_TOKEN_JACCARD = 0.5;

export type LabelResolution =
  | {
      ok: true;
      x: number;
      y: number;
      element: UiaElement;
    }
  | {
      ok: false;
      reason: string;
    };

/** Find the UIA element best matching `label` and return its center point
 *  in screen pixels. */
export async function resolveLabelToScreenPoint(label: string): Promise<LabelResolution> {
  const elements = await getUiaElements();
  if (elements.length === 0) {
    return {
      ok: false,
      reason:
        'No UI elements available (UI Automation returned nothing). Try a coordinate-based action instead.',
    };
  }
  const normLabel = normalize(label);
  if (normLabel.length === 0) {
    return { ok: false, reason: `Empty label.` };
  }

  type Best = {
    el: UiaElement;
    score: number;
    bestText: string;
    lev: number;
    ratio: number;
    jaccard: number;
    contains: boolean;
  };
  let best: Best | null = null;
  const considered: Best[] = [];

  for (const el of elements) {
    const m = scoreLabelMatch(normLabel, el);
    const passes =
      m.lev <= MAX_LEV_DISTANCE ||
      m.ratio >= MIN_FUZZY_RATIO ||
      m.jaccard >= MIN_TOKEN_JACCARD ||
      m.contains;
    if (!passes) continue;
    // Lower score = better match (same convention as snap-to-uia).
    const score =
      m.lev * 1e9 - m.ratio * 1e6 - m.jaccard * 1e7 - (m.contains ? 1e8 : 0);
    const entry: Best = {
      el,
      score,
      bestText: m.bestText,
      lev: m.lev,
      ratio: m.ratio,
      jaccard: m.jaccard,
      contains: m.contains,
    };
    if (best === null || score < best.score) best = entry;
    considered.push(entry);
    considered.sort((a, b) => a.score - b.score);
    if (considered.length > 3) considered.length = 3;
  }

  if (best === null) {
    // List a sample so the model can see what we DID find.
    const sample = elements
      .slice(0, 8)
      .map((el) => `"${el.name || el.helpText || el.controlType}"`)
      .join(', ');
    return {
      ok: false,
      reason: `No UI element matching "${label}". Visible elements include: ${sample}. Try a coordinate-based action or a different label.`,
    };
  }

  const { x, y, width, height } = best.el.bounds;
  return {
    ok: true,
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
    element: best.el,
  };
}
