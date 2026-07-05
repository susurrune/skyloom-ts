/**
 * Web server for Skyloom — HTTP API + 水墨气象台 chat UI.
 *
 * The UI assets live under src/web/ui/; this file is the transport: security
 * guards, SSE streaming, static asset serving, and the small JSON API.
 */

import { createServer, IncomingMessage, ServerResponse, type Server } from "http";
import { AgentState, type BaseAgent } from "../core/agent";
import { createSystemContext } from "../core/factory";
import { buildRuntimeStatus } from "../core/status";
import {
  readWebAsset,
  readWebAssetBuffer,
  renderInkWashAppJS,
  renderInkWashCSS,
  renderInkWashUI,
  SKYLOOM_FAVICON_PNG,
} from "./ui";

const MAX_CHAT_BODY_BYTES = 1024 * 1024;
type SystemContext = ReturnType<typeof createSystemContext>;

/* ──────────────────────────────────────────────
   Server
   ────────────────────────────────────────────── */
export async function startWebServer(port: number = 7777, contextOverride?: SystemContext): Promise<Server> {
  const ctx = contextOverride ?? createSystemContext();

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
    const raw = (h || "").toLowerCase();
    const name = raw.startsWith("[")
      ? raw.slice(0, raw.indexOf("]") + 1)
      : raw.split(":")[0];
    return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1" || name === "";
  };

  const sameOriginAllowed = (origin: string | undefined): boolean => {
    if (!loopbackOnly || !origin) return true;
    try {
      const u = new URL(origin);
      const hostname = u.hostname.toLowerCase();
      const reqPort = u.port || (u.protocol === "https:" ? "443" : "80");
      return u.protocol === "http:" &&
        reqPort === String(port) &&
        (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1");
    } catch {
      return false;
    }
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Forbidden host" }));
      return;
    }
    if (!sameOriginAllowed(req.headers.origin)) {
      res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Forbidden origin" }));
      return;
    }
    // Same-origin only when loopback-bound (no wildcard CORS that would invite
    // cross-site requests to a credential-less, tool-executing endpoint).
    if (loopbackOnly) {
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin || `http://${req.headers.host || `localhost:${port}`}`);
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
      else if (url.pathname === "/ui/styles.css" && req.method === "GET") serveCSS(res);
      else if (url.pathname === "/ui/app.js" && req.method === "GET") serveAppJS(res);
      else if (url.pathname.startsWith("/ui/assets/") && req.method === "GET") serveUiAsset(url.pathname, res);
      else if (url.pathname === "/api/chat" && req.method === "POST") await handleChat(req, res, ctx);
      else if (url.pathname === "/api/session" && req.method === "POST") await handleNewSession(req, res, ctx);
      else if (url.pathname === "/api/session" && req.method === "DELETE") await handleDeleteSession(req, res, ctx);
      else if (url.pathname === "/api/session/load" && req.method === "POST") await handleLoadSession(req, res, ctx);
      else if (url.pathname === "/api/sessions" && req.method === "GET") await handleSessions(url, res, ctx);
      else if (url.pathname === "/api/history" && req.method === "GET") await handleHistory(url, res, ctx);
      else if (url.pathname === "/api/agents" && req.method === "GET") handleAgents(res, ctx);
      else if (url.pathname === "/api/status" && req.method === "GET") handleStatus(res, ctx);
      else if (url.pathname.startsWith("/api/")) res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      else serveUI(res);
    } catch (e) { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e) })); }
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      const shown = loopbackOnly ? "localhost" : host;
      console.log(`\n  水墨气象台  ·  Skyloom\n  http://${shown}:${port}${loopbackOnly ? "  (仅本机 · 设 SKYLOOM_WEB_HOST=0.0.0.0 可对外开放)" : "  ⚠ 已对外开放 · 无鉴权"}\n`);
      resolve(server);
    });
  });
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const buffers: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_CHAT_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "request body too large" }));
      return null;
    }
    buffers.push(buf);
  }
  try {
    const raw = Buffer.concat(buffers).toString("utf-8").trim();
    const payload = raw ? JSON.parse(raw) : {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "JSON body must be an object" }));
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid JSON" }));
    return null;
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: SystemContext) {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const { message, agent: agentName = "fog", sessionId } = payload;
  if (!message) { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "message is required" })); return; }
  if (typeof message !== "string") { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "message must be a string" })); return; }
  if (typeof agentName !== "string") { res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "agent must be a string" })); return; }
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "sessionId must be a non-empty string" })); return;
  }
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
    const stream = typeof sessionId === "string"
      ? agent.chatStreamInSession(sessionId, message, ac.signal)
      : agent.chatStream(message, ac.signal);
    for await (const ev of stream) send(ev as Record<string, unknown>);
  } catch (e) {
    send({ type: "error", text: String(e) });
  }
  send({ type: "end" });
  res.end();
}

async function handleNewSession(req: IncomingMessage, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const agentName = payload.agent ?? "fog";
  if (typeof agentName !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "agent must be a string" }));
    return;
  }
  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `Agent '${agentName}' not found` }));
    return;
  }
  await agent.init();
  if (agent.state !== AgentState.IDLE && agent.state !== AgentState.ERROR) {
    res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "agent is busy" }));
    return;
  }
  const sessionId = await agent.memory.createSession();
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ sessionId }));
}

async function getIdleAgent(agentName: string, res: ServerResponse, ctx: SystemContext): Promise<BaseAgent | null> {
  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `Agent '${agentName}' not found` }));
    return null;
  }
  await agent.init();
  if (agent.state !== AgentState.IDLE && agent.state !== AgentState.ERROR) {
    res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "agent is busy" }));
    return null;
  }
  return agent;
}

async function handleSessions(url: URL, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const agent = await getIdleAgent(url.searchParams.get("agent") || "fog", res, ctx);
  if (!agent) return;
  const sessions = await agent.memory.listSessions();
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    activeSessionId: agent.memory.getActiveSession(),
    sessions,
  }));
}

async function handleLoadSession(req: IncomingMessage, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const agentName = payload.agent ?? "fog";
  const sessionId = payload.sessionId;
  if (typeof agentName !== "string" || typeof sessionId !== "string" || !sessionId.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "agent and sessionId must be strings" }));
    return;
  }
  const agent = await getIdleAgent(agentName, res, ctx);
  if (!agent) return;
  if (!await agent.memory.loadSession(sessionId)) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "session not found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ sessionId }));
}

async function handleDeleteSession(req: IncomingMessage, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const agentName = payload.agent ?? "fog";
  const sessionId = payload.sessionId;
  if (typeof agentName !== "string" || typeof sessionId !== "string" || !sessionId.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "agent and sessionId must be strings" }));
    return;
  }
  const agent = await getIdleAgent(agentName, res, ctx);
  if (!agent) return;
  const wasActive = agent.memory.getActiveSession() === sessionId;
  if (!await agent.memory.deleteSession(sessionId)) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "session not found" }));
    return;
  }
  const activeSessionId = wasActive
    ? await agent.memory.createSession()
    : agent.memory.getActiveSession();
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    deleted: true,
    sessionId: activeSessionId,
  }));
}

async function handleHistory(url: URL, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const agentName = url.searchParams.get("agent") || "fog";
  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `Agent '${agentName}' not found` }));
    return;
  }
  await agent.init();
  if (agent.state !== AgentState.IDLE && agent.state !== AgentState.ERROR) {
    res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "agent is busy" }));
    return;
  }
  const messages = agent.memory.getMessages()
    .filter((message: Record<string, unknown>) => {
      if (message.role === "user") return typeof message.content === "string";
      if (message.role !== "assistant" || typeof message.content !== "string") return false;
      return !Array.isArray(message.toolCalls) || message.toolCalls.length === 0;
    })
    .map((message: Record<string, unknown>) => ({ role: message.role, content: message.content }));
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    sessionId: agent.memory.getActiveSession(),
    messages,
  }));
}

function handleAgents(res: ServerResponse, ctx: SystemContext) {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
    agents: [...ctx.agentMap.entries()].map(([n, a]) => ({ name: n, displayName: a.displayName, emoji: a.emoji, specialty: a.specialty, state: a.state })),
  }));
}
function handleStatus(res: ServerResponse, ctx: SystemContext) {
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(buildRuntimeStatus(ctx)));
}

function serveUI(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderInkWashUI());
}

function serveCSS(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": "no-cache, max-age=0",
  });
  res.end(renderInkWashCSS());
}

function serveAppJS(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache, max-age=0",
  });
  res.end(renderInkWashAppJS());
}

function serveFavicon(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Cache-Control": "no-cache, max-age=0",
  });
  res.end(SKYLOOM_FAVICON_PNG);
}

function serveUiAsset(pathname: string, res: ServerResponse): void {
  const name = pathname.slice("/ui/assets/".length);
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
    return;
  }
  try {
    res.writeHead(200, {
      "Content-Type": contentType(name),
      "Cache-Control": "no-cache, max-age=0",
    });
    res.end(name.endsWith(".png") ? readWebAssetBuffer(`assets/${name}`) : readWebAsset(`assets/${name}`));
  } catch {
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
  }
}

function contentType(name: string): string {
  if (name.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}
