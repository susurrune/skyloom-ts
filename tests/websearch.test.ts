import { describe, it, expect } from "vitest";
import {
  webSearch, resolveProviders, formatSearchResults, readPage,
  type WebHttp, type EnvMap,
} from "../src/tools/websearch";

/** A scriptable HTTP stub: match by URL substring, record calls. */
function stubHttp(routes: { match: string; json?: any; text?: string; throws?: string }[]): WebHttp & { calls: string[] } {
  const calls: string[] = [];
  const pick = (url: string) => routes.find((r) => url.includes(r.match));
  const run = (url: string) => {
    calls.push(url);
    const r = pick(url);
    if (!r) throw new Error("no route for " + url);
    if (r.throws) throw new Error(r.throws);
    return r;
  };
  return {
    calls,
    async getJson(url) { const r = run(url); return r.json; },
    async postJson(url) { const r = run(url); return r.json; },
    async getText(url) { const r = run(url); return r.text ?? ""; },
  };
}

describe("websearch · provider resolution", () => {
  it("auto order with no keys: jina first, then scrape engines", () => {
    const ids = resolveProviders({}).map((p) => p.id);
    expect(ids[0]).toBe("jina");
    expect(ids).toContain("duckduckgo");
    expect(ids.indexOf("jina")).toBeLessThan(ids.indexOf("duckduckgo"));
  });

  it("prefers keyed providers over jina, in priority order", () => {
    const ids = resolveProviders({ TAVILY_API_KEY: "k", BRAVE_API_KEY: "k" }).map((p) => p.id);
    expect(ids[0]).toBe("tavily");
    expect(ids[1]).toBe("brave");
    expect(ids.indexOf("tavily")).toBeLessThan(ids.indexOf("jina"));
  });

  it("a pinned engine restricts to that provider only", () => {
    expect(resolveProviders({}, "duckduckgo").map((p) => p.id)).toEqual(["duckduckgo"]);
    expect(resolveProviders({ TAVILY_API_KEY: "k" }, "tavily").map((p) => p.id)).toEqual(["tavily"]);
    // pinned but key missing → empty (caller reports no results)
    expect(resolveProviders({}, "tavily")).toHaveLength(0);
  });
});

describe("websearch · provider parsers", () => {
  it("parses Tavily results + answer", async () => {
    const http = stubHttp([{ match: "api.tavily.com", json: {
      answer: "42 is the answer",
      results: [{ title: "T1", url: "https://a.com", content: "snip a" }],
    } }]);
    const res = await webSearch("q", { env: { TAVILY_API_KEY: "k" }, http });
    expect(res.provider).toBe("tavily");
    expect(res.answer).toBe("42 is the answer");
    expect(res.results[0]).toEqual({ title: "T1", url: "https://a.com", snippet: "snip a" });
  });

  it("parses Brave results", async () => {
    const http = stubHttp([{ match: "api.search.brave.com", json: {
      web: { results: [{ title: "B1", url: "https://b.com", description: "desc b" }] },
    } }]);
    const res = await webSearch("q", { env: { BRAVE_API_KEY: "k" }, http });
    expect(res.provider).toBe("brave");
    expect(res.results[0].snippet).toBe("desc b");
  });

  it("parses Serper organic + answerBox", async () => {
    const http = stubHttp([{ match: "google.serper.dev", json: {
      answerBox: { answer: "direct" },
      organic: [{ title: "S1", link: "https://s.com", snippet: "snip s" }],
    } }]);
    const res = await webSearch("q", { env: { SERPER_API_KEY: "k" }, http });
    expect(res.provider).toBe("serper");
    expect(res.answer).toBe("direct");
    expect(res.results[0].url).toBe("https://s.com");
  });

  it("parses SearXNG JSON", async () => {
    const http = stubHttp([{ match: "/search?q=", json: {
      results: [{ title: "X1", url: "https://x.com", content: "snip x" }],
    } }]);
    const res = await webSearch("q", { env: { SEARXNG_URL: "https://searx.local/" }, http });
    expect(res.provider).toBe("searxng");
    expect(res.results[0].title).toBe("X1");
  });

  it("parses keyless Jina results", async () => {
    const http = stubHttp([{ match: "s.jina.ai", json: {
      data: [{ title: "J1", url: "https://j.com", description: "snip j" }],
    } }]);
    const res = await webSearch("q", { env: {}, http });
    expect(res.provider).toBe("jina");
    expect(res.results[0].url).toBe("https://j.com");
  });

  it("scrapes DuckDuckGo HTML when pinned", async () => {
    const html = `<a class="result__a" href="/l/?uddg=https%3A%2F%2Fd.com">DDG Title</a>
      <a class="result__snippet">ddg snippet</a>`;
    const http = stubHttp([{ match: "duckduckgo.com", text: html }]);
    const res = await webSearch("q", { env: {}, http, engine: "duckduckgo" });
    expect(res.provider).toBe("duckduckgo");
    expect(res.results[0]).toEqual({ title: "DDG Title", url: "https://d.com", snippet: "ddg snippet" });
  });
});

describe("websearch · waterfall", () => {
  it("falls through a throwing provider to the next", async () => {
    const errors: string[] = [];
    const http = stubHttp([
      { match: "api.tavily.com", throws: "tavily down" },
      { match: "s.jina.ai", json: { data: [{ title: "J", url: "https://j.com", description: "s" }] } },
    ]);
    const res = await webSearch("q", { env: { TAVILY_API_KEY: "k" }, http, onProviderError: (p, e) => errors.push(p + ":" + e) });
    expect(res.provider).toBe("jina");
    expect(errors[0]).toContain("tavily");
    expect(res.tried).toContain("tavily");
  });

  it("falls through an empty-result provider to the next", async () => {
    const http = stubHttp([
      { match: "s.jina.ai", json: { data: [] } },
      { match: "duckduckgo.com", text: `<a class="result__a" href="https://d.com">D</a><a class="result__snippet">s</a>` },
    ]);
    const res = await webSearch("q", { env: {}, http });
    expect(res.provider).toBe("duckduckgo");
  });

  it("returns an empty response listing tried providers when all fail", async () => {
    const http = stubHttp([
      { match: "s.jina.ai", throws: "x" },
      { match: "duckduckgo", throws: "x" }, { match: "bing", throws: "x" },
      { match: "baidu", throws: "x" }, { match: "sogou", throws: "x" },
    ]);
    const res = await webSearch("q", { env: {}, http });
    expect(res.results).toHaveLength(0);
    expect(res.tried).toEqual(["jina", "duckduckgo", "bing", "baidu", "sogou"]);
    expect(formatSearchResults(res)).toContain("No search results");
  });

  it("rejects an empty query", async () => {
    await expect(webSearch("   ", {})).rejects.toThrow(/query/);
  });
});

describe("websearch · formatting + dedup", () => {
  it("formats answer and numbered results", () => {
    const out = formatSearchResults({ provider: "tavily", answer: "A", results: [
      { title: "T", url: "https://t.com", snippet: "s" },
    ], tried: ["tavily"] });
    expect(out).toContain("Answer: A");
    expect(out).toContain("1. T");
    expect(out).toContain("https://t.com");
  });

  it("dedupes by URL and drops non-http entries", async () => {
    const http = stubHttp([{ match: "s.jina.ai", json: { data: [
      { title: "A", url: "https://dup.com", description: "1" },
      { title: "B", url: "https://dup.com", description: "2" }, // duplicate URL
      { title: "C", url: "javascript:alert(1)", description: "3" }, // non-http
    ] } }]);
    const res = await webSearch("q", { env: {}, http });
    expect(res.results).toHaveLength(1);
    expect(res.results[0].url).toBe("https://dup.com");
  });
});

describe("websearch · readPage", () => {
  it("uses the Jina reader and clips long output", async () => {
    const http = stubHttp([{ match: "r.jina.ai", text: "X".repeat(50) }]);
    const out = await readPage("https://news.com/article", { env: {}, http, maxChars: 10 });
    expect(http.calls[0]).toContain("r.jina.ai");
    expect(out).toContain("truncated");
  });

  it("falls back to a raw fetch when the reader fails", async () => {
    const http = stubHttp([
      { match: "r.jina.ai", throws: "reader down" },
      { match: "raw.com", text: "<html><body>hello <b>world</b></body></html>" },
    ]);
    const out = await readPage("https://raw.com/p", { env: {}, http });
    expect(out).toContain("hello world");
  });

  it("rejects a non-http url", async () => {
    await expect(readPage("ftp://x", {})).rejects.toThrow(/http/);
  });
});
