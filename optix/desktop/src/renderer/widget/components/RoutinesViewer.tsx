import { useEffect, useState } from 'react';
import type { RecordedAction, Routine, RoutineSummary } from '../../../shared/schemas';
import { PROVIDER_LABELS } from '../../../shared/models';
import type { ProviderId } from '../../../shared/schemas';
import {
  ActionsIcon,
  ClockIcon,
  DisplayIcon,
  MessageIcon,
  ProviderIcon,
  TurnsIcon,
} from './Icons';
import { formatTimeRange } from './AuditLogViewer';
import { useEscapeKey } from '../hooks/useEscapeKey';

type Props = {
  onClose: () => void;
  /** Optional callback for "Run this routine now". When provided, the
   *  detail view shows a Run button that hands the routine back to
   *  the parent — typically App.tsx wiring it through replay. */
  onRun?: (routine: Routine) => void;
};

type View =
  | { kind: 'loading' }
  | { kind: 'list' }
  | { kind: 'detail'; routine: Routine; dirty: boolean }
  | { kind: 'error'; message: string };

/** Translate a UIA control-type string ("ControlType.Edit") into a
 *  human label ("text field"). Used only in the routine detail
 *  view's action list — the replay prompt sent to the agent keeps
 *  the raw form so the model has the precise technical metadata.
 *  Unknown types fall back to the prefix-stripped lowercased name
 *  ("ControlType.Foo" → "foo") rather than dumping the noisy
 *  namespace into the UI. */
function humanizeControlType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/^ControlType\./, '');
  const known: Record<string, string> = {
    Edit: 'text field',
    Button: 'button',
    SplitButton: 'split button',
    CheckBox: 'checkbox',
    RadioButton: 'radio button',
    ComboBox: 'dropdown',
    List: 'list',
    ListItem: 'list item',
    Tree: 'tree',
    TreeItem: 'tree item',
    Tab: 'tabs',
    TabItem: 'tab',
    Menu: 'menu',
    MenuBar: 'menu bar',
    MenuItem: 'menu item',
    Hyperlink: 'link',
    Image: 'image',
    Text: 'text',
    Document: 'document',
    Pane: 'pane',
    Window: 'window',
    Group: 'group',
    ToolBar: 'toolbar',
    StatusBar: 'status bar',
    ToolTip: 'tooltip',
    Slider: 'slider',
    ProgressBar: 'progress bar',
    ScrollBar: 'scroll bar',
    SpinnerControl: 'spinner',
    DataGrid: 'table',
    DataItem: 'row',
    Table: 'table',
    Header: 'header',
    HeaderItem: 'column header',
    TitleBar: 'title bar',
    Calendar: 'calendar',
    Separator: 'separator',
    Thumb: 'handle',
    Custom: 'custom element',
  };
  return known[stripped] ?? stripped.toLowerCase();
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

export function RoutinesViewer({ onClose, onRun }: Props) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [summaries, setSummaries] = useState<RoutineSummary[]>([]);

  // The `refresh` closure used inside the mount effect captures a
  // local `cancelled` flag so any in-flight `routines.list()` IPC
  // can no-op if the component is gone by the time it resolves.
  // External callers (e.g. post-edit save flows could call refresh)
  // hit the same function but its setState calls land harmlessly
  // because they only run while still mounted by construction.
  const refresh = async (): Promise<void> => {
    try {
      const items = await window.optix.routines.list();
      setSummaries(items);
      setView({ kind: 'list' });
    } catch (err) {
      setView({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Mount effect: initial fetch + subscribe to the routines-changed
  // broadcast. The `cancelled` guard protects both paths from a
  // mid-fetch close.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const items = await window.optix.routines.list();
        if (cancelled) return;
        setSummaries(items);
        setView({ kind: 'list' });
      } catch (err) {
        if (cancelled) return;
        setView({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    const unsub = window.optix.routines.onChanged(() => {
      if (cancelled) return;
      void refresh();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const openDetail = async (id: string): Promise<void> => {
    setView({ kind: 'loading' });
    const r = await window.optix.routines.read(id);
    if (!r) {
      setView({ kind: 'error', message: 'Routine not found.' });
      return;
    }
    setView({ kind: 'detail', routine: r, dirty: false });
  };

  const deleteRoutine = async (id: string): Promise<void> => {
    if (!window.confirm("Delete this routine? This can't be undone.")) return;
    await window.optix.routines.delete(id);
    setView({ kind: 'list' });
  };

  // Detail view edit helpers — all mutate the in-memory `routine` and
  // mark the view dirty so we know to persist on Save.
  const updateDetail = (mutate: (r: Routine) => Routine): void => {
    setView((prev) => {
      if (prev.kind !== 'detail') return prev;
      return { kind: 'detail', routine: mutate(prev.routine), dirty: true };
    });
  };

  const moveAction = (from: number, to: number): void => {
    updateDetail((r) => {
      if (to < 0 || to >= r.actions.length) return r;
      const moved = r.actions[from];
      if (!moved) return r;
      const next: RecordedAction[] = [...r.actions];
      next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...r, actions: next };
    });
  };

  const removeAction = (idx: number): void => {
    updateDetail((r) => ({ ...r, actions: r.actions.filter((_, i) => i !== idx) }));
  };

  const saveDetail = async (): Promise<void> => {
    if (view.kind !== 'detail') return;
    const r = view.routine;
    const updated = await window.optix.routines.update({
      id: r.id,
      name: r.name,
      originalPrompt: r.originalPrompt,
      actions: r.actions,
    });
    if (updated) {
      setView({ kind: 'detail', routine: updated, dirty: false });
    }
  };

  const goBack = (): void => {
    if (view.kind === 'detail') {
      if (view.dirty && !window.confirm('Discard unsaved changes?')) return;
      setView({ kind: 'list' });
    } else {
      onClose();
    }
  };

  // Modal hygiene: Escape mirrors the back arrow (and runs the same
  // dirty-check, so the user can't accidentally Esc out of unsaved
  // routine edits). The shared hook holds `goBack` in a ref so the
  // listener is bound once for the component's life.
  useEscapeKey(goBack);

  return (
    <div className="audit routines">
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
          {view.kind === 'detail' ? 'Automation Details' : 'Automations'}
        </span>
        {view.kind === 'detail' && (
          <div className="audit__export">
            {onRun && (
              <button
                type="button"
                className="btn btn--small btn--primary"
                onClick={() => onRun(view.routine)}
                title="Run this routine"
              >
                Run
              </button>
            )}
            <button
              type="button"
              className="btn btn--small"
              onClick={() => void saveDetail()}
              disabled={!view.dirty}
              title="Save edits"
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn--small btn--destructive"
              onClick={() => void deleteRoutine(view.routine.id)}
              title="Delete this routine"
            >
              Delete
            </button>
          </div>
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
              No routines yet. Switch to Automate, toggle the Record
              button, and run a task — it'll be saved here.
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
                    <div className="audit__list-row">
                      {/* OA-{n} stands in the badge slot (the same
                          place Access Logs puts the run outcome) so
                          the unique routine identifier reads as the
                          row's primary label. Muted style mirrors
                          the provider badge styling Access uses on
                          its detail meta card. */}
                      <span
                        className="audit__badge audit__badge--muted"
                        title="Token reference — type /OA-{n} in the Automate prompt"
                      >
                        {typeof s.oaNumber === 'number'
                          ? `ID: OA-${s.oaNumber}`
                          : 'ID: OA-?'}
                      </span>
                      <span className="audit__list-time">
                        {relativeTime(s.updatedAt)}
                      </span>
                    </div>
                    <div className="audit__list-prompt">{s.name}</div>
                    <div className="audit__list-meta">
                      {/* Same icon vocabulary + ordering as the Access
                          Logs list: turns, actions, cost. */}
                      {typeof s.turnCount === 'number' && (
                        <span
                          title={`${s.turnCount} turn${s.turnCount === 1 ? '' : 's'}`}
                        >
                          <TurnsIcon /> {s.turnCount}
                        </span>
                      )}
                      <span
                        title={`${s.actionCount} action${s.actionCount === 1 ? '' : 's'}`}
                      >
                        <ActionsIcon /> {s.actionCount}
                      </span>
                      {typeof s.estimatedCostUsd === 'number' && (
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
        <div className="audit__body routines__detail">
          <section className="audit__detail-meta">
            <div className="audit__detail-row">
              {/* Same row shape as the Access Log Details meta card:
                  badge on the left (OA-{n} here, run outcome there),
                  ClockIcon + time range on the right. */}
              <span
                className="audit__badge audit__badge--muted"
                title="Token reference — type /OA-{n} in the Automate prompt"
              >
                {typeof view.routine.oaNumber === 'number'
                  ? `ID: OA-${view.routine.oaNumber}`
                  : 'ID: OA-?'}
              </span>
              <span
                className="audit__list-time audit__detail-time"
                title={`Created ${view.routine.createdAt}${view.routine.updatedAt !== view.routine.createdAt ? ` · Updated ${view.routine.updatedAt}` : ''}`}
              >
                <ClockIcon />
                {formatTimeRange(view.routine.createdAt, view.routine.updatedAt)}
              </span>
            </div>
            {/* Stats row — same icon vocabulary + ordering as the
                Access Log Details meta card. A routine always
                represents a single user message (the originalPrompt),
                so message count is hardcoded to 1. */}
            <div className="audit__detail-stats">
              <span title="1 user message">
                <MessageIcon /> 1
              </span>
              {typeof view.routine.turnCount === 'number' && (
                <span
                  title={`${view.routine.turnCount} turn${view.routine.turnCount === 1 ? '' : 's'}`}
                >
                  <TurnsIcon /> {view.routine.turnCount}
                </span>
              )}
              <span
                title={`${view.routine.actions.length} action${view.routine.actions.length === 1 ? '' : 's'}`}
              >
                <ActionsIcon /> {view.routine.actions.length}
              </span>
              <span
                title={`${PROVIDER_LABELS[view.routine.providerId as ProviderId] ?? view.routine.providerId} / ${view.routine.modelId}`}
              >
                <ProviderIcon /> {view.routine.modelId}
              </span>
              {view.routine.imageWidth && view.routine.imageHeight && (
                <span title="Screenshot resolution">
                  <DisplayIcon /> {view.routine.imageWidth}×
                  {view.routine.imageHeight}
                </span>
              )}
              {typeof view.routine.estimatedCostUsd === 'number' && (
                <span title="Estimated API cost (USD)">
                  ≈${view.routine.estimatedCostUsd.toFixed(4)}
                </span>
              )}
            </div>
          </section>

          <label className="routines__field">
            <span className="routines__field-label">Name</span>
            <input
              type="text"
              className="routines__field-input"
              value={view.routine.name}
              onChange={(e) =>
                updateDetail((r) => ({ ...r, name: e.target.value }))
              }
              placeholder="Routine name"
            />
          </label>

          <label className="routines__field">
            <span className="routines__field-label">Original prompt</span>
            <textarea
              className="routines__field-textarea"
              value={view.routine.originalPrompt}
              onChange={(e) =>
                updateDetail((r) => ({ ...r, originalPrompt: e.target.value }))
              }
              rows={3}
              placeholder="The user prompt this routine was recorded against"
            />
          </label>

          <div className="routines__actions-header">
            <span className="routines__field-label">
              Actions ({view.routine.actions.length})
            </span>
            <span className="routines__hint">
              Reorder with ↑/↓, delete with ✕
            </span>
          </div>
          {view.routine.actions.length === 0 ? (
            <div className="audit__empty">
              No actions remaining — saving will leave an empty routine.
            </div>
          ) : (
            <ol className="routines__action-list">
              {view.routine.actions.map((a, i) => (
                <li key={i} className="routines__action">
                  <span className="routines__action-index">{i + 1}.</span>
                  <span className="routines__action-body">
                    <span className="routines__action-desc" title={a.description}>
                      {a.description}
                    </span>
                    {(a.targetElementName || a.windowTitle) && (
                      <span className="routines__action-context">
                        {a.targetElementName && (
                          <span
                            title={`UIA element captured at record time${
                              a.targetElementType
                                ? ` — raw type: ${a.targetElementType}`
                                : ''
                            }`}
                          >
                            target: <strong>{a.targetElementName}</strong>
                            {humanizeControlType(a.targetElementType)
                              ? ` (${humanizeControlType(a.targetElementType)})`
                              : ''}
                          </span>
                        )}
                        {a.windowTitle && (
                          <span title="Foreground window at record time">
                            window: <strong>{a.windowTitle}</strong>
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="routines__action-controls">
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => moveAction(i, i - 1)}
                      disabled={i === 0}
                      title="Move up"
                      aria-label="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => moveAction(i, i + 1)}
                      disabled={i === view.routine.actions.length - 1}
                      title="Move down"
                      aria-label="Move down"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn btn--small btn--destructive"
                      onClick={() => removeAction(i)}
                      title="Delete this action"
                      aria-label="Delete action"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
