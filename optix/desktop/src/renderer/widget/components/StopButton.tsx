import { memo } from 'react';
import { CirclePauseIcon, CirclePlayIcon, CircleStopIcon } from './Icons';

type Props = {
  /** False when there's no active request to act on. Button still
   *  renders so the actions-row layout is stable, but greys out. */
  enabled: boolean;
  /** True when an Access loop is running (pausable). Drives:
   *   • single-click semantics (toggle pause/resume vs cancel)
   *   • which icon shows (pause/play vs stop) */
  canPause: boolean;
  /** True when the loop has been paused by the user. */
  paused: boolean;
  /** Toggle pause ↔ resume. App.tsx owns the asymmetric behaviour:
   *  pausing is fully instant; resuming updates UI instantly but
   *  defers the actual loop unpark so a follow-up double-click can
   *  intercept and cancel before any new agent action fires. */
  onToggle: () => void;
  /** Cancel the run. Single-click in Ask mode (no pause semantics) /
   *  double-click in Access mode. Clears any pending resume in
   *  App.tsx before aborting. */
  onCancel: () => void;
};

/**
 * Unified pause/resume/cancel control. One button stays in the actions
 * row regardless of state so the layout never reflows. The inner glyph
 * is the only thing that changes:
 *   • Access running  → pause bars  (click → pause, dblclick → cancel)
 *   • Access paused   → play arrow  (click → resume, dblclick → cancel)
 *   • Ask in flight   → stop square (click → cancel)
 *   • Idle            → stop square, disabled
 *
 * The browser fires both `click` events from a double-click before
 * `dblclick`. App.tsx's `resumeLoop` defers the actual loop unpark
 * by ~220ms, so a double-click while paused never produces a visible
 * resume — the second click fires cancel inside that delay window
 * and the queued resume is discarded.
 */
function StopButtonImpl({ enabled, canPause, paused, onToggle, onCancel }: Props) {
  const Icon = !canPause
    ? CircleStopIcon
    : paused
      ? CirclePlayIcon
      : CirclePauseIcon;

  const title = !enabled
    ? 'No active request'
    : !canPause
      ? 'Cancel the current request'
      : paused
        ? 'Resume — double-click to cancel'
        : 'Pause — double-click to cancel';

  // Highlight while paused — same accent tint the folder/overlay icon
  // buttons use when active, so the row's "this control is currently
  // doing something" cue is consistent across the chrome.
  const className = `btn btn--icon${paused ? ' btn--icon-active' : ''}`;

  return (
    <button
      type="button"
      className={className}
      disabled={!enabled}
      onClick={canPause ? onToggle : onCancel}
      onDoubleClick={canPause ? onCancel : undefined}
      title={title}
      aria-label={title}
    >
      <Icon />
    </button>
  );
}

export const StopButton = memo(StopButtonImpl);
