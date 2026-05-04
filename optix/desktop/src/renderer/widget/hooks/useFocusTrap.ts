import { useEffect, useRef } from 'react';

/** Tab-cycling focus trap for modal-like surfaces (approval gates,
 *  choice prompts). On mount: stash the previously-focused element,
 *  focus the first interactive descendant. On Tab/Shift+Tab at the
 *  boundary: cycle within the container. On unmount: restore focus
 *  to whatever had it before. Caller passes the container ref.
 *
 *  Kept deliberately small — no portal / no aria-hidden swap of the
 *  rest of the page. The widget is itself a contained surface so a
 *  scoped Tab cycle is enough to stop focus escaping into the chat
 *  area while a gate is up. */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: React.RefObject<T>,
  enabled = true,
): void {
  // Tracked across the effect's lifetime so the cleanup can put
  // focus back where the user had it. Captured at mount, not on
  // every render — re-grabbing it later would point at our own
  // modal once it's focused.
  const previousActiveRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    previousActiveRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Focus the first focusable descendant. If the modal is empty
    // we focus the container itself (which needs tabIndex=-1) so
    // keystrokes still land somewhere inside the trap.
    const focusables = getFocusable(container);
    const first = focusables[0];
    if (first) first.focus();
    else container.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const items = getFocusable(container);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === firstEl || !container.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (active === lastEl || !container.contains(active)) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    // Bound on the container so we only intercept Tab while focus
    // is inside the modal — outside Tabs (if focus ever escaped
    // before the trap mounted) stay normal.
    container.addEventListener('keydown', onKey);
    return () => {
      container.removeEventListener('keydown', onKey);
      // Restore focus on unmount. Guard against the previously-
      // focused element having been removed from the DOM in the
      // meantime — `.focus()` on a detached node is a no-op but
      // we check for safety.
      const prev = previousActiveRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [containerRef, enabled]);
}

/** Selector + filter for tabbable elements inside the container. We
 *  keep the list short and exclude `[tabindex="-1"]` since those are
 *  programmatically focusable but not Tab-reachable — including them
 *  would stop the cycle on hidden anchors. */
function getFocusable(root: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(sel));
  return nodes.filter((n) => !n.hasAttribute('disabled') && n.tabIndex !== -1);
}
