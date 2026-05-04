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

// Near-tie guard: when the top two candidates are within this score
// gap, we require a stronger absolute match before accepting. Prevents
// silently picking the wrong one of two near-identical labels (e.g.
// two "Submit" buttons on a page).
const TIEBREAK_GAP = 0.05;
const TIEBREAK_MIN_RATIO = 0.85;

// UIA control types the agent can usefully click / interact with.
// Disabled and static-text matches are useless to click and just
// confuse the agent (and can trigger false-positive "matches" on
// labels that happen to appear as instructional text on the page).
const INTERACTIVE_CONTROL_TYPES = new Set<string>([
  'ControlType.Button',
  'ControlType.Hyperlink',
  'ControlType.MenuItem',
  'ControlType.ListItem',
  'ControlType.CheckBox',
  'ControlType.RadioButton',
  'ControlType.Edit',
  'ControlType.ComboBox',
  'ControlType.TabItem',
  'ControlType.Tab',
]);

export type LabelResolution =
  | {
      ok: true;
      x: number;
      y: number;
      element: UiaElement;
      /** Identity of the resolved element at the moment of UIA query.
       *  Captures bounds + name into a single short hash so the caller
       *  can detect "the element I clicked is no longer the one I
       *  resolved" — the most common cause of phantom-misclicks
       *  (resolver fires, page re-flows, click lands on a different
       *  element by the time robotjs runs). Right now we only emit
       *  this in the executor log; a future pass can re-query at
       *  click time and compare. */
      identity: string;
      /** Wall-clock time the UIA query returned, in ms since epoch.
       *  Combined with the executor's pre-click timestamp it tells us
       *  how stale the resolution was. */
      resolvedAt: number;
    }
  | {
      ok: false;
      reason: string;
    };

/** Cheap hash of an element's identity — bounds + name. We don't need
 *  cryptographic strength here, just a value that changes when either
 *  the element's position or its accessible name does. Hex string keeps
 *  the log line short. */
function elementIdentity(el: UiaElement): string {
  const { x, y, width, height } = el.bounds;
  const name = el.name ?? '';
  const ct = el.controlType;
  let h = 0;
  const s = `${ct}|${name}|${x},${y},${width},${height}`;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  // Shift into unsigned + base-36 keeps it 6-7 chars typical.
  return (h >>> 0).toString(36);
}

/** Find the UIA element best matching `label` and return its center point
 *  in screen pixels. */
export async function resolveLabelToScreenPoint(label: string): Promise<LabelResolution> {
  // Capture wall-clock at query start so the caller can measure
  // resolve→click latency — a high delta is a strong hint that any
  // misclick was caused by UI re-flow between query and dispatch.
  const queryStart = Date.now();
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
    // Filter to interactive control types only. Static text / disabled
    // matches just confuse the agent — they look like the right thing
    // by name but you can't click them.
    if (!INTERACTIVE_CONTROL_TYPES.has(el.controlType)) continue;
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

  // Near-tie guard: when two candidates score nearly identically on
  // the fuzzy ratio, the top-1 might be wrong half the time. Require
  // the winner to clear a higher bar before we silently pick it; if
  // it doesn't, return ambiguous so the agent can ask for a more
  // specific label.
  if (best && considered.length >= 2) {
    const top = considered[0];
    const second = considered[1];
    if (top && second && Math.abs(top.ratio - second.ratio) < TIEBREAK_GAP) {
      if (top.ratio < TIEBREAK_MIN_RATIO) {
        return {
          ok: false,
          reason: `Ambiguous label "${label}" — top two candidates "${top.bestText}" and "${second.bestText}" tied (ratio ${top.ratio.toFixed(2)}/${second.ratio.toFixed(2)}). Use a more specific label.`,
        };
      }
    }
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
  const resolvedAt = Date.now();
  const identity = elementIdentity(best.el);
  // Diagnostic: log query latency + the resolved element's identity.
  // The executor logs again at click time; comparing the two timestamps
  // tells us how long the gap is in the wild. Once we have data we can
  // add a re-query-and-compare retry (out of scope for this pass).
  console.warn(
    `[optix-label-resolve] label="${label}" → "${best.bestText}" ` +
      `id=${identity} bounds=(${x},${y},${width},${height}) ` +
      `query_ms=${resolvedAt - queryStart}`,
  );
  return {
    ok: true,
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
    element: best.el,
    identity,
    resolvedAt,
  };
}
