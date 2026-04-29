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
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - since) / 1000));

  useEffect(() => {
    setElapsed(Math.floor((Date.now() - since) / 1000));
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - since) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [since]);

  return <>{elapsed}</>;
}

export const ElapsedSeconds = memo(ElapsedSecondsImpl);
