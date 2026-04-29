import { useState } from 'react';
import type { PlanToolAction } from '../../../shared/schemas';

type Props = {
  action: PlanToolAction;
  /** Resolves with one of:
   *   • approve  → save the plan + tell the agent it's accepted
   *   • deny     → discard the plan + tell the agent it was rejected
   *   • feedback → discard the plan + send the user's text as
   *                 model-readable feedback so the agent can revise */
  onDecide: (
    decision:
      | { kind: 'approve' }
      | { kind: 'deny' }
      | { kind: 'feedback'; text: string },
  ) => void;
};

/**
 * Inline gate rendered when the agent calls the `plan` tool. Shows
 * the proposed plan body (typically a numbered Markdown list, but
 * we render it as pre-formatted text so the agent's whitespace +
 * bullet structure survives) plus three actions: Approve, Deny, or
 * Type feedback so the agent can revise.
 *
 * Visual + control layout mirrors the per-action approval gate so
 * the loop has consistent affordances no matter what the agent is
 * waiting on.
 */
export function PlanApprovalGate({ action, onDecide }: Props) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');

  const submitFeedback = (): void => {
    const text = feedback.trim();
    if (!text) return;
    onDecide({ kind: 'feedback', text });
  };

  return (
    <div className="plan-gate" role="group" aria-label="Plan approval">
      {action.rationale && (
        <div className="plan-gate__rationale" title="Why this plan changed">
          <em>Note: {action.rationale}</em>
        </div>
      )}
      <pre className="plan-gate__body">{action.content}</pre>
      <div className="plan-gate__buttons">
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={() => onDecide({ kind: 'approve' })}
          title="Approve and save this plan"
        >
          Approve
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => onDecide({ kind: 'deny' })}
          title="Reject and let the agent know"
        >
          Deny
        </button>
        <button
          type="button"
          className={`btn btn--small${feedbackOpen ? ' btn--toggled' : ''}`}
          onClick={() => setFeedbackOpen((v) => !v)}
          title="Send a correction so the agent can revise"
        >
          Type feedback
        </button>
      </div>
      {feedbackOpen && (
        <form
          className="plan-gate__feedback"
          onSubmit={(e) => {
            e.preventDefault();
            submitFeedback();
          }}
        >
          <textarea
            className="loop__step-feedback-input"
            placeholder="Tell the agent what to change…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            autoFocus
          />
          <button
            type="submit"
            className="btn btn--small btn--primary"
            disabled={!feedback.trim()}
          >
            Send
          </button>
        </form>
      )}
    </div>
  );
}
