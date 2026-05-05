import { memo } from 'react';

type Props = {
  paused: boolean;
  onToggle: () => void;
};

function PrivacyToggleImpl({ paused, onToggle }: Props) {
  // role="switch" + aria-checked is the correct pattern for an on/off
  // toggle. aria-pressed is for "button is currently engaged" (toolbar
  // toggle) and doesn't convey the same on/off semantics to AT.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={paused ? 'true' : 'false'}
      aria-label={paused ? 'Screen access paused' : 'Screen access active'}
      className={`privacy-toggle${paused ? ' privacy-toggle--paused' : ''}`}
      onClick={onToggle}
      title={paused ? 'Screen access paused. Click to resume.' : 'Screen access active. Click to pause.'}
    >
      <span className="privacy-toggle__indicator" aria-hidden="true" />
      {paused ? 'Screen paused' : 'Screen active'}
    </button>
  );
}

export const PrivacyToggle = memo(PrivacyToggleImpl);
