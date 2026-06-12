import { describe, it, expect, afterAll } from "vitest";
import { escapeHtml, highlightCode, mdInline, mdToHtml } from "../src/web/markdown";
import { renderInkWashUI, AGENTS_META } from "../src/web/ui";

/* ════════ markdown renderer (isomorphic, injected into the page) ════════ */

describe("web · markdown renderer", () => {
  it("escapes HTML in all text paths (no XSS through content)", () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).not.toContain("<img");
    expect(mdToHtml('hello <script>alert(1)</script>')).not.toContain("<script");
    expect(mdToHtml('`<b>code</b>`')).toContain("&lt;b&gt;");
    expect(mdToHtml('# <svg/onload=x>')).not.toContain("<svg");
    // link text + URL are escaped; javascript: URLs are never linkified
    expect(mdToHtml('[x](javascript:alert(1))')).not.toContain("<a");
    expect(mdToHtml('["><img>](https://e.com)')).not.toContain("<img");
  });

  it("renders inline markdown: bold, italic, code, strikethrough, links", () => {
    const h = mdInline("**粗** *斜* `code` ~~删~~ [链接](https://example.com)");
    expect(h).toContain("<strong>粗</strong>");
    expect(h).toContain("<em>斜</em>");
    expect(h).toContain("<code>code</code>");
    expect(h).toContain("<del>删</del>");
    expect(h).toContain('href="https://example.com"');
    expect(h).toContain('rel="noopener noreferrer"');
  });

  it("renders block markdown: headings, lists, quote, hr, table", () => {
    const h = mdToHtml("# 标题\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(h).toContain('class="md-h md-h1"');
    expect(h).toContain("<ul><li>甲</li><li>乙</li></ul>");
    expect(h).toContain("<ol><li>一</li><li>二</li></ol>");
    expect(h).toContain("<blockquote>引用</blockquote>");
    expect(h).toContain("<hr>");
    expect(h).toContain("<th>A</th>");
    expect(h).toContain("<td>2</td>");
  });

  it("renders fenced code blocks with language tag, copy button, and highlighting", () => {
    const h = mdToHtml("```ts\nconst x = 'hi' // note\n```");
    expect(h).toContain('class="cb-lang">ts<');
    expect(h).toContain('class="cb-copy"');
    expect(h).toContain('<span class="tk-k">const</span>');
    expect(h).toContain(`<span class="tk-s">'hi'</span>`);
    expect(h).toContain('tk-c'); // comment token
  });

  it("tolerates an unclosed fence (mid-stream rendering)", () => {
    const h = mdToHtml("说明\n```py\nprint(1)");
    expect(h).toContain("<p>说明</p>");
    expect(h).toContain("print");
    expect(h).toContain("codeblock");
  });

  it("uses #-comments for python/shell and //-comments for C-likes", () => {
    expect(highlightCode("# note", "py")).toContain("tk-c");
    expect(highlightCode("// note", "ts")).toContain("tk-c");
    expect(highlightCode("# not a comment", "ts")).not.toContain("tk-c");
  });

  it("escapes content inside code blocks", () => {
    const h = mdToHtml("```html\n<div onclick=x>\n```");
    expect(h).not.toContain("<div onclick");
    expect(h).toContain("&lt;div");
  });
});

/* ════════ page integrity ════════ */

describe("web · page", () => {
  const html = renderInkWashUI();
  const script = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";

  it("injected client script is valid standalone JS with no module artifacts", () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
    for (const bad of ["exports.", "require(", "Object.defineProperty(exports"]) {
      expect(script, `leaked module artifact: ${bad}`).not.toContain(bad);
    }
    for (const fn of ["function escapeHtml", "function highlightCode", "function mdInline", "function mdToHtml", "function clientMain"]) {
      expect(script).toContain(fn);
    }
  });

  it("ships the enterprise interaction surface", () => {
    // stop-generation, theme toggle, export/clear, shortcuts, scroll pill, toasts
    for (const marker of ["send-btn", "theme-btn", "export-btn", "clear-btn", "keys-modal", "scroll-pill", "toasts", "AbortController", "localStorage"]) {
      expect(html, `missing: ${marker}`).toContain(marker);
    }
    // tool timeline + reasoning + markdown body classes exist in CSS
    for (const cls of [".tool-row", ".think", ".codeblock", ".md-table", ".caret", ".welcome"]) {
      expect(html, `missing css: ${cls}`).toContain(cls);
    }
    // dark mode tokens
    expect(html).toContain("[data-theme=dark]");
    expect(html).toContain("prefers-reduced-motion");
  });

  it("shortcut labels are OS-aware, not hardcoded to macOS", () => {
    // no ⌘ baked into the static HTML/hint — labels are filled at boot
    const staticHtml = html.replace(/<script>[\s\S]*?<\/script>/, "");
    expect(staticHtml).not.toContain("⌘");
    // the client detects Apple platforms and picks per-platform modifiers:
    // ⌘ on Apple; Alt+digit (Ctrl+digit is browser-reserved) and Ctrl+K elsewhere
    expect(script).toContain("isApple");
    expect(script).toMatch(/isApple \? .⌘. : .Alt\+./);
    expect(script).toMatch(/isApple \? .⌘. : .Ctrl\+./);
    expect(script).toContain("localizeShortcuts");
    // physical-key matching so macOS Option+digit (¡™£…) still works
    expect(script).toContain("Digit[1-6]");
    expect(script).toContain("e.altKey");
  });

  it("includes all six agents with light+dark pigments and suggestions", () => {
    expect(AGENTS_META).toHaveLength(6);
    for (const a of AGENTS_META) {
      expect(a.light).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.dark).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.tips.length).toBeGreaterThanOrEqual(3);
      expect(html).toContain(a.kanji);
    }
  });
});

/* ════════ live server integration ════════ */

describe("web · server", () => {
  let close: (() => void) | null = null;
  afterAll(() => { if (close) close(); });

  it("serves the UI and the JSON API; rejects bad requests", async () => {
    const { startWebServer } = await import("../src/web/server");
    const port = 3789 + Math.floor(Math.random() * 1000);
    await startWebServer(port);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("水墨气象台");
    expect(body).toContain("clientMain()");
    expect(body).toContain('href="/favicon.svg?v=');
    expect(body).toContain('href="/favicon.ico?v=');

    const icon = await fetch(`http://127.0.0.1:${port}/favicon.svg?v=test`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    expect(icon.headers.get("cache-control")).toContain("no-cache");
    expect(await icon.text()).toContain("<svg");

    const legacyIcon = await fetch(`http://127.0.0.1:${port}/favicon.ico?v=test`, { redirect: "manual" });
    expect(legacyIcon.status).toBe(200);
    expect(legacyIcon.headers.get("content-type")).toContain("image/svg+xml");

    const agents = await fetch(`http://127.0.0.1:${port}/api/agents`);
    expect(agents.status).toBe(200);
    const aj: any = await agents.json();
    // agent construction is environment-dependent (needs provider config);
    // the contract here is the response shape, not the roster
    expect(Array.isArray(aj.agents)).toBe(true);

    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(status.status).toBe(200);

    const bad = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(bad.status).toBe(400);

    // Host-header guard: a rebound/evil Host is refused on loopback binding.
    // (fetch/undici silently drops a Host override, so use raw http.)
    const http = await import("http");
    const evilStatus = await new Promise<number>((resolve, reject) => {
      const r = http.request(
        { host: "127.0.0.1", port, path: "/api/agents", headers: { Host: "evil.example.com" } },
        (resp) => { resp.resume(); resolve(resp.statusCode || 0); });
      r.on("error", reject);
      r.end();
    });
    expect(evilStatus).toBe(403);
  }, 15000);
});
