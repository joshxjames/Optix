// Free DuckDuckGo search backend. No auth, no quota — but scrapes public
// HTML, so it's inherently fragile: if DDG changes markup we'll need to
// update the regexes. Used as a fallback when a provider's native search
// isn't available or fails.

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'Mozilla/5.0 (compatible; Optix/0.1; +https://github.com/)';

/** Run a DDG HTML search and return the top `limit` results. */
export async function ddgSearch(query: string, limit = 5): Promise<SearchResult[]> {
  const body = new URLSearchParams({ q: query }).toString();
  const resp = await fetch(DDG_ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`DuckDuckGo returned HTTP ${resp.status}.`);
  }
  const html = await resp.text();
  return parseDdgHtml(html, limit);
}

/**
 * Parse DDG HTML results. Looks for anchor tags with class `result__a` (title+url)
 * and sibling `result__snippet` anchors. Order is preserved.
 */
function parseDdgHtml(html: string, limit: number): SearchResult[] {
  const titleRe = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const titles: { url: string; title: string }[] = [];
  const snippets: string[] = [];

  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null && titles.length < limit) {
    const cleaned = cleanDdgUrl(m[1]!);
    // Drop entries whose URL didn't survive http(s) gating — a poisoned
    // DDG response could otherwise smuggle `javascript:` URLs into the
    // model's context.
    if (cleaned === null) continue;
    titles.push({ url: cleaned, title: stripHtml(m[2]!) });
  }
  while ((m = snippetRe.exec(html)) !== null && snippets.length < limit) {
    snippets.push(stripHtml(m[1]!));
  }

  const out: SearchResult[] = [];
  for (let i = 0; i < Math.min(titles.length, limit); i++) {
    out.push({
      title: titles[i]!.title,
      url: titles[i]!.url,
      snippet: snippets[i] ?? '',
    });
  }
  return out;
}

/** DDG wraps external URLs in `//duckduckgo.com/l/?uddg=<encoded>`. Unwrap.
 *  Returns null when the resolved URL isn't a plain http(s) link — that
 *  drops `javascript:`, `data:`, `file://`, etc. tucked into the redirect
 *  param. The agent never sees those, so it can't be tricked into asking
 *  the user to `openUrl` something dangerous. */
function cleanDdgUrl(raw: string): string | null {
  let candidate = raw;
  const m = raw.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      candidate = decodeURIComponent(m[1]!);
    } catch {
      // Fall through to raw.
    }
  } else if (raw.startsWith('//')) {
    candidate = 'https:' + raw;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Format search results for inclusion in an LLM prompt or tool response. */
export function formatSearchResultsForLlm(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `No web results found for "${query}".`;
  }
  const body = results
    .slice(0, 3)
    .map((r, i) => {
      const snippet = r.snippet.length > 120 ? r.snippet.slice(0, 120) + '...' : r.snippet;
      return `[${i + 1}] ${r.title}\n    ${snippet}`;
    })
    .join('\n\n');
  return `Web search results for "${query}":\n\n${body}`;
}
