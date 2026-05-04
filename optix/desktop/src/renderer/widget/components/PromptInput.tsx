import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  /** Optional keyboard interceptor — returns true to consume the
   *  event before the textarea handles it. Used by the slash menu
   *  in App.tsx to capture ArrowUp/ArrowDown/Enter/Escape while
   *  the menu is open. */
  onIntercept?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Fires whenever the cursor / selection moves. Drives the slash
   *  menu's "active token at cursor" detection. */
  onCursorChange?: (cursor: number) => void;
  /** Placeholder shown when the textarea is empty. Set per-mode by
   *  App.tsx so each tab carries an appropriate hint. */
  placeholder?: string;
};

/** Imperative handle exposed via ref so the parent (App.tsx) can
 *  apply a textual replacement around the cursor and refocus the
 *  textarea after picking a routine from the slash menu. */
export type PromptInputHandle = {
  /** Replace `[start, end)` in the value with `replacement`, set the
   *  cursor to the end of the replacement, and refocus. */
  replaceRange: (start: number, end: number, replacement: string) => void;
  focus: () => void;
};

/** Split the prompt around `/OA-{n}` tokens so the overlay can wrap
 *  each token in a styled chip while keeping the surrounding text
 *  unchanged. Returns alternating string/token entries; the renderer
 *  walks the array and applies the chip class only to tokens. */
function tokeniseForOverlay(value: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\/OA-\d+/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(value)) !== null) {
    if (match.index > last) {
      parts.push(<span key={`t-${key++}`}>{value.slice(last, match.index)}</span>);
    }
    parts.push(
      <span key={`t-${key++}`} className="widget__prompt-token">
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < value.length) {
    parts.push(<span key={`t-${key++}`}>{value.slice(last)}</span>);
  }
  // A trailing newline at the end of the textarea content needs an
  // explicit space in the overlay; otherwise the overlay collapses
  // its last line and the visual heights diverge by one line.
  if (value.length === 0 || value.endsWith('\n')) {
    parts.push(<span key={`t-${key++}`}> </span>);
  }
  return parts;
}

export const PromptInput = forwardRef<PromptInputHandle, Props>(function PromptInput(
  { value, onChange, onSubmit, disabled, onIntercept, onCursorChange, placeholder },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Latest-callback refs so long-lived callbacks (the imperative
  // handle, the rAF in `replaceRange`, the `reportCursor` helper)
  // always invoke the most recent prop. Without this, parents that
  // rebind `onCursorChange`/`onChange`/`onIntercept` between renders
  // would see stale closures fire after async boundaries.
  const latestOnCursorChangeRef = useRef(onCursorChange);
  const latestOnChangeRef = useRef(onChange);
  const latestOnInterceptRef = useRef(onIntercept);
  useEffect(() => {
    latestOnCursorChangeRef.current = onCursorChange;
    latestOnChangeRef.current = onChange;
    latestOnInterceptRef.current = onIntercept;
  });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useImperativeHandle(
    ref,
    (): PromptInputHandle => ({
      replaceRange: (start, end, replacement) => {
        const next = value.slice(0, start) + replacement + value.slice(end);
        latestOnChangeRef.current(next);
        // Defer the cursor placement until React re-renders with the
        // new value, otherwise the textarea's selection would be
        // measured against the old string.
        const targetCursor = start + replacement.length;
        requestAnimationFrame(() => {
          const ta = textareaRef.current;
          if (!ta) return;
          ta.focus();
          ta.setSelectionRange(targetCursor, targetCursor);
          latestOnCursorChangeRef.current?.(targetCursor);
        });
      },
      focus: () => textareaRef.current?.focus(),
    }),
    [value],
  );

  // Notify the parent on every cursor / selection change so the
  // slash-menu "active token at cursor" detector stays in sync. The
  // textarea fires `onSelect` for both keyboard navigation AND
  // mouse clicks; we also forward on focus + value changes.
  const reportCursor = (): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    latestOnCursorChangeRef.current?.(ta.selectionStart ?? 0);
  };
  useEffect(() => {
    // After an external value update (e.g. setPrompt from the slash
    // pick), the cursor might still report the old position for one
    // frame. Re-sync on every value change. `reportCursor` reads the
    // latest callback through the ref so omitting it from deps is
    // safe and intentional.
    reportCursor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Scroll sync — when the textarea content overflows vertically,
  // the overlay needs to scroll in lockstep so the chips stay
  // aligned with the underlying caret position.
  useEffect(() => {
    const ta = textareaRef.current;
    const ov = overlayRef.current;
    if (!ta || !ov) return;
    const sync = (): void => {
      ov.scrollTop = ta.scrollTop;
      ov.scrollLeft = ta.scrollLeft;
    };
    ta.addEventListener('scroll', sync, { passive: true });
    sync();
    return () => ta.removeEventListener('scroll', sync);
  }, []);

  // Re-sync when the value changes (e.g. an external setPrompt) since
  // the layout may have shifted.
  const overlayParts = useMemo(() => tokeniseForOverlay(value), [value]);
  useEffect(() => {
    const ta = textareaRef.current;
    const ov = overlayRef.current;
    if (!ta || !ov) return;
    ov.scrollTop = ta.scrollTop;
    ov.scrollLeft = ta.scrollLeft;
  }, [value]);

  return (
    <div className="widget__prompt-input">
      {/* Visual rendering layer — sits behind the textarea and shows
          tokens as styled chips. Hidden from AT (the textarea is the
          source of truth) and ignores pointer events so clicks fall
          through to the textarea for caret placement. */}
      <div
        ref={overlayRef}
        className="widget__prompt-overlay"
        aria-hidden="true"
      >
        {overlayParts}
      </div>
      <textarea
        ref={textareaRef}
        className="widget__prompt"
        placeholder={
          placeholder ??
          "Ask about what's on your screen… e.g. 'How do I create an invoice here?'"
        }
        value={value}
        onChange={(e) => {
          latestOnChangeRef.current(e.target.value);
          // Report cursor on next tick — the textarea's
          // selectionStart is updated synchronously after the input
          // event, but doing it here keeps the contract simple.
          reportCursor();
        }}
        onKeyDown={(e) => {
          if (latestOnInterceptRef.current?.(e)) {
            e.preventDefault();
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSubmit();
          }
        }}
        onKeyUp={reportCursor}
        onClick={reportCursor}
        onFocus={reportCursor}
        onSelect={reportCursor}
        disabled={disabled}
        rows={3}
        spellCheck={false}
      />
    </div>
  );
});
