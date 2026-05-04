import { screen } from 'electron';
import { safeOpenExternal } from '@main/security/safe-url';
import type {
  ComputerToolAction,
  LabelToolAction,
  ProposedAction,
} from '@shared/schemas';
import { resolveLabelToScreenPoint } from '@main/automation/label-resolver';
import { getUiaElements, getUiaElementsAtPoint, type UiaElement } from '@main/capture/uia';
import { normalize, scoreLabelMatch } from '@main/capture/snap-to-uia';


// Lazy-load robotjs so a missing or broken native binding doesn't crash the
// app at startup — only when an action is actually executed. The error then
// surfaces as a clean ExecuteResult instead of an unhandled throw.
//
// We DON'T cache a rejected promise — if the dynamic import fails (DLL
// missing, wrong arch after a Node-version bump, prebuilt binary mismatch),
// holding the rejection forever would mean the user has no way to recover
// without restarting the app. Clearing `robotPromise` on rejection lets a
// subsequent action retry the load (e.g. after the user has run
// `pnpm install` to rebuild native modules and the file is now present).
type Robot = typeof import('@hurdlegroup/robotjs');
let robotPromise: Promise<Robot> | null = null;
async function getRobot(): Promise<Robot> {
  if (!robotPromise) {
    // Use dynamic import so electron-vite externalizes the native module at
    // runtime rather than trying to bundle it. Wrap in an IIFE so we can
    // null out the cache on failure before re-throwing.
    robotPromise = (async () => {
      try {
        const m = await import('@hurdlegroup/robotjs');
        return (m.default ?? m) as Robot;
      } catch (err) {
        // Drop the cached rejection so the next call retries the import.
        robotPromise = null;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[optix-action] robotjs load failed: ${msg}`);
        throw new Error(
          'robotjs native module failed to load. The agent can\'t simulate ' +
            'clicks/typing. Reinstall with `pnpm install` to rebuild native ' +
            'modules for your platform.',
        );
      }
    })();
  }
  return robotPromise;
}

export type ExecuteResult = { ok: true } | { ok: false; error: string };

export type ExecuteOptions = {
  /** Pixel dimensions the model's coordinates are relative to (typically
   *  the screenshot we sent). Used to scale to the actual display. */
  imageWidth?: number;
  imageHeight?: number;
  /** When true, click-style actions are snapped to the nearest interactive
   *  UIA element before executing. Use for providers whose pixel-
   *  coordinate generation is unreliable (Kimi, Gemini); harmless on
   *  accurate providers (Anthropic, OpenAI) but adds ~150-300ms per click
   *  for the UIA enumeration. */
  snapToUia?: boolean;
};

// Auto-snap radius for SPATIAL-ONLY snap (no `target` label provided).
// Tighter to avoid snapping onto the wrong element when the model was
// already roughly accurate.
const SNAP_MAX_DIST_PX = 120;
// Wider radius when a `target` label is provided — the label is doing the
// disambiguation work, so we can tolerate looser coordinates from weaker
// models (Kimi, Gemini). Mirrors Ask-mode overlay snap's MAX_CENTER_DIST_PX.
const SNAP_MAX_DIST_PX_LABELED = 600;
// Same threshold values Ask mode uses for label match acceptance.
const LABEL_MAX_LEV_DISTANCE = 3;
const LABEL_MIN_FUZZY_RATIO = 0.65;
const LABEL_MIN_TOKEN_JACCARD = 0.5;

// UIA control types we treat as "clickable" for snap purposes. Ordered
// roughly by user-intent: buttons / links first (most common click
// targets), then form controls, then list items.
const INTERACTIVE_CONTROL_TYPES = new Set<string>([
  'ControlType.Button',
  'ControlType.Hyperlink',
  'ControlType.MenuItem',
  'ControlType.TabItem',
  'ControlType.ListItem',
  'ControlType.TreeItem',
  'ControlType.CheckBox',
  'ControlType.RadioButton',
  'ControlType.SplitButton',
  'ControlType.Edit',
  'ControlType.ComboBox',
  'ControlType.SpinnerItem',
  'ControlType.Slider',
  'ControlType.Image', // many web buttons render as accessible images
]);

/** Snap a screen-pixel coordinate to the nearest interactive UIA element.
 *  Returns the original coords unchanged if no element is suitable, the
 *  click is far from any element, or UIA is unavailable. The caller
 *  passes coordinates in SCREEN pixels (post-image-to-display mapping). */
async function maybeSnapToUia(
  x: number,
  y: number,
  target?: string,
): Promise<{ x: number; y: number; snapped: boolean; reason: string }> {
  // First try: walk the UIA tree of the window directly under (x, y). This
  // is the most precise option — guaranteed to match the click target.
  let elements = await getUiaElementsAtPoint(x, y).catch(() => [] as UiaElement[]);

  // Fallback: weaker vision models (Kimi) sometimes hallucinate coords
  // beyond the screenshot bounds — e.g. y=1134 on a 900-tall image. Once
  // mapped to display space, that lands off-screen and WindowFromPoint
  // returns null. Salvage the snap by walking the current foreground
  // window's tree instead. The label-match scoring below will still pick
  // the right element by name even if our coords are wildly off.
  if (elements.length === 0) {
    elements = await getUiaElements().catch(() => [] as UiaElement[]);
    if (elements.length > 0) {
      console.log(
        `[optix-cu-snap] uia-at empty for (${x},${y}); falling back to foreground tree (${elements.length} elements)`,
      );
    }
  }

  if (elements.length === 0) {
    return { x, y, snapped: false, reason: 'uia-empty' };
  }

  // ----------------------------------------------------------------
  // LABEL-AWARE SNAP. When the model gave us a `target` (the visible
  // name of the element), use the same scoring that Ask mode uses for
  // overlay regions: Levenshtein + fuzzy ratio + token Jaccard +
  // substring containment, weighted to dominate over spatial distance.
  // The label is doing the disambiguation; we widen the spatial gate
  // because rough coordinates from Kimi/Gemini can be hundreds of
  // pixels off.
  // ----------------------------------------------------------------
  if (target && target.trim().length > 0) {
    const normTarget = normalize(target);
    type LabelBest = {
      el: UiaElement;
      score: number;
      lev: number;
      ratio: number;
      jaccard: number;
      contains: boolean;
      bestText: string;
      d2: number;
    };
    const maxDist2 = SNAP_MAX_DIST_PX_LABELED * SNAP_MAX_DIST_PX_LABELED;
    let best: LabelBest | null = null;
    for (const el of elements) {
      // Don't restrict to INTERACTIVE_CONTROL_TYPES here — sometimes the
      // labelled affordance is a Text or Pane (e.g. taskbar items).
      const cx = el.bounds.x + el.bounds.width / 2;
      const cy = el.bounds.y + el.bounds.height / 2;
      const dx = cx - x;
      const dy = cy - y;
      const d2 = dx * dx + dy * dy;
      const m = scoreLabelMatch(normTarget, el);
      // Strong match (substring or high token overlap) bypasses the
      // spatial gate — the model's coords might be way off, but a clear
      // label match should still win.
      const strong = m.contains || m.jaccard >= 0.75;
      if (!strong && d2 > maxDist2) continue;
      // Same combined score as snap-to-uia.ts: label dominates,
      // spatial distance is a tiebreaker.
      const score =
        m.lev * 1e9 - m.ratio * 1e6 - m.jaccard * 1e7 - (m.contains ? 1e8 : 0) + d2;
      if (best === null || score < best.score) {
        best = { el, score, ...m, d2 };
      }
    }
    if (
      best &&
      (best.lev <= LABEL_MAX_LEV_DISTANCE ||
        best.ratio >= LABEL_MIN_FUZZY_RATIO ||
        best.jaccard >= LABEL_MIN_TOKEN_JACCARD ||
        best.contains)
    ) {
      const cx = Math.round(best.el.bounds.x + best.el.bounds.width / 2);
      const cy = Math.round(best.el.bounds.y + best.el.bounds.height / 2);
      return {
        x: cx,
        y: cy,
        snapped: cx !== x || cy !== y,
        reason: `label "${target}" → "${best.bestText}" (lev=${best.lev} jac=${best.jaccard.toFixed(2)})`,
      };
    }
    // Label was provided but didn't match — fall through to spatial
    // snap rather than failing entirely. Logging the miss helps debug.
    console.log(
      `[optix-cu] label snap miss: target="${target}" — falling back to spatial snap`,
    );
  }

  // ----------------------------------------------------------------
  // SPATIAL-ONLY SNAP (no target, or target didn't match a UIA name).
  // ----------------------------------------------------------------

  // Strong match: the click point lands INSIDE an interactive element.
  // Pick the SMALLEST containing element (most specific — e.g. a button
  // inside a panel inside the window).
  let containingBest: UiaElement | null = null;
  let containingBestArea = Number.POSITIVE_INFINITY;
  for (const el of elements) {
    if (!INTERACTIVE_CONTROL_TYPES.has(el.controlType)) continue;
    const { x: ex, y: ey, width: ew, height: eh } = el.bounds;
    if (x < ex || x >= ex + ew || y < ey || y >= ey + eh) continue;
    const area = ew * eh;
    if (area < containingBestArea) {
      containingBest = el;
      containingBestArea = area;
    }
  }
  if (containingBest) {
    const cx = Math.round(containingBest.bounds.x + containingBest.bounds.width / 2);
    const cy = Math.round(containingBest.bounds.y + containingBest.bounds.height / 2);
    return {
      x: cx,
      y: cy,
      snapped: cx !== x || cy !== y,
      reason: `inside "${containingBest.name || containingBest.helpText || containingBest.controlType}"`,
    };
  }

  // Soft match: nearest interactive element by center distance, within
  // SNAP_MAX_DIST_PX. Used when the model misses the bounds slightly.
  let nearestBest: UiaElement | null = null;
  let nearestBestDist = Number.POSITIVE_INFINITY;
  for (const el of elements) {
    if (!INTERACTIVE_CONTROL_TYPES.has(el.controlType)) continue;
    const cx = el.bounds.x + el.bounds.width / 2;
    const cy = el.bounds.y + el.bounds.height / 2;
    const dx = cx - x;
    const dy = cy - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < nearestBestDist) {
      nearestBestDist = d2;
      nearestBest = el;
    }
  }
  if (nearestBest && Math.sqrt(nearestBestDist) <= SNAP_MAX_DIST_PX) {
    const cx = Math.round(nearestBest.bounds.x + nearestBest.bounds.width / 2);
    const cy = Math.round(nearestBest.bounds.y + nearestBest.bounds.height / 2);
    return {
      x: cx,
      y: cy,
      snapped: true,
      reason: `near "${nearestBest.name || nearestBest.helpText || nearestBest.controlType}" (${Math.round(Math.sqrt(nearestBestDist))}px)`,
    };
  }

  return { x, y, snapped: false, reason: 'no-match' };
}

/**
 * Translate image-space coordinates (e.g. as returned by a vision model on a
 * 1600px-capped screenshot) into display-space pixels. On a 1920×1080 screen
 * captured at 1600×900 the multiplier is 1.2×.
 *
 * Caveat: assumes the primary display. Multi-monitor support is deferred —
 * actions that target a non-primary display will land on the primary instead.
 */
function imageToDisplay(
  x: number,
  y: number,
  imageWidth: number | undefined,
  imageHeight: number | undefined,
): { x: number; y: number } {
  if (!imageWidth || !imageHeight) {
    return { x: Math.round(x), y: Math.round(y) };
  }
  const display = screen.getPrimaryDisplay();
  const sx = display.bounds.width / imageWidth;
  const sy = display.bounds.height / imageHeight;
  return {
    x: display.bounds.x + Math.round(x * sx),
    y: display.bounds.y + Math.round(y * sy),
  };
}

/**
 * Execute one proposed action on the user's machine. Returns a structured
 * result instead of throwing — callers (IPC handler, future tool loops) can
 * decide what to do on failure without try/catch ceremony.
 *
 * Safety guardrails are intentionally NOT in this layer — they live in the
 * caller (approval UI, sensitive-element checks, audit log). This module
 * only knows "given this action, do it."
 */
export async function executeAction(
  action: ProposedAction,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  try {
    const robot = await getRobot();
    switch (action.kind) {
      case 'click': {
        const { x, y } = imageToDisplay(action.x, action.y, opts.imageWidth, opts.imageHeight);
        // 5ms is enough on modern Windows for the move+click to be seen
        // as two events (was 20ms — measurable per-click savings).
        robot.setMouseDelay(5);
        robot.moveMouse(x, y);
        robot.mouseClick();
        console.log(`[optix-action] click at (${x}, ${y})`);
        return { ok: true };
      }
      case 'type': {
        // Char-by-char with extra pause before duplicate chars so Windows
        // doesn't coalesce them. 100ms (was 120ms) is still safely above
        // Windows' ~50ms key-repeat cycle. 25ms baseline keeps unique
        // chars snappy.
        robot.setKeyboardDelay(0);
        let prev = '';
        for (const ch of action.text) {
          if (ch === prev) await new Promise((r) => setTimeout(r, 100));
          else await new Promise((r) => setTimeout(r, 25));
          robot.typeString(ch);
          prev = ch;
        }
        console.log(`[optix-action] typed ${action.text.length} chars`);
        return { ok: true };
      }
      case 'scroll': {
        // Treat `amount` as approximate pixels — robotjs scrollMouse takes
        // (deltaX, deltaY); positive Y on Windows is down.
        const dy = action.direction === 'down' ? action.amount : -action.amount;
        robot.scrollMouse(0, dy);
        console.log(`[optix-action] scroll ${action.direction} ${action.amount}`);
        return { ok: true };
      }
      case 'openUrl': {
        const ok = await safeOpenExternal(action.url);
        if (!ok) {
          return {
            ok: false,
            error: 'Refused to open URL — only http(s) URLs are allowed.',
          };
        }
        console.log(`[optix-action] openUrl ${action.url}`);
        return { ok: true };
      }
      default: {
        const exhaustive: never = action;
        return { ok: false, error: `Unsupported action: ${JSON.stringify(exhaustive)}` };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[optix-action] failed:`, msg);
    return { ok: false, error: msg };
  }
}

// ============================================================================
// Computer Use action executor — handles the broader action set Claude's
// `computer_20251124` tool can emit. Each action's coordinate is in the
// SCREENSHOT's pixel space; we translate to display space the same way as
// `executeAction` above. Returns { text } for query-style actions
// (cursor_position) so the loop driver can include it in tool_result.
// ============================================================================

export type ComputerExecuteResult =
  | { ok: true; text?: string; noScreenshot?: boolean }
  | { ok: false; error: string };

/** Map xdotool-style modifier names to robotjs modifier names. */
function mapModifier(m: string): string | null {
  const lower = m.trim().toLowerCase();
  if (lower === 'ctrl' || lower === 'control') return 'control';
  if (lower === 'shift') return 'shift';
  if (lower === 'alt') return 'alt';
  if (lower === 'cmd' || lower === 'command' || lower === 'super' || lower === 'win') return 'command';
  return null;
}

/** Map xdotool-style key names to robotjs key names. */
function mapKey(k: string): string {
  const lower = k.trim().toLowerCase();
  const aliases: Record<string, string> = {
    return: 'enter',
    esc: 'escape',
    page_up: 'pageup',
    page_down: 'pagedown',
    back_space: 'backspace',
    backspace: 'backspace',
  };
  return aliases[lower] ?? lower;
}

/** Parse an Anthropic key string ("ctrl+shift+t", "Return") into key + mods. */
function parseKeyCombo(combo: string): { key: string; modifiers: string[] } {
  const parts = combo.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { key: '', modifiers: [] };
  const keyPart = parts.pop() as string;
  const modifiers = parts.map(mapModifier).filter((m): m is string => m !== null);
  return { key: mapKey(keyPart), modifiers };
}

export async function executeComputerAction(
  action: ComputerToolAction,
  opts: ExecuteOptions = {},
): Promise<ComputerExecuteResult> {
  try {
    const robot = await getRobot();
    switch (action.action) {
      case 'screenshot': {
        // No execution — caller (loop driver) takes the screenshot and feeds
        // it back as the tool_result content. We just succeed silently.
        return { ok: true };
      }

      case 'wait': {
        // Anthropic specifies `duration` in seconds. Cap at 10s so a runaway
        // model can't stall the loop.
        const ms = Math.min(10_000, Math.max(0, action.duration * 1000));
        await new Promise((r) => setTimeout(r, ms));
        return { ok: true };
      }

      case 'cursor_position': {
        const pos = robot.getMousePos();
        return { ok: true, text: `(${pos.x}, ${pos.y})`, noScreenshot: true };
      }

      case 'mouse_move': {
        const [ix, iy] = action.coordinate;
        const { x, y } = imageToDisplay(ix, iy, opts.imageWidth, opts.imageHeight);
        robot.setMouseDelay(0);
        robot.moveMouse(x, y);
        console.log(`[optix-cu] mouse_move (${x}, ${y})`);
        return { ok: true };
      }

      case 'left_mouse_down':
      case 'left_mouse_up': {
        const [ix, iy] = action.coordinate;
        const { x, y } = imageToDisplay(ix, iy, opts.imageWidth, opts.imageHeight);
        robot.setMouseDelay(5);
        robot.moveMouse(x, y);
        robot.mouseToggle(action.action === 'left_mouse_down' ? 'down' : 'up', 'left');
        console.log(`[optix-cu] ${action.action} (${x}, ${y})`);
        return { ok: true };
      }

      case 'left_click':
      case 'right_click':
      case 'middle_click':
      case 'double_click':
      case 'triple_click': {
        const [ix, iy] = action.coordinate;
        let { x, y } = imageToDisplay(ix, iy, opts.imageWidth, opts.imageHeight);
        // Weaker vision models (Kimi) sometimes generate coords past the
        // screenshot's actual bounds — e.g. y=1134 on a 900-tall image,
        // which projects to display-y=1361 on a 1080-tall display.
        // Clamp to display so the click at least lands on something
        // visible (taskbar, edge of viewport) instead of an unhandled
        // off-screen point.
        const displayBounds = screen.getPrimaryDisplay().bounds;
        const minX = displayBounds.x;
        const maxX = displayBounds.x + displayBounds.width - 1;
        const minY = displayBounds.y;
        const maxY = displayBounds.y + displayBounds.height - 1;
        if (x < minX || x > maxX || y < minY || y > maxY) {
          const clampedX = Math.min(Math.max(minX, x), maxX);
          const clampedY = Math.min(Math.max(minY, y), maxY);
          console.log(
            `[optix-cu] clamp off-screen click (${x},${y}) → (${clampedX},${clampedY})`,
          );
          x = clampedX;
          y = clampedY;
        }
        // Auto-snap to nearest UIA interactive element for providers
        // whose pixel-coordinate generation is unreliable (Kimi, Gemini).
        // When the model includes a `target` label, we use Ask-mode's
        // exact label-match scoring (Levenshtein + fuzzy + Jaccard +
        // containment) — that's the missing piece that made Access mode
        // mis-snap to nearby wrong elements (e.g. Waterfox instead of
        // Firefox).
        let snapDescription = '';
        // DEBUG: log every click's snap state. We're chasing why the
        // executor isn't running the click-snap path. Verbose for now;
        // collapse once we've confirmed the flow works end-to-end.
        console.log(
          `[optix-cu-snap] action=${action.action} coord=(${x},${y}) ` +
            `target=${JSON.stringify(action.target ?? null)} ` +
            `snapToUia=${opts.snapToUia ?? 'undef'}`,
        );
        if (opts.snapToUia) {
          const snap = await maybeSnapToUia(x, y, action.target);
          console.log(
            `[optix-cu-snap] snap result: snapped=${snap.snapped} reason="${snap.reason}"`,
          );
          if (snap.snapped) {
            snapDescription = ` snap: (${x},${y}) → (${snap.x},${snap.y}) ${snap.reason}`;
            x = snap.x;
            y = snap.y;
          }
        }
        const button = action.action === 'right_click'
          ? 'right'
          : action.action === 'middle_click'
            ? 'middle'
            : 'left';
        const repeats = action.action === 'double_click' ? 2 : action.action === 'triple_click' ? 3 : 1;

        // Optional modifier hold (e.g. shift-click). text="ctrl" → hold ctrl
        // for the duration of the click.
        const mods = action.text
          ? action.text.split('+').map(mapModifier).filter((m): m is string => m !== null)
          : [];
        for (const m of mods) robot.keyToggle(m, 'down');
        try {
          // 5ms (was 20ms) — still enough for Windows to register move+click
          // as two events on modern hardware.
          robot.setMouseDelay(5);
          robot.moveMouse(x, y);
          for (let i = 0; i < repeats; i++) {
            robot.mouseClick(button, false);
            if (i < repeats - 1) await new Promise((r) => setTimeout(r, 80));
          }
        } finally {
          for (const m of mods.slice().reverse()) robot.keyToggle(m, 'up');
        }
        console.log(`[optix-cu] ${action.action} (${x}, ${y})${mods.length ? ' mods=' + mods.join('+') : ''}${snapDescription}`);
        return { ok: true };
      }

      case 'left_click_drag': {
        const [sx, sy] = action.start_coordinate;
        const [ex, ey] = action.coordinate;
        const start = imageToDisplay(sx, sy, opts.imageWidth, opts.imageHeight);
        const end = imageToDisplay(ex, ey, opts.imageWidth, opts.imageHeight);
        robot.setMouseDelay(0);
        robot.moveMouse(start.x, start.y);
        robot.mouseToggle('down', 'left');
        // Move in a few steps so the OS recognises this as a drag, not a jump.
        // 3ms inter-step (was 8ms) keeps the cursor visibly continuous while
        // shaving ~40ms off an 8-step drag.
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          const ix = Math.round(start.x + ((end.x - start.x) * i) / steps);
          const iy = Math.round(start.y + ((end.y - start.y) * i) / steps);
          robot.moveMouse(ix, iy);
          await new Promise((r) => setTimeout(r, 3));
        }
        robot.mouseToggle('up', 'left');
        console.log(`[optix-cu] drag (${start.x},${start.y}) → (${end.x},${end.y})`);
        return { ok: true };
      }

      case 'type': {
        // Char-by-char with extra pause before duplicate chars so Windows
        // doesn't coalesce them. 100ms (was 120ms) is still safely above the
        // ~50ms Windows key-repeat cycle without being needlessly slow.
        robot.setKeyboardDelay(0);
        let prev = '';
        for (const ch of action.text) {
          if (ch === prev) await new Promise((r) => setTimeout(r, 100));
          else await new Promise((r) => setTimeout(r, 25));
          robot.typeString(ch);
          prev = ch;
        }
        console.log(`[optix-cu] type ${action.text.length} chars`);
        return { ok: true };
      }

      case 'key': {
        const { key, modifiers } = parseKeyCombo(action.text);
        if (!key) return { ok: false, error: `Empty key combo: ${action.text}` };
        try {
          // robotjs `keyTap(key, modifier|modifiers)` — modifiers held during tap.
          if (modifiers.length === 0) robot.keyTap(key);
          else robot.keyTap(key, modifiers);
        } catch (kerr) {
          const msg = kerr instanceof Error ? kerr.message : String(kerr);
          console.warn(
            `[optix-cu] key failed raw="${action.text}" parsed=key="${key}" mods=[${modifiers.join(',')}] err=${msg}`,
          );
          return { ok: false, error: `Unknown key: "${action.text}" (parsed as "${key}" with modifiers [${modifiers.join(',')}])` };
        }
        console.log(`[optix-cu] key ${action.text}`);
        return { ok: true };
      }

      case 'hold_key': {
        const { key, modifiers } = parseKeyCombo(action.text);
        if (!key) return { ok: false, error: `Empty key combo: ${action.text}` };
        const ms = Math.min(10_000, Math.max(0, action.duration * 1000));
        for (const m of modifiers) robot.keyToggle(m, 'down');
        robot.keyToggle(key, 'down');
        try {
          await new Promise((r) => setTimeout(r, ms));
        } finally {
          robot.keyToggle(key, 'up');
          for (const m of modifiers.slice().reverse()) robot.keyToggle(m, 'up');
        }
        console.log(`[optix-cu] hold_key ${action.text} ${ms}ms`);
        return { ok: true };
      }

      case 'scroll': {
        // 120px per "click" matches Windows' WHEEL_DELTA constant — apps
        // that watch for >= WHEEL_DELTA (browsers especially) reliably
        // see one notch of scroll. Was 100, which some browsers ignored.
        const amount = action.scroll_amount * 120;
        let dx = 0;
        let dy = 0;
        switch (action.scroll_direction) {
          case 'up': dy = -amount; break;
          case 'down': dy = amount; break;
          case 'left': dx = -amount; break;
          case 'right': dx = amount; break;
        }
        const [ix, iy] = action.coordinate;
        const { x, y } = imageToDisplay(ix, iy, opts.imageWidth, opts.imageHeight);
        // Move cursor to scroll location first so the scroll lands on the
        // intended element rather than wherever the cursor happens to be.
        robot.setMouseDelay(10);
        robot.moveMouse(x, y);
        robot.scrollMouse(dx, dy);
        console.log(`[optix-cu] scroll ${action.scroll_direction} ${action.scroll_amount} at (${x},${y})`);
        return { ok: true };
      }

      default: {
        const exhaustive: never = action;
        return { ok: false, error: `Unsupported computer action: ${JSON.stringify(exhaustive)}` };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[optix-cu] failed:`, msg);
    return { ok: false, error: msg };
  }
}

// ============================================================================
// Label-based action executor — for tool calls like `click_label("Submit")`.
// Resolves the label to screen coordinates via Windows UI Automation, then
// executes via robotjs. Lets weaker vision models avoid pixel arithmetic
// entirely.
// ============================================================================

export async function executeLabelAction(
  action: LabelToolAction,
): Promise<ComputerExecuteResult> {
  try {
    const robot = await getRobot();
    const resolution = await resolveLabelToScreenPoint(action.label);
    if (!resolution.ok) {
      return { ok: false, error: resolution.reason };
    }
    const { x, y, element } = resolution;

    switch (action.action) {
      case 'click_label': {
        robot.setMouseDelay(5);
        robot.moveMouse(x, y);
        robot.mouseClick();
        console.log(
          `[optix-label] click "${action.label}" → "${element.name}" at (${x}, ${y})`,
        );
        return { ok: true, text: `Clicked "${element.name}" at (${x}, ${y}).` };
      }
      case 'scroll_label': {
        const px = action.amount * 120;
        let dx = 0, dy = 0;
        switch (action.direction) {
          case 'up': dy = -px; break;
          case 'down': dy = px; break;
          case 'left': dx = -px; break;
          case 'right': dx = px; break;
        }
        robot.setMouseDelay(5);
        robot.moveMouse(x, y);
        robot.scrollMouse(dx, dy);
        console.log(
          `[optix-label] scroll ${action.direction} ${action.amount} on "${action.label}" → "${element.name}"`,
        );
        return {
          ok: true,
          text: `Scrolled ${action.direction} ${action.amount} on "${element.name}".`,
        };
      }
      case 'type_into_label': {
        // Click to focus, then char-by-char type with the same duplicate-pause
        // safety as `executeComputerAction.type`.
        robot.setMouseDelay(5);
        robot.moveMouse(x, y);
        robot.mouseClick();
        await new Promise((r) => setTimeout(r, 100));
        robot.setKeyboardDelay(0);
        let prev = '';
        for (const ch of action.text) {
          if (ch === prev) await new Promise((r) => setTimeout(r, 100));
          else await new Promise((r) => setTimeout(r, 25));
          robot.typeString(ch);
          prev = ch;
        }
        console.log(
          `[optix-label] type ${action.text.length} chars into "${action.label}" → "${element.name}"`,
        );
        return {
          ok: true,
          text: `Typed ${action.text.length} chars into "${element.name}".`,
        };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[optix-label] failed:`, msg);
    return { ok: false, error: msg };
  }
}

/** Human-readable description of a label action for UI display. */
export function describeLabelAction(a: LabelToolAction): string {
  switch (a.action) {
    case 'click_label': return `Click "${a.label}"`;
    case 'scroll_label': return `Scroll ${a.direction} ${a.amount} on "${a.label}"`;
    case 'type_into_label': {
      const preview = a.text.length > 30 ? a.text.slice(0, 27) + '…' : a.text;
      return `Type "${preview}" into "${a.label}"`;
    }
  }
}

/** Human-readable description of a computer action for UI display. */
export function describeComputerAction(a: ComputerToolAction): string {
  switch (a.action) {
    case 'screenshot': return 'Take screenshot';
    case 'wait': return `Wait ${a.duration}s`;
    case 'cursor_position': return 'Read cursor position';
    case 'mouse_move': return `Move to (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_mouse_down': return `Mouse down at (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_mouse_up': return `Mouse up at (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_click': return `Click (${a.coordinate[0]}, ${a.coordinate[1]})${a.text ? ' +' + a.text : ''}`;
    case 'right_click': return `Right-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'middle_click': return `Middle-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'double_click': return `Double-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'triple_click': return `Triple-click (${a.coordinate[0]}, ${a.coordinate[1]})`;
    case 'left_click_drag':
      return `Drag (${a.start_coordinate[0]},${a.start_coordinate[1]}) → (${a.coordinate[0]},${a.coordinate[1]})`;
    case 'type': {
      const preview = a.text.length > 40 ? a.text.slice(0, 37) + '…' : a.text;
      return `Type "${preview}"`;
    }
    case 'key': return `Press ${a.text}`;
    case 'hold_key': return `Hold ${a.text} ${a.duration}s`;
    case 'scroll': return `Scroll ${a.scroll_direction} ${a.scroll_amount}`;
  }
}
