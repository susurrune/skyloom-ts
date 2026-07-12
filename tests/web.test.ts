import { describe, it, expect, afterAll, vi } from "vitest";
import type { Server } from "http";
import { escapeHtml, highlightCode, mdInline, mdToHtml } from "../src/web/markdown";
import { AGENT_THEMES } from "../src/core/theme";
import { renderInkWashAppJS, renderInkWashCSS, renderInkWashUI, AGENTS_META } from "../src/web/ui";

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

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
  const css = renderInkWashCSS();
  const script = renderInkWashAppJS();
  const shipped = html + css + script;

  it("client script is valid standalone JS with no module artifacts", () => {
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
    // stop-generation, theme toggle, retry/export/new session, shortcuts, scroll pill, toasts
    for (const marker of ["send-btn", "theme-btn", "settings-btn", "health-btn", "health-panel", "health-checks", "settings-panel", "setting-unified-model", "setting-workspace", "setting-provider-endpoint", "setting-clear-key", "setting-dark-mode", "retry-btn", "export-btn", "clear-btn", "keys-modal", "kbd-focus", "scroll-pill", "toasts", "AbortController", "localStorage"]) {
      expect(shipped, `missing: ${marker}`).toContain(marker);
    }
    // tool timeline + reasoning + markdown body classes exist in CSS
    for (const cls of [".tool-row", ".think", ".codeblock", ".md-table", ".caret", ".welcome"]) {
      expect(css, `missing css: ${cls}`).toContain(cls);
    }
    // static shell now references separated assets
    expect(html).toContain('/ui/styles.css?v=');
    expect(html).toContain('/ui/app.js?v=');
    expect(html).toContain('icon-brand');
    expect(html).toContain('icon-fog');
    expect(html).toContain('icon-send');
    expect(css).toContain("image2-icons.png");
    expect(html).toContain('aria-live="polite"');
    // dark mode tokens
    expect(css).toContain("[data-theme=dark]");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("shortcut labels are OS-aware, not hardcoded to macOS", () => {
    // no ⌘ baked into the static HTML/hint — labels are filled at boot
    expect(html).not.toContain("⌘");
    // the client detects Apple platforms and picks per-platform modifiers:
    // ⌘ on Apple; Alt+digit (Ctrl+digit is browser-reserved) and Ctrl+K elsewhere
    expect(script).toContain("isApple");
    expect(script).toMatch(/isApple \? .⌘. : .Alt\+./);
    expect(script).toMatch(/isApple \? .⌘. : .Ctrl\+./);
    expect(script).toContain("localizeShortcuts");
    // physical-key matching so macOS Option+digit (¡™£…) still works
    expect(script).toContain("Digit[1-6]");
    expect(script).toContain("e.altKey");
    expect(script).toContain("skyweb.agent");
    expect(script).toContain("skyweb.draft.");
    expect(script).toContain("skyweb.session.");
    expect(script).toContain("function syncHistory");
    expect(script).toMatch(/fetch\(["']\/api\/history\?agent=/);
    expect(script).toContain("FIELD NOTE / 01");
    expect(script).toContain("store.setItem(DKEY(cur.name), inp.value);");
    expect(script).toContain("function retryLast");
    expect(script).toMatch(/fetch\(["']\/api\/session["']/);
    expect(html).toContain('id="sessions-btn"');
    expect(html).toContain('aria-label="聊天历史"');
    expect(html).toContain('<span class="history-label">历史</span>');
    expect(html).toContain('id="sessions-panel"');
    expect(script).toContain("LEGACY_HKEY");
    expect(script).toMatch(/["']skyweb\.h\.["'] \+ a \+ ["']\.["']/);
    expect(script).toContain("store.getItem(SKEY(a))");
    expect(script).toContain("sessionId: store.getItem(SKEY(cur.name))");
    expect(script).toMatch(/Array\.isArray\(parsed\)/);
    expect(script).toContain("cancelAnimationFrame");
    expect(script).toContain("function openSessions");
    expect(script).toContain("function openSettings");
    expect(script).toContain("/api/settings");
    expect(script).toMatch(/fetch\(["']\/api\/sessions\?agent=/);
    expect(script).toMatch(/fetch\(["']\/api\/session\/load["']/);
    expect(script).toMatch(/method:\s*["']DELETE["']/);
    expect(script).not.toContain("当前会话已是空的");
  });

  it("includes all six agents with light+dark pigments and suggestions", () => {
    expect(AGENTS_META).toHaveLength(6);
    for (const a of AGENTS_META) {
      expect(a.light).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.dark).toMatch(/^#[0-9a-f]{6}$/i);
      expect(a.tips.length).toBeGreaterThanOrEqual(3);
      expect(shipped).toContain(a.kanji);
    }
  });

  it("derives web agent identity from the shared core theme", () => {
    for (const a of AGENTS_META) {
      const theme = AGENT_THEMES[a.name];
      expect(theme).toBeTruthy();
      expect(a.light).toBe(theme.hex);
      expect(a.kanji).toBe(theme.kanji);
      expect(a.pig).toBe(theme.pigment);
      expect(a.sub).toBe(theme.specialty);
      expect(a.poem).toBe(theme.poem);
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
    const server = await startWebServer(port);
    close = () => server.close();

    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("水墨气象台");
    expect(body).toContain('/ui/styles.css?v=');
    expect(body).toContain('/ui/app.js?v=');
    expect(body).toContain('href="/ui/assets/image2-favicon.png?v=');
    expect(body).toContain('id="side-dock"');
    expect(body).toContain('class="side-btn theme-tool"');
    expect(body).toContain('class="side-btn help-tool"');

    const styles = await fetch(`http://127.0.0.1:${port}/ui/styles.css?v=test`);
    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toContain("text/css");
    const stylesBody = await styles.text();
    expect(stylesBody).toContain("#mountain-wash");
    expect(stylesBody).toContain(".tool-row");

    const app = await fetch(`http://127.0.0.1:${port}/ui/app.js?v=test`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("application/javascript");
    expect(await app.text()).toContain("function clientMain");

    const atlas = await fetch(`http://127.0.0.1:${port}/ui/assets/image2-icons.png?v=test`);
    expect(atlas.status).toBe(200);
    expect(atlas.headers.get("content-type")).toContain("image/png");
    expect((await atlas.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const icon = await fetch(`http://127.0.0.1:${port}/ui/assets/image2-favicon.png?v=test`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("image/png");
    expect((await icon.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    const legacyIcon = await fetch(`http://127.0.0.1:${port}/favicon.ico?v=test`, { redirect: "manual" });
    expect(legacyIcon.status).toBe(200);
    expect(legacyIcon.headers.get("content-type")).toContain("image/png");

    const agents = await fetch(`http://127.0.0.1:${port}/api/agents`);
    expect(agents.status).toBe(200);
    const aj: any = await agents.json();
    expect(Array.isArray(aj.agents)).toBe(true);
    expect(aj.agents.map((agent: any) => agent.name).sort()).toEqual([
      'dew', 'fair', 'fog', 'frost', 'rain', 'snow',
    ]);

    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(status.status).toBe(200);
    const sj: any = await status.json();
    expect(sj).toMatchObject({
      version: expect.any(String),
      workspace: expect.any(String),
      runtime: { node: expect.any(String), uptimeSeconds: expect.any(Number) },
      agents: { summary: { total: expect.any(Number), busy: expect.any(Number), idle: expect.any(Number) } },
      tools: { registered: expect.any(Number), calls: expect.any(Number), failures: expect.any(Number) },
      background: { total: expect.any(Number), running: expect.any(Number) },
      mcp: { connected: expect.any(Number), servers: expect.any(Array) },
    });
    expect(sj.agents.summary.total).toBe(6);
    expect(sj.tools.registered).toBeGreaterThan(20);

    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
    const hj: any = await health.json();
    expect(hj).toMatchObject({
      schemaVersion: 1,
      ok: expect.any(Boolean),
      generatedAt: expect.any(String),
      runtime: { status: expect.any(Object) },
      doctor: {
        summary: {
          pass: expect.any(Number),
          warn: expect.any(Number),
          fail: expect.any(Number),
        },
        checks: expect.any(Array),
      },
      nextActions: expect.any(Array),
    });
    expect(JSON.stringify(hj)).not.toMatch(/sk-[a-z0-9_-]{8,}/i);

    const settings = await fetch(`http://127.0.0.1:${port}/api/settings`);
    expect(settings.status).toBe(200);
    const settingsJson: any = await settings.json();
    expect(settingsJson.runtime).toMatchObject({
      language: expect.any(String),
      approvalMode: expect.any(String),
      toolConcurrency: expect.any(Number),
    });
    expect(Array.isArray(settingsJson.agents)).toBe(true);
    expect(JSON.stringify(settingsJson)).not.toMatch(/api[_-]?key/i);

    const bad = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({
      error: {
        code: "web.bad_request",
        message: "message is required",
        retryable: false,
        action: expect.any(String),
      },
    });

    const malformed = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      error: { code: "web.invalid_json", retryable: false },
    });

    const evilOrigin = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(evilOrigin.status).toBe(403);
    await expect(evilOrigin.json()).resolves.toMatchObject({
      error: { code: "web.forbidden_origin", retryable: false },
    });

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

  it("starts a genuinely new backend session for the selected agent", async () => {
    const { startWebServer } = await import("../src/web/server");
    const port = 4789 + Math.floor(Math.random() * 1000);
    const createSession = vi.fn(async () => "session-new");
    const init = vi.fn(async () => undefined);
    const fakeAgent = {
      name: "fog",
      displayName: "雾",
      emoji: "",
      specialty: "test",
      state: "idle",
      init,
      memory: { createSession },
      getStatus: () => ({}),
    };
    const fakeContext = {
      agentMap: new Map([["fog", fakeAgent]]),
      workspacePath: process.cwd(),
    };
    const server = await (startWebServer as any)(port, fakeContext);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "fog" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessionId: "session-new" });
      expect(init).toHaveBeenCalledTimes(1);
      expect(createSession).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  it("serves the active backend conversation without internal tool messages", async () => {
    const { startWebServer } = await import("../src/web/server");
    const port = 5289 + Math.floor(Math.random() * 1000);
    const fakeAgent = {
      name: "fog",
      displayName: "雾",
      emoji: "",
      specialty: "test",
      state: "idle",
      init: vi.fn(async () => undefined),
      memory: {
        getActiveSession: () => "session-active",
        getMessages: () => [
          { role: "system", content: "internal prompt" },
          { role: "user", content: "请检查项目" },
          { role: "assistant", content: "先读取", toolCalls: [{ id: "call-1" }] },
          { role: "tool", content: "secret tool output" },
          { role: "assistant", content: "检查完成" },
        ],
      },
      getStatus: () => ({}),
    };
    const fakeContext = {
      agentMap: new Map([["fog", fakeAgent]]),
      workspacePath: process.cwd(),
    };
    const server = await (startWebServer as any)(port, fakeContext);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/history?agent=fog`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        sessionId: "session-active",
        messages: [
          { role: "user", content: "请检查项目" },
          { role: "assistant", content: "检查完成" },
        ],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("lists, restores, and deletes persisted web sessions", async () => {
    const { startWebServer } = await import("../src/web/server");
    const port = 5489 + Math.floor(Math.random() * 1000);
    let activeSession = "session-current";
    const loadSession = vi.fn(async (sessionId: string) => {
      if (sessionId !== "session-older") return false;
      activeSession = sessionId;
      return true;
    });
    const deleteSession = vi.fn(async (sessionId: string) => {
      if (sessionId !== activeSession) return false;
      activeSession = null as any;
      return true;
    });
    const createSession = vi.fn(async () => {
      activeSession = "session-fresh";
      return activeSession;
    });
    const sessions = [
      { id: "session-current", preview: "当前问题", messageCount: 4, updatedAt: "2026-07-04 20:00:00" },
      { id: "session-older", preview: "旧问题", messageCount: 2, updatedAt: "2026-07-03 20:00:00" },
    ];
    const fakeAgent = {
      name: "fog",
      displayName: "雾",
      emoji: "",
      specialty: "test",
      state: "idle",
      init: vi.fn(async () => undefined),
      memory: {
        listSessions: vi.fn(async () => sessions),
        getActiveSession: () => activeSession,
        loadSession,
        deleteSession,
        createSession,
      },
      getStatus: () => ({}),
    };
    const fakeContext = {
      agentMap: new Map([["fog", fakeAgent]]),
      workspacePath: process.cwd(),
    };
    const server = await (startWebServer as any)(port, fakeContext);

    try {
      const listed = await fetch(`http://127.0.0.1:${port}/api/sessions?agent=fog`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ activeSessionId: "session-current", sessions });

      const loaded = await fetch(`http://127.0.0.1:${port}/api/session/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "fog", sessionId: "session-older" }),
      });
      expect(loaded.status).toBe(200);
      expect(await loaded.json()).toEqual({ sessionId: "session-older" });
      expect(loadSession).toHaveBeenCalledWith("session-older");

      const deleted = await fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "fog", sessionId: "session-older" }),
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true, sessionId: "session-fresh" });
      expect(deleteSession).toHaveBeenCalledWith("session-older");
      expect(createSession).toHaveBeenCalledTimes(1);
    } finally {
      await closeServer(server);
    }
  });

  it("refuses to reset a session while the agent is busy", async () => {
    const { startWebServer } = await import("../src/web/server");
    const port = 5789 + Math.floor(Math.random() * 1000);
    const createSession = vi.fn(async () => "should-not-run");
    const fakeAgent = {
      name: "fog",
      displayName: "雾",
      emoji: "",
      specialty: "test",
      state: "thinking",
      init: vi.fn(async () => undefined),
      memory: { createSession },
      getStatus: () => ({}),
    };
    const fakeContext = {
      agentMap: new Map([["fog", fakeAgent]]),
      workspacePath: process.cwd(),
    };
    const server = await (startWebServer as any)(port, fakeContext);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "fog" }),
      });
      expect(response.status).toBe(409);
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});
