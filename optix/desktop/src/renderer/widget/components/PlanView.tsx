import { memo } from 'react';
import type { StoredPlan } from '../../../shared/schemas';

type Props = {
  plan: StoredPlan;
  onClose: () => void;
  onClear: () => void;
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

function PlanViewImpl({ plan, onClose, onClear }: Props) {
  const wasUpdated = plan.updatedAt !== plan.createdAt;
  return (
    <div className="plan-view">
      <header className="plan-view__header">
        <button type="button" className="btn btn--small" onClick={onClose}>
          ← Back
        </button>
        <span className="plan-view__title">Active plan</span>
        <button
          type="button"
          className="btn btn--small btn--destructive"
          onClick={onClear}
          title="Discard the current plan"
        >
          Clear
        </button>
      </header>

      <div className="plan-view__body">
        <div className="plan-view__meta">
          <span title={`Created ${plan.createdAt}`}>
            Created {formatTimestamp(plan.createdAt)}
          </span>
          {wasUpdated && (
            <span title={`Last updated ${plan.updatedAt}`}>
              · Updated {formatTimestamp(plan.updatedAt)}
            </span>
          )}
        </div>
        {plan.rationale && (
          <div className="plan-view__rationale">
            <em>Note: {plan.rationale}</em>
          </div>
        )}
        <pre className="plan-view__content">{plan.content}</pre>
      </div>
    </div>
  );
}

export const PlanView = memo(PlanViewImpl);
