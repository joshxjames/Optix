import { useEffect, useState } from 'react';
import type { Conversation } from '../../../shared/schemas';
import type { ConversationSummary } from '../../../shared/api';
import { PROVIDER_LABELS } from '../../../shared/models';
import {
  CameraIcon,
  ClockIcon,
  DisplayIcon,
  MessageIcon,
  PaperclipIcon,
  ProviderIcon,
  TurnsIcon,
} from './Icons';
import { formatTimeRange } from './AuditLogViewer';
import { costForTurn } from '../../../shared/pricing';

type Props = {
  onClose: () => void;
};

type View =
  | { kind: 'loading' }
  | { kind: 'list' }
  | { kind: 'detail'; conv: Conversation }
  | { kind: 'error'; message: string };

function formatTime(iso: string | undefined): string {
  if (!iso) return '?';
  return new Date(iso).toLocaleString();
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

/**
 * Renders one persisted attachment as an inline thumbnail. We fetch the
 * bytes lazily on mount via IPC and stash them in an object URL so the
 * <img> tag can display the binary. Object URLs are revoked on unmount
 * to avoid leaking memory across many opens.
 */
function AttachmentThumb({
  convId,
  relPath,
  filename,
}: {
  convId: string;
  relPath: string;
  filename?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    void window.optix.chatHistory.readAttachment(convId, relPath).then((res) => {
      if (revoked || !res) return;
      // BlobPart wants `Uint8Array<ArrayBuffer>` (ArrayBuffer-backed). Our
      // bytes come from main's `readFile` → `Buffer` → IPC, which always
      // produces ArrayBuffer-backed views at runtime. Safe to cast.
      url = URL.createObjectURL(
        new Blob([res.bytes as Uint8Array<ArrayBuffer>], { type: res.mimeType }),
      );
      setSrc(url);
    });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [convId, relPath]);
  return (
    <div className="chat-history__thumb" title={filename ?? relPath}>
      {src ? <img src={src} alt={filename ?? relPath} /> : <span>…</span>}
    </div>
  );
}

export function ChatHistoryViewer({ onClose }: Props) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [summaries, setSummaries] = useState<ConversationSummary[]>([]);

  const refresh = async () => {
    setView({ kind: 'loading' });
    try {
      const items = await window.optix.chatHistory.list();
      setSummaries(items);
      setView({ kind: 'list' });
    } catch (err) {
      setView({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  async function openDetail(id: string): Promise<void> {
    setView({ kind: 'loading' });
    try {
      const conv = await window.optix.chatHistory.read(id);
      if (!conv) {
        setView({ kind: 'error', message: 'Conversation not found.' });
        return;
      }
      setView({ kind: 'detail', conv });
    } catch (err) {
      setView({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function deleteConv(id: string): Promise<void> {
    // Single confirm — chat history is meant to be expendable.
    if (!window.confirm('Delete this conversation and all its attachments?')) return;
    await window.optix.chatHistory.delete(id);
    // Navigate back to the list (refreshing it) — the conversation
    // they were viewing no longer exists, so the detail view is stale.
    void refresh();
  }

  // ← Back is context-aware: in the detail view it pops back to the
  // list (one level up inside this viewer); in the list view it calls
  // `onClose` to return to Settings. Mirrors the audit log viewer.
  const goBack = (): void => {
    if (view.kind === 'detail') {
      setView({ kind: 'list' });
    } else {
      onClose();
    }
  };

  // Modal hygiene: Escape mirrors the back arrow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') goBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, onClose]);

  return (
    <div className="audit chat-history">
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
          {view.kind === 'detail' ? 'Ask Log Details' : 'Ask Logs'}
        </span>
        {view.kind === 'detail' && (
          // Delete the currently-viewed conversation. Replaces the
          // per-row trash icon in the list — keeps the list rows
          // visually identical to the audit viewer. Styled neutrally
          // (monochrome) to match the rest of the header chrome —
          // hover gets a subtle red tint as the only colour cue.
          <button
            type="button"
            className="btn btn--small btn--destructive"
            onClick={() => void deleteConv(view.conv.id)}
          >
            Delete
          </button>
        )}
      </header>

      {view.kind === 'loading' && <div className="audit__empty">Loading…</div>}

      {view.kind === 'error' && (
        <div className="audit__empty audit__empty--error">{view.message}</div>
      )}

      {view.kind === 'list' && (
        <div className="audit__body">
          {summaries.length === 0 ? (
            <div className="audit__empty">
              No saved conversations yet. Toggle “Conversation” in Settings and
              send a prompt — each turn will be saved automatically.
            </div>
          ) : (
            <ul className="audit__list">
              {summaries.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="audit__list-item"
                    onClick={() => void openDetail(s.id)}
                  >
                    {/* Top row: provider badge (left) + time (right) —
                        mirrors the audit list-item's status-badge + time
                        pattern so both viewers read the same. */}
                    <div className="audit__list-row">
                      <span className="audit__badge audit__badge--muted">
                        {PROVIDER_LABELS[s.providerId]}
                      </span>
                      <span className="audit__list-time">
                        {relativeTime(s.startedAt)}
                      </span>
                    </div>
                    <div className="audit__list-prompt">
                      {s.title ?? '(untitled conversation)'}
                    </div>
                    <div className="audit__list-meta">
                      <span title={`${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`}>
                        <TurnsIcon /> {s.turnCount}
                      </span>
                      {s.screenshotCount > 0 && (
                        <span
                          title={`${s.screenshotCount} screenshot${s.screenshotCount === 1 ? '' : 's'}`}
                        >
                          <CameraIcon /> {s.screenshotCount}
                        </span>
                      )}
                      {s.estimatedCostUsd !== undefined && (
                        <span title="Estimated API cost (USD)">
                          ≈${s.estimatedCostUsd.toFixed(4)}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.kind === 'detail' && (
        <div className="audit__body chat-history__detail">
          {(() => {
            // Mirror the Access Log Details meta layout exactly. Ask
            // logs have no outcome badge (each turn succeeds/errors
            // individually rather than the whole run), so the top row
            // carries just the provider badge + time range. Stats row
            // counts user messages (== turns in Ask), screenshots
            // (turns with capture), screenshot resolution, any user-
            // attached uploads, and the summed token cost.
            const turns = view.conv.turns;
            const captureTurn = turns.find(
              (t) => t.captureWidth !== undefined && t.captureHeight !== undefined,
            );
            const screenshotCount = turns.filter(
              (t) => t.capturePath !== undefined,
            ).length;
            const attachmentCount = turns.reduce(
              (n, t) => n + t.attachments.length,
              0,
            );
            // Sum cost across turns using each turn's recorded
            // provider/model+usage. Falls back to the conversation's
            // top-level model when a turn doesn't record its own
            // (older turns from before per-turn provider tracking).
            const anyUsage = turns.some((t) => t.usage !== undefined);
            const totalCostUsd = anyUsage
              ? turns.reduce((sum, t) => {
                  const usage = t.usage;
                  if (!usage) return sum;
                  const modelId = t.modelId ?? view.conv.modelId;
                  return sum + costForTurn(modelId, usage);
                }, 0)
              : undefined;
            return (
              <section className="audit__detail-meta">
                <div className="audit__detail-row">
                  {/* Badge sits directly inside the row (no wrapper)
                      so its inline-block height matches the Access
                      detail's badge exactly — wrapping it in another
                      span made the row inherit the body's line-height
                      and the badge floated slightly off-center. */}
                  <span
                    className="audit__badge audit__badge--muted"
                    title={`${PROVIDER_LABELS[view.conv.providerId]} / ${view.conv.modelId}`}
                  >
                    {PROVIDER_LABELS[view.conv.providerId]}
                  </span>
                  <span
                    className="audit__list-time audit__detail-time"
                    title={`Started ${view.conv.startedAt}${view.conv.endedAt ? ` · Ended ${view.conv.endedAt}` : ''}`}
                  >
                    <ClockIcon />
                    {formatTimeRange(view.conv.startedAt, view.conv.endedAt)}
                  </span>
                </div>
                <div className="audit__detail-stats">
                  <span
                    title={`${turns.length} user message${turns.length === 1 ? '' : 's'}`}
                  >
                    <MessageIcon /> {turns.length}
                  </span>
                  <span title={`${turns.length} turn${turns.length === 1 ? '' : 's'}`}>
                    <TurnsIcon /> {turns.length}
                  </span>
                  <span
                    title={`${screenshotCount} screenshot${screenshotCount === 1 ? '' : 's'}`}
                  >
                    <CameraIcon /> {screenshotCount}
                  </span>
                  <span
                    title={`${PROVIDER_LABELS[view.conv.providerId]} / ${view.conv.modelId}`}
                  >
                    <ProviderIcon /> {view.conv.modelId}
                  </span>
                  {captureTurn && (
                    <span title="Screenshot resolution">
                      <DisplayIcon /> {captureTurn.captureWidth}×
                      {captureTurn.captureHeight}
                    </span>
                  )}
                  {attachmentCount > 0 && (
                    <span
                      title={`${attachmentCount} user attachment${attachmentCount === 1 ? '' : 's'}`}
                    >
                      <PaperclipIcon /> {attachmentCount}
                    </span>
                  )}
                  {totalCostUsd !== undefined && (
                    <span title="Estimated API cost (USD)">
                      ≈${totalCostUsd.toFixed(4)}
                    </span>
                  )}
                </div>
              </section>
            );
          })()}

          {view.conv.turns.length === 0 ? (
            <div className="audit__empty">No turns recorded.</div>
          ) : (
            <div className="chat-history__turns">
              {view.conv.turns.map((t) => (
                <article key={t.id} className="chat-history__turn">
                  <div className="chat-history__user">
                    <div className="chat-history__bubble" data-mode={t.mode}>
                      <div className="chat-history__prompt">{t.prompt}</div>
                      {t.attachments.length > 0 && (
                        <div className="chat-history__thumbs">
                          {t.attachments.map((a, i) => (
                            <AttachmentThumb
                              key={i}
                              convId={view.conv.id}
                              relPath={a.path}
                              filename={a.filename}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="chat-history__agent">
                    {t.errorMessage && (
                      <div className="widget__error">{t.errorMessage}</div>
                    )}
                    {t.response && (
                      <>
                        <p className="chat-history__answer">{t.response.answer}</p>
                        {t.response.steps.length > 0 && (
                          <ol className="chat-history__steps">
                            {t.response.steps.map((s) => (
                              <li key={s.order}>{s.text}</li>
                            ))}
                          </ol>
                        )}
                      </>
                    )}
                    {t.finalText && !t.response && (
                      <p className="chat-history__answer">{t.finalText}</p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
