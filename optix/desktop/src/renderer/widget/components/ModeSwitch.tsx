import { memo } from 'react';
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
  return (
    <div className="mode-switch" role="tablist" aria-label="Mode">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="tab"
          aria-selected={mode === m.id}
          title={m.hint}
          className={`mode-switch__btn${mode === m.id ? ' mode-switch__btn--active' : ''}`}
          onClick={() => onChange(m.id)}
          disabled={disabled}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export const ModeSwitch = memo(ModeSwitchImpl);
