/**
 * 联网搜索 · Web search with a provider waterfall.
 *
 * Why this module exists: the old web_search scraped DuckDuckGo/Bing/Baidu/Sogou
 * HTML. Scraping breaks constantly — engines change markup, block bot
 * user-agents, throw CAPTCHAs, and rate-limit — so "search doesn't work" was the
 * norm. This replaces it with a waterfall that prefers reliable JSON APIs and
 * only falls back to scraping as a last resort:
 *
 *   1. Tavily   (TAVILY_API_KEY)   — purpose-built for LLM agents, returns an answer
 *   2. Brave    (BRAVE_API_KEY)    — independent index, clean JSON
 *   3. Serper   (SERPER_API_KEY)   — Google results as JSON
 *   4. SearXNG  (SEARXNG_URL)      — self-hosted metasearch JSON
 *   5. Jina     (keyless)          — s.jina.ai, free, LLM-optimized — works with NO setup
 *   6. Scrape   (last resort)      — the legacy HTML scrapers
 *
 * The headline win: even with zero configuration, Jina's keyless endpoint gives
 * results that actually return — no API key, no scraping fragility. Set any of
 * the API keys above for enterprise-grade reliability and higher rate limits.
 *
 * The HTTP layer is injectable so the orchestration and every parser are
 * unit-testable without a network.
 */

import axios from 'axios';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  provider: string;        // which provider produced these results
  results: SearchResult[];
  answer?: string;         // direct answer / summary, when the provider offers one
}

/** Minimal HTTP surface — injectable for tests. */
export interface WebHttp {
  getJson(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<any>;
  postJson(url: string, body: any, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<any>;
  getText(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<string>;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_TIMEOUT = 15000;

/** Default HTTP client backed by axios. */
export const defaultHttp: WebHttp = {
  async getJson(url, opts) {
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts?.headers || {}) },
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return res.data;
  },
  async postJson(url, body, opts) {
    const res = await axios.post(url, body, {
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json', ...(opts?.headers || {}) },
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return res.data;
  },
  async getText(url, opts) {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(opts?.headers || {}),
      },
      timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 300,
      responseType: 'text',
      transformResponse: [(d) => d],
    });
    return res.data as string;
  },
};

/* ── HTML helpers (shared by the scrape provider) ── */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
export function stripTags(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}
function unwrapDdgRedirect(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { /* fall through */ } }
  if (href.startsWith('//')) return 'https:' + href;
  return href;
}

function clean(results: SearchResult[], max: number): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (!r || !r.title || !/^https?:\/\//i.test(r.url || '')) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ title: r.title.trim(), url: r.url.trim(), snippet: (r.snippet || '').trim() });
    if (out.length >= max) break;
  }
  return out;
}

/* ════════════════════════════════════════════════════════════
   API providers (preferred — reliable JSON)
   ════════════════════════════════════════════════════════════ */

async function tavily(http: WebHttp, key: string, query: string, max: number): Promise<SearchResponse> {
  const data = await http.postJson('https://api.tavily.com/search', {
    query, max_results: max, search_depth: 'basic', include_answer: true,
  }, { headers: { Authorization: `Bearer ${key}` } });
  const results = (data?.results || []).map((r: any) => ({
    title: r.title || '', url: r.url || '', snippet: r.content || '',
  }));
  return { provider: 'tavily', results: clean(results, max), answer: data?.answer || undefined };
}

async function brave(http: WebHttp, key: string, query: string, max: number): Promise<SearchResponse> {
  const data = await http.getJson(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`,
    { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } },
  );
  const results = (data?.web?.results || []).map((r: any) => ({
    title: r.title || '', url: r.url || '', snippet: r.description || '',
  }));
  return { provider: 'brave', results: clean(results, max) };
}

async function serper(http: WebHttp, key: string, query: string, max: number): Promise<SearchResponse> {
  const data = await http.postJson('https://google.serper.dev/search',
    { q: query, num: max },
    { headers: { 'X-API-KEY': key } });
  const results = (data?.organic || []).map((r: any) => ({
    title: r.title || '', url: r.link || '', snippet: r.snippet || '',
  }));
  const answer = data?.answerBox?.answer || data?.answerBox?.snippet || data?.knowledgeGraph?.description || undefined;
  return { provider: 'serper', results: clean(results, max), answer };
}

async function searxng(http: WebHttp, baseUrl: string, query: string, max: number): Promise<SearchResponse> {
  const base = baseUrl.replace(/\/+$/, '');
  const data = await http.getJson(
    `${base}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`,
  );
  const results = (data?.results || []).map((r: any) => ({
    title: r.title || '', url: r.url || '', snippet: r.content || '',
  }));
  return { provider: 'searxng', results: clean(results, max) };
}

async function jina(http: WebHttp, key: string | undefined, query: string, max: number): Promise<SearchResponse> {
  // s.jina.ai returns the SERP for a query. `X-Respond-With: no-content` skips
  // fetching each page body (faster, fewer tokens — we only want the listing).
  // Keyless works (shared rate pool); a JINA_API_KEY raises the limit.
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Respond-With': 'no-content' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const data = await http.getJson(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, { headers });
  const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const results = rows.map((r: any) => ({
    title: r.title || '', url: r.url || '', snippet: r.description || r.content || r.snippet || '',
  }));
  return { provider: 'jina', results: clean(results, max) };
}

/* ════════════════════════════════════════════════════════════
   Scrape provider (last resort — fragile HTML parsing)
   ════════════════════════════════════════════════════════════ */

async function scrapeDuckDuckGo(http: WebHttp, query: string, max: number): Promise<SearchResult[]> {
  const html = await http.getText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const out: SearchResult[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    out.push({ url: unwrapDdgRedirect(m[1]), title: stripTags(m[2]), snippet: stripTags(m[3]) });
  }
  return out;
}
async function scrapeBing(http: WebHttp, query: string, max: number): Promise<SearchResult[]> {
  const html = await http.getText(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-cn`);
  const out: SearchResult[] = [];
  for (const item of html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || []) {
    if (out.length >= max) break;
    const a = item.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const snip = item.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i) || item.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ url: a[1], title: stripTags(a[2]), snippet: snip ? stripTags(snip[1]) : '' });
  }
  return out;
}
async function scrapeBaidu(http: WebHttp, query: string, max: number): Promise<SearchResult[]> {
  const html = await http.getText(`https://www.baidu.com/s?wd=${encodeURIComponent(query)}`);
  const out: SearchResult[] = [];
  const re = /<h3[^>]*>[\s\S]{0,500}?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const url = m[1]; const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    const after = html.slice(re.lastIndex, re.lastIndex + 4000);
    const snip = after.match(/<span class="content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
      || after.match(/<div class="c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || after.match(/<p[^>]*>([\s\S]{20,400}?)<\/p>/i);
    out.push({ url, title, snippet: snip ? stripTags(snip[1]) : '' });
  }
  return out;
}
async function scrapeSogou(http: WebHttp, query: string, max: number): Promise<SearchResult[]> {
  const html = await http.getText(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`);
  const out: SearchResult[] = [];
  for (const item of html.match(/<div[^>]+class="vrwrap"[\s\S]*?(?=<div[^>]+class="vrwrap"|$)/gi) || []) {
    if (out.length >= max) break;
    const a = item.match(/<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = a[1]; if (url.startsWith('/link?')) url = 'https://www.sogou.com' + url;
    const snip = item.match(/<div[^>]+class="(?:str_info|fz-mid|space-txt)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || item.match(/<p[^>]*>([\s\S]{20,400}?)<\/p>/i);
    out.push({ url, title: stripTags(a[2]), snippet: snip ? stripTags(snip[1]) : '' });
  }
  return out;
}

const SCRAPE_ENGINES = ['duckduckgo', 'bing', 'baidu', 'sogou'] as const;
type ScrapeEngine = typeof SCRAPE_ENGINES[number];

async function scrape(http: WebHttp, engine: ScrapeEngine, query: string, max: number): Promise<SearchResponse> {
  const fn = engine === 'bing' ? scrapeBing : engine === 'baidu' ? scrapeBaidu : engine === 'sogou' ? scrapeSogou : scrapeDuckDuckGo;
  return { provider: engine, results: clean(await fn(http, query, max), max) };
}

/* ════════════════════════════════════════════════════════════
   Orchestration
   ════════════════════════════════════════════════════════════ */

export type EnvMap = Record<string, string | undefined>;

interface Provider {
  id: string;
  /** Run the provider; throws on failure so the waterfall can move on. */
  run(http: WebHttp, env: EnvMap, query: string, max: number): Promise<SearchResponse>;
}

/** Resolve the ordered provider list for a given env + optional pinned engine. */
export function resolveProviders(env: EnvMap, pinned?: string): Provider[] {
  const p = (pinned || '').trim().toLowerCase();

  const tavilyP: Provider | null = env.TAVILY_API_KEY
    ? { id: 'tavily', run: (h, e, q, m) => tavily(h, e.TAVILY_API_KEY!, q, m) } : null;
  const braveKey = env.BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY;
  const braveP: Provider | null = braveKey
    ? { id: 'brave', run: (h, _e, q, m) => brave(h, braveKey!, q, m) } : null;
  const serperP: Provider | null = env.SERPER_API_KEY
    ? { id: 'serper', run: (h, e, q, m) => serper(h, e.SERPER_API_KEY!, q, m) } : null;
  const searxngP: Provider | null = env.SEARXNG_URL
    ? { id: 'searxng', run: (h, e, q, m) => searxng(h, e.SEARXNG_URL!, q, m) } : null;
  const jinaP: Provider = { id: 'jina', run: (h, e, q, m) => jina(h, e.JINA_API_KEY, q, m) };
  const scrapeP = (eng: ScrapeEngine): Provider => ({ id: eng, run: (h, _e, q, m) => scrape(h, eng, q, m) });

  // Explicit pin (tool arg or SKYLOOM_SEARCH_ENGINE) — use only that provider.
  if (p) {
    if (p === 'tavily') return tavilyP ? [tavilyP] : [];
    if (p === 'brave') return braveP ? [braveP] : [];
    if (p === 'serper') return serperP ? [serperP] : [];
    if (p === 'searxng') return searxngP ? [searxngP] : [];
    if (p === 'jina') return [jinaP];
    if (p === 'ddg' || p === 'duckduckgo') return [scrapeP('duckduckgo')];
    if ((SCRAPE_ENGINES as readonly string[]).includes(p)) return [scrapeP(p as ScrapeEngine)];
    // Unknown pin → fall through to auto.
  }

  // Auto waterfall: keyed providers first (best), then keyless Jina, then scrape.
  const order: Provider[] = [];
  for (const cand of [tavilyP, braveP, serperP, searxngP]) if (cand) order.push(cand);
  order.push(jinaP);
  for (const eng of SCRAPE_ENGINES) order.push(scrapeP(eng));
  return order;
}

export interface WebSearchOptions {
  max?: number;
  engine?: string;           // explicit pin from the tool arg
  env?: EnvMap;              // defaults to process.env
  http?: WebHttp;           // defaults to axios-backed client
  onProviderError?: (provider: string, error: string) => void;
}

/**
 * Run a web search through the provider waterfall. Returns the first provider
 * that yields results, or a response with an empty result set + the list of
 * providers that were tried.
 */
export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<SearchResponse & { tried: string[] }> {
  const q = (query || '').trim();
  if (!q) throw new Error('query is required');
  const max = Math.max(1, Math.min(20, Math.floor(opts.max ?? 8)));
  const env = opts.env ?? (process.env as EnvMap);
  const http = opts.http ?? defaultHttp;
  const pinned = (opts.engine || env.SKYLOOM_SEARCH_ENGINE || '').trim();

  const providers = resolveProviders(env, pinned);
  const tried: string[] = [];
  for (const provider of providers) {
    tried.push(provider.id);
    try {
      const res = await provider.run(http, env, q, max);
      if (res.results.length > 0 || res.answer) return { ...res, tried };
    } catch (e: any) {
      opts.onProviderError?.(provider.id, String(e?.message || e));
    }
  }
  return { provider: 'none', results: [], tried };
}

/** Format a SearchResponse as compact text for an LLM tool result. */
export function formatSearchResults(res: SearchResponse & { tried?: string[] }): string {
  if (!res.results.length && !res.answer) {
    const tried = res.tried?.length ? ` (tried: ${res.tried.join(', ')})` : '';
    return `No search results found${tried}. Try a simpler query, or set a search API key (TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY) for more reliable results.`;
  }
  const parts: string[] = [];
  if (res.answer) parts.push(`Answer: ${res.answer}\n`);
  parts.push(`Search results (${res.provider}, ${res.results.length}):`);
  parts.push(res.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n'));
  return parts.join('\n');
}

/* ════════════════════════════════════════════════════════════
   Page reader — clean, LLM-ready content from a URL
   ════════════════════════════════════════════════════════════ */

/**
 * Fetch a URL as clean, readable text. Uses Jina's r.jina.ai reader (strips
 * nav/ads, returns markdown) when reachable, falling back to a raw fetch. This
 * is what makes "read the top news article" actually usable — raw HTML is
 * mostly boilerplate.
 */
export async function readPage(url: string, opts: { env?: EnvMap; http?: WebHttp; maxChars?: number } = {}): Promise<string> {
  const env = opts.env ?? (process.env as EnvMap);
  const http = opts.http ?? defaultHttp;
  const maxChars = opts.maxChars ?? 12000;
  if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');

  const headers: Record<string, string> = { Accept: 'text/plain' };
  if (env.JINA_API_KEY) headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
  try {
    const text = await http.getText(`https://r.jina.ai/${url}`, { headers, timeoutMs: 20000 });
    if (text && text.trim()) return clip(text, maxChars);
  } catch { /* fall through to raw fetch */ }

  const raw = await http.getText(url, { timeoutMs: 15000 });
  return clip(stripTags(raw), maxChars);
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n...[truncated, ${s.length - max} more chars]` : s;
}
