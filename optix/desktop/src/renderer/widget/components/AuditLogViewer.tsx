import { useEffect, useState } from 'react';
import type { AuditLog, AuditLogSummary } from '../../../shared/api';
import { ACTION_ICON } from './ComputerLoopProgress';
import {
  ActionsIcon,
  ClockIcon,
  DisplayIcon,
  MessageIcon,
  ProviderIcon,
  TurnsIcon,
} from './Icons';

type Props = {
  onClose: () => void;
};

type View =
  | { kind: 'list' }
  | { kind: 'detail'; log: AuditLog }
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

function formatTime(iso: string | undefined): string {
  if (!iso) return '?';
  return new Date(iso).toLocaleString();
}

/** Compact time-range string for the detail meta header. Same-day
 *  ranges collapse to `HH:MM → HH:MM`; cross-day ranges include the
 *  date prefix (`MMM d HH:MM → MMM d HH:MM`). Returns just the start
 *  time when no end is given. The full ISO timestamps go in the
 *  caller's `title` tooltip for cases where someone needs precision. */
export function formatTimeRange(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  const startTime = start.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (!endIso) return startTime;
  const end = new Date(endIso);
  const endTime = end.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (start.toDateString() === end.toDateString()) {
    return `${startTime} → ${endTime}`;
  }
  // Cross-day: prefix each side with a short date so the user can tell
  // the range spanned a midnight (rare but possible for long Access
  // sessions or restored conversations).
  const dateOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${start.toLocaleDateString([], dateOpts)} ${startTime} → ${end.toLocaleDateString([], dateOpts)} ${endTime}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

function outcomeBadge(outcome: string | undefined): { label: string; className: string } {
  switch (outcome) {
    case 'done': return { label: '✓ done', className: 'audit__badge audit__badge--ok' };
    case 'aborted': return { label: '✗ stopped', className: 'audit__badge audit__badge--error' };
    case 'capped': return { label: '⊘ capped', className: 'audit__badge audit__badge--warn' };
    case 'error': return { label: '! error', className: 'audit__badge audit__badge--error' };
    case 'abandoned': return { label: '◌ abandoned', className: 'audit__badge audit__badge--muted' };
    default: return { label: '? unknown', className: 'audit__badge audit__badge--muted' };
  }
}

export function AuditLogViewer({ onClose }: Props) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [summaries, setSummaries] = useState<AuditLogSummary[]>([]);

  useEffect(() => {
    void window.optix.audit
      .list()
      .then((items) => {
        setSummaries(items);
        setView({ kind: 'list' });
      })
      .catch((err) =>
        setView({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  async function openDetail(filename: string): Promise<void> {
    setView({ kind: 'loading' });
    try {
      const log = await window.optix.audit.read(filename);
      if (!log) {
        setView({ kind: 'error', message: 'Log not found.' });
        return;
      }
      setView({ kind: 'detail', log });
    } catch (err) {
      setView({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function exportLog(
    filename: string,
    format: 'json' | 'markdown' | 'text',
  ): Promise<void> {
    const result = await window.optix.audit.export(filename, format);
    // Cancel = silent return. Errors get a console warning so the user isn't
    // blocked by a modal if something fails — they can retry.
    if (!result.ok && result.error) {
      console.warn('[optix-audit] export failed:', result.error);
    }
  }

  async function deleteLog(filename: string): Promise<void> {
    if (!window.confirm("Delete this audit log? This can't be undone.")) return;
    const ok = await window.optix.audit.delete(filename);
    if (!ok) {
      console.warn('[optix-audit] delete failed for', filename);
      return;
    }
    // Drop the deleted item from the cached list and pop back to it.
    setSummaries((prev) => prev.filter((s) => s.filename !== filename));
    setView({ kind: 'list' });
  }

  // ← Back is context-aware: in the detail view it pops back to the
  // list (one level up inside this viewer); in the list view it calls
  // `onClose` to return to Settings. Avoids needing a separate "All
  // runs" button — the header back arrow always means "up one screen".
  const goBack = (): void => {
    if (view.kind === 'detail') {
      setView({ kind: 'list' });
    } else {
      onClose();
    }
  };

  // Modal hygiene: Escape mirrors the back arrow (detail → list →
  // close). Re-bound on view change so the captured `view` is current.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') goBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, onClose]);

  return (
    <div className="audit">
      <header className="audit__header">
        <button
          type="button"
          className="btn btn--small"
          onClick={goBack}
          autoFocus
        >
          ← Back
        </button>
        <span className="audit__title">
          {view.kind === 'detail' ? 'Access Log Details' : 'Access Logs'}
        </span>
        {view.kind === 'detail' && (
          <div className="audit__export">
            <button
              type="button"
              className="btn btn--small"
              title="Export as Markdown"
              onClick={() => void exportLog(filenameOf(view.log), 'markdown')}
            >
              .md
            </button>
            <button
              type="button"
              className="btn btn--small"
              title="Export as plain text"
              onClick={() => void exportLog(filenameOf(view.log), 'text')}
            >
              .txt
            </button>
            <button
              type="button"
              className="btn btn--small"
              title="Export as JSON"
              onClick={() => void exportLog(filenameOf(view.log), 'json')}
            >
              .json
            </button>
            <button
              type="button"
              className="btn btn--small btn--destructive"
              title="Delete this audit log"
              onClick={() => void deleteLog(filenameOf(view.log))}
            >
              Delete
            </button>
          </div>
        )}
      </header>

      <div className="audit__body">
        {view.kind === 'loading' && <div className="audit__loading">Loading…</div>}
        {view.kind === 'error' && (
          <div className="widget__error">{view.message}</div>
        )}
        {view.kind === 'list' && <AuditList summaries={summaries} onOpen={openDetail} />}
        {view.kind === 'detail' && <AuditDetail log={view.log} />}
      </div>
    </div>
  );
}

/** Reverse the summary→detail mapping. The detail view doesn't carry the
 *  filename, but every summary's filename can be reconstructed from the
 *  startedAt timestamp + loopId prefix — same scheme `audit.ts` uses. */
function filenameOf(log: AuditLog): string {
  const ts = log.startedAt.replace(/[:.]/g, '-');
  return `${ts}-${log.loopId.slice(0, 8)}.json`;
}

function AuditList({
  summaries,
  onOpen,
}: {
  summaries: AuditLogSummary[];
  onOpen: (filename: string) => void;
}) {
  if (summaries.length === 0) {
    return (
      <div className="audit__empty">
        No Access runs yet. Use Access mode to record one.
      </div>
    );
  }
  return (
    <ul className="audit__list">
      {summaries.map((s) => {
        const badge = outcomeBadge(s.outcome);
        return (
          <li key={s.filename}>
            <button
              type="button"
              className="audit__list-item"
              onClick={() => onOpen(s.filename)}
            >
              <div className="audit__list-row">
                <span className={badge.className}>{badge.label}</span>
                <span
                  className="audit__list-time"
                  title={s.startedAt}
                >
                  {relativeTime(s.startedAt)}
                </span>
              </div>
              <div className="audit__list-prompt">{s.prompt}</div>
              <div className="audit__list-meta">
                {/* Same icon vocabulary as the detail view's stats row.
                    `messageCount` only renders when >1 — single-message
                    runs would just have a redundant 1 here. Tooltip on
                    each pill carries the full label. */}
                {s.messageCount > 1 && (
                  <span title={`${s.messageCount} user messages`}>
                    <MessageIcon /> {s.messageCount}
                  </span>
                )}
                <span title={`${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`}>
                  <TurnsIcon /> {s.turnCount}
                </span>
                <span title={`${s.actionCount} action${s.actionCount === 1 ? '' : 's'}`}>
                  <ActionsIcon /> {s.actionCount}
                </span>
                {s.estimatedCostUsd !== undefined && (
                  <span title="Estimated API cost (USD)">
                    ≈${s.estimatedCostUsd.toFixed(4)}
                  </span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AuditDetail({ log }: { log: AuditLog }) {
  // No in-content back button — the header's `← Back` arrow handles
  // returning to the list (it's context-aware inside this viewer).
  const badge = outcomeBadge(log.outcome);
  const totalActions = log.turns.reduce((n, t) => n + t.actions.length, 0);

  // Group turns by their owning user message. Option-A continuity in
  // conversation mode means a single audit can span many user prompts;
  // each `userMessages[i]` records the turn index where that message's
  // response began. Slice turns by those boundaries so each section
  // shows exactly the turns the agent produced for that user message.
  const messages = log.userMessages ?? [
    // Defensive fallback: very old audit JSON without userMessages.
    // `readAuditLog` already synthesises one entry from `log.prompt`,
    // but this handles the case if anyone ever passes a raw object in.
    { index: 0, prompt: log.prompt, startedAt: log.startedAt, firstTurnIndex: 0 },
  ];
  const messageGroups = messages.map((msg, i) => {
    const next = messages[i + 1];
    const endTurnIndex = next ? next.firstTurnIndex : log.turns.length;
    const turns = log.turns.slice(msg.firstTurnIndex, endTurnIndex);
    return { message: msg, turns };
  });

  const timeLabel = formatTimeRange(log.startedAt, log.endedAt);

  return (
    <div className="audit__detail">
      <section className="audit__detail-meta">
        <div className="audit__detail-row">
          <span className={badge.className}>{badge.label}</span>
          <span
            className="audit__list-time audit__detail-time"
            title={`Started ${log.startedAt}${log.endedAt ? ` · Ended ${log.endedAt}` : ''}`}
          >
            <ClockIcon />
            {timeLabel}
          </span>
        </div>
        {log.errorMessage && (
          <p className="audit__detail-error">{log.errorMessage}</p>
        )}
        {/* Stats row — icon + value, full label in tooltip. */}
        <div className="audit__detail-stats">
          <span title={`${messages.length} user message${messages.length === 1 ? '' : 's'}`}>
            <MessageIcon /> {messages.length}
          </span>
          <span title={`${log.turns.length} turn${log.turns.length === 1 ? '' : 's'}`}>
            <TurnsIcon /> {log.turns.length}
          </span>
          <span title={`${totalActions} action${totalActions === 1 ? '' : 's'}`}>
            <ActionsIcon /> {totalActions}
          </span>
          <span title={`${log.providerId} / ${log.modelId}`}>
            <ProviderIcon /> {log.modelId}
          </span>
          {log.imageWidth && log.imageHeight && (
            <span title="Screenshot resolution">
              <DisplayIcon /> {log.imageWidth}×{log.imageHeight}
            </span>
          )}
          {log.estimatedCostUsd !== undefined && (
            <span title="Estimated API cost (USD)">
              ≈${log.estimatedCostUsd.toFixed(4)}
            </span>
          )}
        </div>
      </section>

      {messageGroups.map(({ message, turns }) => (
        <section key={message.index} className="audit__message">
          <header className="audit__message-header">
            <span className="audit__message-label">
              Message {message.index + 1}
            </span>
            <span className="audit__list-time">
              {formatTime(message.startedAt)}
            </span>
          </header>
          <p className="audit__detail-prompt">"{message.prompt}"</p>
          {turns.length === 0 ? (
            <p className="audit__message-empty">
              (No turns yet — the agent hasn&rsquo;t responded to this message.)
            </p>
          ) : (
            turns.map((turn, idxInMsg) => {
              // Only the FINAL turn of the LAST message is the run's
              // wrap-up. Within an earlier message the last turn is just
              // a hand-off, not the conclusion.
              const isLastTurnOfRun =
                message.index === messages.length - 1 &&
                idxInMsg === turns.length - 1;
              return (
                <div key={turn.turnIndex} className="audit__turn">
                  <div className="audit__turn-header">
                    <span className="audit__turn-index">
                      Turn {turn.turnIndex + 1}
                    </span>
                    {/* Compact stats line with hover tooltips so each
                        symbol is self-explanatory without cluttering
                        the row. ↓ = input tokens, ↑ = output tokens,
                        ⤓ = cache write (tokens written into cache),
                        ⤒ = cache read (tokens served from cache). */}
                    <span className="audit__turn-stats">
                      <span title="API round-trip time">{turn.apiMs}ms</span>
                      {turn.inputTokens !== undefined && (
                        <span title="Input tokens">↓{turn.inputTokens}</span>
                      )}
                      {turn.outputTokens !== undefined && (
                        <span title="Output tokens">↑{turn.outputTokens}</span>
                      )}
                      {turn.cacheCreationInputTokens ? (
                        <span title="Cache write tokens">
                          ⤓{turn.cacheCreationInputTokens}
                        </span>
                      ) : null}
                      {turn.cacheReadInputTokens ? (
                        <span title="Cache read tokens">
                          ⤒{turn.cacheReadInputTokens}
                        </span>
                      ) : null}
                      {turn.stopReason && (
                        <span
                          className="audit__mono"
                          title="Stop reason"
                        >
                          {turn.stopReason}
                        </span>
                      )}
                    </span>
                  </div>
                  {turn.modelText && (
                    <p
                      className={
                        isLastTurnOfRun
                          ? 'audit__turn-text audit__turn-text--final'
                          : 'audit__turn-text'
                      }
                    >
                      {turn.modelText}
                    </p>
                  )}
                  <ul className="audit__turn-actions">
                    {turn.actions.map((a) => (
                      <li
                        key={a.toolUseId}
                        className={`audit__action audit__action--${a.ok ? 'ok' : 'fail'}`}
                      >
                        <span className="audit__action-kind-icon" aria-hidden="true">
                          {ACTION_ICON[a.action.data.action] ?? '•'}
                        </span>
                        <span className="audit__action-desc">{a.description}</span>
                        {a.durationMs > 0 && (
                          <span className="audit__action-duration">{a.durationMs}ms</span>
                        )}
                        <span className="audit__action-icon">{a.ok ? '✓' : '✗'}</span>
                        {a.errorText && (
                          <span className="audit__action-error">{a.errorText}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>
      ))}

    </div>
  );
}
