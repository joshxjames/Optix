import { useEffect, useRef } from 'react';

/** Attach a global Escape-key listener for the lifetime of the
 *  component (or while `enabled` is true). The handler is held in a
 *  ref and updated on each render so the listener always invokes the
 *  latest closure without re-binding window events on every state
 *  change — which is what the previous inline implementations did,
 *  causing churn and a brief leak window between remove/add. */
export function useEscapeKey(handler: () => void, enabled = true): void {
  const handlerRef = useRef(handler);
  // Keep the ref pointed at the freshest handler. Runs after every
  // render — cheap, and avoids stale-closure bugs that the prior
  // [view, onClose]-style deps were trying (and partly failing) to
  // work around.
  useEffect(() => {
    handlerRef.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') handlerRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
