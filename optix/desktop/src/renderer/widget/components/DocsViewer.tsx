import { useMemo, useState } from 'react';
import {
  DOC_ARTICLES,
  DOC_CATEGORIES,
  type DocArticle,
  type DocBlock,
} from './docs/articles';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { SupportForm } from './SupportForm';

type Props = {
  onClose: () => void;
  /** Active provider — surfaced into the support form's diagnostics block.
   *  Optional so the docs viewer still works before any provider's chosen. */
  activeProvider?: string;
  /** Optix Cloud signed-in email — pre-fills the support form's reply-to
   *  field. Optional for BYO-key users who never sign in. */
  signedInEmail?: string;
};

type View =
  | { kind: 'list' }
  | { kind: 'detail'; article: DocArticle };

/** Render one block of a doc article. The block model is intentionally
 *  small — we don't ship a Markdown library; the renderer's job is
 *  just to map each kind to a styled element. The `form` kind dispatches
 *  on `formId` to a per-form component (currently only `support`). */
function renderBlock(
  block: DocBlock,
  idx: number,
  formProps: {
    activeProvider?: string | undefined;
    signedInEmail?: string | undefined;
  },
): JSX.Element {
  switch (block.kind) {
    case 'h':
      return (
        <h3 key={idx} className="docs__heading">
          {block.text}
        </h3>
      );
    case 'p':
      return (
        <p key={idx} className="docs__paragraph">
          {block.text}
        </p>
      );
    case 'ul':
      return (
        <ul key={idx} className="docs__list">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      );
    case 'note':
      return (
        <div key={idx} className="docs__note">
          {block.text}
        </div>
      );
    case 'code':
      return (
        <pre key={idx} className="docs__code">
          {block.text}
        </pre>
      );
    case 'form':
      switch (block.formId) {
        case 'support':
          return (
            <SupportForm
              key={idx}
              {...(formProps.activeProvider !== undefined
                ? { activeProvider: formProps.activeProvider }
                : {})}
              {...(formProps.signedInEmail !== undefined
                ? { signedInEmail: formProps.signedInEmail }
                : {})}
            />
          );
      }
  }
}

export function DocsViewer({ onClose, activeProvider, signedInEmail }: Props) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [filter, setFilter] = useState('');
  const formProps = { activeProvider, signedInEmail };

  // Group + filter the article list. We keep the source order from
  // `articles.ts` so editorial sequence is preserved per category.
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = (a: DocArticle): boolean => {
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q)
      );
    };
    const out: Record<string, DocArticle[]> = {};
    for (const cat of DOC_CATEGORIES) out[cat] = [];
    for (const a of DOC_ARTICLES) {
      if (!matches(a)) continue;
      const bucket = out[a.category];
      if (bucket) bucket.push(a);
    }
    return out;
  }, [filter]);

  const goBack = (): void => {
    if (view.kind === 'detail') setView({ kind: 'list' });
    else onClose();
  };

  // Modal hygiene: Escape mirrors the back arrow. The list view's
  // search input keeps autoFocus (more useful than the Back button on
  // a docs index) — Escape covers the keyboard-dismiss path. The
  // shared hook reads `goBack` through a ref so the listener attaches
  // once instead of churning on every view/onClose change.
  useEscapeKey(goBack);

  return (
    <div className="audit docs">
      <header className="audit__header">
        <button type="button" className="btn btn--small" onClick={goBack}>
          ← Back
        </button>
        <span className="audit__title">
          {view.kind === 'detail' ? view.article.title : 'Documentation'}
        </span>
        {view.kind === 'detail' && (
          <span
            className="audit__badge audit__badge--muted"
            title="Article category"
          >
            {view.article.category}
          </span>
        )}
      </header>

      {view.kind === 'list' && (
        <div className="audit__body docs__body">
          <input
            type="text"
            className="docs__search"
            placeholder="Search the docs…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {DOC_CATEGORIES.every((cat) => (grouped[cat] ?? []).length === 0) ? (
            <div className="audit__empty">
              No articles match &ldquo;{filter}&rdquo;.
            </div>
          ) : (
            DOC_CATEGORIES.map((cat) => {
              const items = grouped[cat] ?? [];
              if (items.length === 0) return null;
              return (
                <section key={cat} className="docs__category">
                  <h2 className="docs__category-label">{cat}</h2>
                  <ul className="audit__list">
                    {items.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          className="audit__list-item"
                          onClick={() => setView({ kind: 'detail', article: a })}
                        >
                          <div className="audit__list-prompt">{a.title}</div>
                          <div className="docs__summary">{a.summary}</div>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      )}

      {view.kind === 'detail' && (
        <div className="audit__body docs__body docs__detail">
          <p className="docs__summary docs__summary--detail">
            {view.article.summary}
          </p>
          <article className="docs__article">
            {view.article.blocks.map((b, i) => renderBlock(b, i, formProps))}
          </article>
        </div>
      )}
    </div>
  );
}
