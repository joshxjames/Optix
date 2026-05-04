import { useRef, useState } from 'react';
import type { AskUserAction } from '../../../shared/schemas';
import { useFocusTrap } from '../hooks/useFocusTrap';

type Props = {
  action: AskUserAction;
  /** Called with the chosen option's `value`, or freeform text. */
  onSubmit: (value: string) => void;
};

/**
 * Inline option-picker rendered when the agent calls the `ask_user` meta
 * tool. Up to 4 vertically-stacked option buttons; an optional freeform
 * input below if the action's `allowFreeform` flag is set.
 *
 * The widget needs keyboard focus while this is showing — the user is
 * picking an answer for the agent. The runLoop driver toggles widget
 * focusability around the await; while the loop is normally
 * non-focusable so robotjs keystrokes hit the foreground app, the user
 * here is interacting with our UI, not the target.
 */
export function ChoicePrompt({ action, onSubmit }: Props) {
  const [freeform, setFreeform] = useState('');
  // Focus trap so Tab cycles among the option buttons + freeform
  // input rather than escaping into the chat surface behind. The
  // hook also restores the previously-focused element when this
  // gate unmounts.
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  return (
    <div
      ref={containerRef}
      className="choice-prompt"
      role="dialog"
      aria-modal="true"
      aria-label={action.question}
    >
      <div className="choice-prompt__options">
        {action.options.map((opt, i) => (
          <button
            key={`${i}-${opt.value}`}
            type="button"
            className="choice-prompt__option"
            onClick={() => onSubmit(opt.value)}
            title={opt.description}
          >
            <span className="choice-prompt__option-label">{opt.label}</span>
            {opt.description && (
              <span className="choice-prompt__option-desc">{opt.description}</span>
            )}
          </button>
        ))}
      </div>
      {action.allowFreeform && (
        <form
          className="choice-prompt__freeform"
          onSubmit={(e) => {
            e.preventDefault();
            const text = freeform.trim();
            if (!text) return;
            onSubmit(text);
          }}
        >
          <input
            type="text"
            className="choice-prompt__freeform-input"
            placeholder="Or type your own answer…"
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn--small btn--primary"
            disabled={!freeform.trim()}
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}
