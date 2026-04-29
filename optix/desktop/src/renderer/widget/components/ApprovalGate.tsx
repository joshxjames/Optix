type Props = {
  prompt: string;
  onApprove: () => void;
  onCancel: () => void;
};

export function ApprovalGate({ prompt, onApprove, onCancel }: Props) {
  return (
    <article className="response approval">
      <header className="response__header">
        <span className="response__intent">⚠ Permission required</span>
      </header>
      <div className="response__scroll">
        <p className="approval__quote">"{prompt}"</p>
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
