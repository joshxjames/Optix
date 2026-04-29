import type { RoutineSummary } from '../../../shared/schemas';

type Props = {
  /** Filtered list provided by the parent so Enter-to-select can be
   *  handled at the textarea level without a round-trip. */
  items: RoutineSummary[];
  selectedIndex: number;
  onIndexChange: (n: number) => void;
  /** Click handler — receives the picked routine summary. Parent
   *  inserts the corresponding `/OA-{n}` token into the prompt. */
  onPick: (summary: RoutineSummary) => void;
  /** True while the parent is still fetching the routines list. */
  loading?: boolean;
  /** Whole list size (pre-filter) — used to pick the right empty
   *  state ("no routines" vs "no match"). */
  totalCount: number;
  query: string;
};

/**
 * Filter-as-you-type popover anchored above the prompt input. The
 * parent (App.tsx) owns the routine fetch + filtering + keyboard
 * navigation; this component is just rendering.
 */
export function SlashMenu({
  items,
  selectedIndex,
  onIndexChange,
  onPick,
  loading,
  totalCount,
  query,
}: Props) {
  if (loading) {
    return (
      <div className="slash-menu" role="listbox" aria-label="Routines">
        <div className="slash-menu__empty">Loading routines…</div>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="slash-menu" role="listbox" aria-label="Routines">
        <div className="slash-menu__empty">
          {totalCount === 0
            ? 'No saved routines. Record a run to create one.'
            : `No routine matches "${query}".`}
        </div>
      </div>
    );
  }
  return (
    <div className="slash-menu" role="listbox" aria-label="Routines">
      {items.map((s, i) => (
        <button
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          key={s.id}
          className={`slash-menu__item${i === selectedIndex ? ' slash-menu__item--selected' : ''}`}
          onMouseEnter={() => onIndexChange(i)}
          onClick={() => onPick(s)}
        >
          <span className="slash-menu__item-name">{s.name}</span>
          <span className="slash-menu__item-meta">
            {typeof s.oaNumber === 'number' && (
              <span className="slash-menu__item-oa">OA-{s.oaNumber}</span>
            )}
            <span>
              {s.actionCount} step{s.actionCount === 1 ? '' : 's'}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
