import { useEffect, useMemo, useState } from 'react';
import {
  DOC_ARTICLES,
  DOC_CATEGORIES,
  type DocArticle,
  type DocBlock,
} from './docs/articles';

type Props = {
  onClose: () => void;
};

type View =
  | { kind: 'list' }
  | { kind: 'detail'; article: DocArticle };

/** Render one block of a doc article. The block model is intentionally
 *  small — we don't ship a Markdown library; the renderer's job is
 *  just to map each kind to a styled element. */
function renderBlock(block: DocBlock, idx: number): JSX.Element {
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
  }
}

export function DocsViewer({ onClose }: Props) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [filter, setFilter] = useState('');

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
  // a docs index) — Escape covers the keyboard-dismiss path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') goBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, onClose]);

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
            {view.article.blocks.map(renderBlock)}
          </article>
        </div>
      )}
    </div>
  );
}
