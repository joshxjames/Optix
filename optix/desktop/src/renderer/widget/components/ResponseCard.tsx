import { useState } from 'react';
import type { ModelResponse, ProposedAction } from '../../../shared/schemas';
import type { SearchSource } from '../../../shared/api';
import type { TimingBreakdown } from '../App';

type Props = {
  response: ModelResponse;
  timings?: TimingBreakdown;
  /** Kept for backwards compat — the visual badge has been removed from the
   *  card; downstream callers may still pass it, but we ignore it here. */
  usedWebSearch?: boolean;
  /** Distinct URLs the model consulted — rendered as overlapping favicon chips. */
  sources?: SearchSource[];
  /** Pixel dimensions of the screenshot the model annotated against. Needed
   *  for translating proposed-action coordinates to display space when
   *  executing. */
  imageWidth?: number;
  imageHeight?: number;
};

type ActionRunState =
  | { kind: 'pending' }
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'failed'; error: string }
  | { kind: 'skipped' };

const ACTION_ICON: Record<ProposedAction['kind'], string> = {
  click: '🖱',
  type: '⌨',
  scroll: '↕',
  openUrl: '🔗',
};

/** DuckDuckGo's free favicon service — `/ip3/<host>.ico` returns 16×16 PNG. */
function faviconUrl(pageUrl: string): string {
  try {
    const host = new URL(pageUrl).hostname;
    return `https://icons.duckduckgo.com/ip3/${host}.ico`;
  } catch {
    return '';
  }
}

function hostnameOf(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    return pageUrl;
  }
}

export function ResponseCard({ response, sources, imageWidth, imageHeight }: Props) {
  const confidencePct = Math.round(response.confidence * 100);
  // Per-action run state — keyed by index. Resets each time ResponseCard
  // mounts (i.e. each new "done" response). When a new query starts, the
  // card unmounts and any in-flight state is discarded.
  const [actionStates, setActionStates] = useState<ActionRunState[]>(() =>
    response.proposedActions.map(() => ({ kind: 'pending' as const })),
  );

  async function runAction(index: number): Promise<void> {
    const action = response.proposedActions[index];
    if (!action) return;
    // Guard against double-click / double-invocation: if this row is
    // already running, ignore the second call rather than firing the
    // IPC twice and clobbering the state machine.
    if (actionStates[index]?.kind === 'running') return;
    setActionStates((prev) =>
      prev.map((s, i) => (i === index ? { kind: 'running' } : s)),
    );
    const result = await window.optix.action.execute({
      action,
      imageWidth,
      imageHeight,
    });
    setActionStates((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        return result.ok
          ? { kind: 'done' }
          : { kind: 'failed', error: result.error };
      }),
    );
  }

  function skipAction(index: number): void {
    setActionStates((prev) =>
      prev.map((s, i) => (i === index ? { kind: 'skipped' } : s)),
    );
  }

  async function runAllRemaining(): Promise<void> {
    for (let i = 0; i < response.proposedActions.length; i++) {
      const s = actionStates[i];
      if (s && s.kind !== 'pending') continue;
      // Re-read state *after* each action — if a previous action failed we
      // halt the chain rather than blindly continuing on a broken UI state.
      // eslint-disable-next-line no-await-in-loop
      await runAction(i);
    }
  }

  const remainingPending = actionStates.filter((s) => s.kind === 'pending').length;

  return (
    <>
      <article className="response">
        <header className="response__header">
          <span className="response__intent">{response.intent}</span>
          <span className="response__confidence" title={`Model confidence: ${confidencePct}%`}>
            {confidencePct}%
          </span>
        </header>

        {/* Scrollable region inside the card. Card outer dimensions stay
            constant; only this inner area shrinks by 6px when the
            scrollbar appears, so the card never visually shifts. */}
        <div className="response__scroll">
          <p className="response__answer">{response.answer}</p>

          {response.warnings.length > 0 && (
            <ul className="response__warnings">
              {response.warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}

          {response.steps.length > 0 && (
            <ol className="response__steps">
              {response.steps.map((s) => (
                <li key={s.order}>
                  <span className="response__step-text">{s.text}</span>
                </li>
              ))}
            </ol>
          )}

          {response.proposedActions.length > 0 && (
            <div className="response__actions">
              <div className="response__actions-header">
                <strong>Proposed actions</strong>
                {remainingPending > 1 && (
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={runAllRemaining}
                    title={`Approve and run all ${remainingPending} remaining actions in sequence`}
                  >
                    Run all ({remainingPending})
                  </button>
                )}
              </div>
              <ul className="response__action-list">
                {response.proposedActions.map((a, i) => {
                  const state = actionStates[i] ?? { kind: 'pending' as const };
                  return (
                    <li key={i} className={`response__action response__action--${state.kind}`}>
                      <div className="response__action-row">
                        <span className="response__action-icon" aria-hidden="true">
                          {ACTION_ICON[a.kind]}
                        </span>
                        <span className="response__action-kind">{a.kind}</span>
                        <span className="response__action-desc">{a.description}</span>
                      </div>
                      {state.kind === 'pending' && (
                        <div className="response__action-controls">
                          <button
                            type="button"
                            className="btn btn--small btn--primary"
                            onClick={() => void runAction(i)}
                          >
                            Run
                          </button>
                          <button
                            type="button"
                            className="btn btn--small"
                            onClick={() => skipAction(i)}
                          >
                            Skip
                          </button>
                        </div>
                      )}
                      {state.kind === 'running' && (
                        <div className="response__action-status">Running…</div>
                      )}
                      {state.kind === 'done' && (
                        <div className="response__action-status response__action-status--ok">✓ Done</div>
                      )}
                      {state.kind === 'failed' && (
                        <div className="response__action-status response__action-status--error">
                          ✗ {state.error}
                        </div>
                      )}
                      {state.kind === 'skipped' && (
                        <div className="response__action-status response__action-status--muted">Skipped</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </article>

      {/* Source favicons — clickable, slightly overlapping circles showing
          the websites the model consulted. Renders only when at least one
          source was returned. */}
      {sources && sources.length > 0 && (
        <div className="response__sources" aria-label="Sources">
          {sources.map((s, i) => {
            const host = hostnameOf(s.url);
            const fav = faviconUrl(s.url);
            return (
              <a
                key={`${s.url}-${i}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="response__source-chip"
                title={s.title ? `${s.title} — ${host}` : host}
                style={{ zIndex: sources.length - i }}
              >
                {fav ? (
                  <img src={fav} alt="" width={14} height={14} loading="lazy" />
                ) : (
                  <span className="response__source-chip-fallback">{host[0]?.toUpperCase() ?? '?'}</span>
                )}
              </a>
            );
          })}
        </div>
      )}

      {/* Timing breakdown intentionally hidden from the conversation
          view — it's still emitted in main-process console logs for
          diagnostics; the user-facing surface stays focused on the
          answer. (`timings` prop kept on the type for compatibility.) */}
    </>
  );
}
