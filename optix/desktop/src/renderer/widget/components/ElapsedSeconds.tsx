import { memo, useEffect, useState } from 'react';

type Props = {
  /** Epoch ms when the busy state started. When this changes, the counter resets. */
  since: number;
};

/**
 * Self-contained ticker: owns its own `elapsed` state and 1s interval so that
 * parents (e.g. App) don't re-render every second just to update a digit.
 * Renders the integer second count only — callers supply surrounding text.
 */
function ElapsedSecondsImpl({ since }: Props) {
  // Initialiser computes the synchronous value on first render so we
  // don't render once with 0 then immediately re-render with the real
  // count on mount. (The interval below handles ongoing updates and
  // the `since` change case — its first tick will replace the stale
  // state if the parent reuses this instance with a new start time.)
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - since) / 1000));

  // `since` is in the dep array intentionally so the interval is
  // re-created with a fresh closure when the parent passes a new start
  // time. Without it the interval would forever close over the original
  // `since`, producing a stale elapsed count after a parent reuse.
  useEffect(() => {
    // Sync immediately so a `since` change is reflected before the
    // first interval tick (~1s lag would otherwise be visible).
    setElapsed(Math.floor((Date.now() - since) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - since) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [since]);

  return <>{elapsed}</>;
}

export const ElapsedSeconds = memo(ElapsedSecondsImpl);
