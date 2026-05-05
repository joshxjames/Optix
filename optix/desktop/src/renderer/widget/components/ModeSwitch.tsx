import { memo, useRef, type KeyboardEvent } from 'react';
import type { Mode } from '../../../shared/schemas';

type Props = {
  mode: Mode;
  onChange: (m: Mode) => void;
  disabled: boolean;
};

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'guide', label: 'Ask', hint: 'Describe the screen or walk through a task' },
  { id: 'action', label: 'Access', hint: 'Run an autonomous agent on your computer (file system + screen)' },
  {
    id: 'automate',
    label: 'Automate',
    hint:
      'Record a run as a reusable routine, or replay a saved routine via the slash menu',
  },
];

function ModeSwitchImpl({ mode, onChange, disabled }: Props) {
  // Refs into each button so keyboard nav can move focus without us
  // rendering on tab change. WAI-ARIA tablist guidance: only the active
  // tab is in the document tab order (tabIndex=0); the others get -1
  // and are reached via Left/Right (roving tabindex).
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusAt(idx: number): void {
    const wrapped = (idx + MODES.length) % MODES.length;
    refs.current[wrapped]?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number): void {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        focusAt(idx - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        focusAt(idx + 1);
        break;
      case 'Home':
        e.preventDefault();
        focusAt(0);
        break;
      case 'End':
        e.preventDefault();
        focusAt(MODES.length - 1);
        break;
      case 'Enter':
      case ' ':
        // Default button behaviour activates on Space/Enter, but we
        // pre-empt to avoid a scroll on Space and to keep the activation
        // explicit for the active-tab pattern.
        e.preventDefault();
        onChange(MODES[idx]!.id);
        break;
      default:
        break;
    }
  }

  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {MODES.map((m, i) => {
        const isActive = mode === m.id;
        return (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            // Roving tabindex: only the active tab is in tab order.
            tabIndex={isActive ? 0 : -1}
            title={m.hint}
            className={`mode-switch__btn${isActive ? ' mode-switch__btn--active' : ''}`}
            onClick={() => onChange(m.id)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            disabled={disabled}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}

export const ModeSwitch = memo(ModeSwitchImpl);
