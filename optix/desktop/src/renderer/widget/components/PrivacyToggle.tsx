import { memo } from 'react';

type Props = {
  paused: boolean;
  onToggle: () => void;
};

function PrivacyToggleImpl({ paused, onToggle }: Props) {
  return (
    <button
      type="button"
      className={`privacy-toggle${paused ? ' privacy-toggle--paused' : ''}`}
      onClick={onToggle}
      aria-pressed={paused}
      title={paused ? 'Screen access paused. Click to resume.' : 'Screen access active. Click to pause.'}
    >
      <span className="privacy-toggle__indicator" aria-hidden="true" />
      {paused ? 'Screen paused' : 'Screen active'}
    </button>
  );
}

export const PrivacyToggle = memo(PrivacyToggleImpl);
