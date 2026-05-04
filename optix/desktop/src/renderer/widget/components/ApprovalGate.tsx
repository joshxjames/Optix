import { useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

type Props = {
  prompt: string;
  onApprove: () => void;
  onCancel: () => void;
};

export function ApprovalGate({ prompt, onApprove, onCancel }: Props) {
  // Trap Tab/Shift+Tab inside the gate so focus can't escape into the
  // chat surface behind it while the user is deciding. Also stashes /
  // restores the previously-focused element across mount.
  const containerRef = useRef<HTMLElement>(null);
  useFocusTrap(containerRef);
  return (
    <article
      ref={containerRef}
      className="response approval"
      role="dialog"
      aria-modal="true"
      aria-label="Permission required"
    >
      <header className="response__header">
        <span className="response__intent">⚠ Permission required</span>
      </header>
      <div className="response__scroll">
        <p className="approval__quote">{`"${prompt}"`}</p>
        <p className="approval__hint">
          You can cancel the agent at any time with the Cancel button.
        </p>
        <div className="approval__buttons">
          <button type="button" className="btn btn--small btn--primary" onClick={onApprove}>
            Approve & run
          </button>
          <button type="button" className="btn btn--small" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </article>
  );
}
