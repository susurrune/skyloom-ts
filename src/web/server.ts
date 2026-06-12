/**
 * Web server for Skyloom — HTTP API + 水墨气象台 chat UI.
 *
 * The UI itself lives in src/web/ui.ts (design system + injected client app);
 * this file is the transport: security guards, SSE streaming, and the small
 * JSON API.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { createSystemContext } from "../core/factory";
import { getLogger } from "../core/logger";
import { renderInkWashUI, SKYLOOM_FAVICON_SVG } from "./ui";

const log = getLogger("web-server");

/* ──────────────────────────────────────────────
   Server
   ────────────────────────────────────────────── */
export async function startWebServer(port: number = 7777): Promise<void> {
  const ctx = createSystemContext();

  // Bind to loopback by default: the chat API drives the agent (and its tools)
  // with no authentication, so it must not be exposed to the network unless the
  // operator explicitly opts in via SKYLOOM_WEB_HOST=0.0.0.0.
  const host = process.env.SKYLOOM_WEB_HOST || "127.0.0.1";
  const loopbackOnly = host === "127.0.0.1" || host === "localhost" || host === "::1";

  // Reject cross-origin / rebound Host headers when bound to loopback. Without
  // this, a malicious web page could POST to http://localhost:<port>/api/chat
  // from the victim's browser and execute agent tools (CORS does not block the
  // side effect, only the response read).
  const hostAllowed = (h: string | undefined): boolean => {
    if (!loopbackOnly) return true;
    const name = (h || "").split(":")[0].toLowerCase();
    return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1" || name === "";
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Forbidden host" }));
      return;
    }
    // Same-origin only when loopback-bound (no wildcard CORS that would invite
    // cross-site requests to a credential-less, tool-executing endpoint).
    if (loopbackOnly) {
      res.setHeader("Access-Control-Allow-Origin", `http://${req.headers.host || `localhost:${port}`}`);
      res.setHeader("Vary", "Origin");
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    try {
      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") serveUI(res);
      else if (url.pathname === "/favicon.svg" && req.method === "GET") serveFavicon(res);
      else if (url.pathname === "/favicon.ico" && req.method === "GET") serveFavicon(res);
      else if (url.pathname === "/api/chat" && req.method === "POST") await handleChat(req, res, ctx);
      else if (url.pathname === "/api/agents" && req.method === "GET") handleAgents(res, ctx);
      else if (url.pathname === "/api/status" && req.method === "GET") handleStatus(res, ctx);
      else if (url.pathname.startsWith("/api/")) res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      else serveUI(res);
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) })); }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const shown = loopbackOnly ? "localhost" : host;
      console.log(`\n  水墨气象台  ·  Skyloom\n  http://${shown}:${port}${loopbackOnly ? "  (仅本机 · 设 SKYLOOM_WEB_HOST=0.0.0.0 可对外开放)" : "  ⚠ 已对外开放 · 无鉴权"}\n`);
      resolve();
    });
  });
}

async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: ReturnType<typeof createSystemContext>) {
  const buffers: Buffer[] = [];
  for await (const chunk of req) buffers.push(chunk as Buffer);
  const { message, agent: agentName = "fog" } = JSON.parse(Buffer.concat(buffers).toString("utf-8"));
  if (!message) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "message is required" })); return; }
  const agent = ctx.agentMap.get(agentName);
  if (!agent) { res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `Agent '${agentName}' not found` })); return; }
  await agent.init();

  // Cancel agent work when the client disconnects (stop button / closed tab).
  // Without this the agent kept running tool rounds into a dead socket.
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  // Real streaming over SSE — tokens, reasoning, and tool events as they happen.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (ev: Record<string, unknown>) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  try {
    for await (const ev of agent.chatStream(message, ac.signal)) send(ev as Record<string, unknown>);
  } catch (e) {
    send({ type: "error", text: String(e) });
  }
  send({ type: "end" });
  res.end();
}

function handleAgents(res: ServerResponse, ctx: ReturnType<typeof createSystemContext>) {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    agents: [...ctx.agentMap.entries()].map(([n, a]) => ({ name: n, displayName: a.displayName, emoji: a.emoji, specialty: a.specialty, state: a.state })),
  }));
}
function handleStatus(res: ServerResponse, ctx: ReturnType<typeof createSystemContext>) {
  const s: Record<string, any> = {}; for (const [n, a] of ctx.agentMap) s[n] = a.getStatus();
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ agents: s, workspace: ctx.workspacePath }));
}

function serveUI(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderInkWashUI());
}

function serveFavicon(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": "no-cache, max-age=0",
  });
  res.end(SKYLOOM_FAVICON_SVG);
}
