import { memo } from 'react';
import { HelpIcon } from './Icons';

type Props = {
  providerLabel: string;
  /** Model id to show after the provider label, e.g. "Optix Cloud · claude-opus-4-7".
   *  Omit to render just the provider label — used by Optix Cloud where the model
   *  is an internal detail (always Opus 4.7) and showing it would just clutter
   *  the header with a string the user didn't pick. */
  modelLabel?: string;
  onDocs: () => void;
  onSettings: () => void;
  onHide: () => void;
  onToggleCompact: () => void;
  isCompact: boolean;
};

function WidgetHeaderImpl({
  providerLabel,
  modelLabel,
  onDocs,
  onSettings,
  onToggleCompact,
  onHide,
  isCompact,
}: Props) {
  return (
    <div className="widget__header">
      <div className="widget__brand">
        <span className="widget__dot" aria-hidden="true" />
        <strong>Optix</strong>
        <span className="widget__model">
          {modelLabel ? `${providerLabel} · ${modelLabel}` : providerLabel}
        </span>
      </div>
      <div className="widget__header-actions">
        {!isCompact && (
          <>
            {/* Docs sits left of Settings — `<HelpIcon />` is the
                universal question-mark-in-circle glyph. */}
            <button
              type="button"
              className="btn btn--icon"
              onClick={onDocs}
              aria-label="Open documentation"
              title="Documentation"
            >
              <HelpIcon />
            </button>
            <button
              type="button"
              className="btn btn--icon"
              onClick={onSettings}
              aria-label="Open settings"
              title="Settings"
            >
              ⚙
            </button>
          </>
        )}
        <button
          type="button"
          className="btn btn--icon"
          onClick={onToggleCompact}
          aria-label={isCompact ? 'Expand widget' : 'Compact widget'}
          title={isCompact ? 'Expand' : 'Compact'}
        >
          {isCompact ? '▴' : '–'}
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={onHide}
          aria-label="Hide widget"
          title="Hide"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export const WidgetHeader = memo(WidgetHeaderImpl);
