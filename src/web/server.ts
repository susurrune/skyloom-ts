/**
 * Web server for Skyloom — HTTP API + 水墨气象台 chat UI.
 *
 * The UI assets live under src/web/ui/; this file is the transport: security
 * guards, SSE streaming, static asset serving, and the small JSON API.
 */

import { createServer, IncomingMessage, ServerResponse, type Server } from "http";
import { createHash } from "crypto";
import { AgentState, type BaseAgent } from "../core/agent";
import { createSystemContext } from "../core/factory";
import { buildRuntimeStatus } from "../core/status";
import { buildWebHealth } from "./health";
import {
  readWebAsset,
  readWebAssetBuffer,
  renderInkWashAppJS,
  renderInkWashCSS,
  renderInkWashUI,
  SKYLOOM_FAVICON_PNG,
} from "./ui";
import { applyWebSettings, buildWebSettings, WebSettingsError } from "./settings";
import { makeApiError, sendApiError, sendJson, sendUnknownError, WebApiError } from "./errors";

const MAX_CHAT_BODY_BYTES = 1024 * 1024;
type SystemContext = ReturnType<typeof createSystemContext>;

function payloadTooLargeError(): WebApiError {
  return makeApiError(413, "web.payload_too_large", "request body too large", {
    retryable: false,
    action: "缩短消息或拆成多次发送。",
  });
}

function agentNotFoundError(agentName: string): WebApiError {
  return makeApiError(404, "web.agent_not_found", `Agent '${agentName}' not found`, { retryable: false });
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%")[0];
  return normalized === "::1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.");
}

/* ──────────────────────────────────────────────
   Server
   ────────────────────────────────────────────── */
export async function startWebServer(
  port: number = 7777,
  contextOverride?: SystemContext,
  options: { configDir?: string } = {},
): Promise<Server> {
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
      sendApiError(res, makeApiError(403, "web.forbidden_host", "Forbidden host", {
        retryable: false,
        action: "请使用 localhost、127.0.0.1 或当前 Skyloom Web 页面访问。",
      }));
      return;
    }
    if (!sameOriginAllowed(req.headers.origin)) {
      sendApiError(res, makeApiError(403, "web.forbidden_origin", "Forbidden origin", {
        retryable: false,
        action: "请从当前 Skyloom Web 页面发起请求，或检查浏览器来源。",
      }));
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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    try {
      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") serveUI(res);
      else if (url.pathname === "/favicon.svg" && req.method === "GET") serveFavicon(req, res);
      else if (url.pathname === "/favicon.ico" && req.method === "GET") serveFavicon(req, res);
      else if (url.pathname === "/ui/styles.css" && req.method === "GET") serveCSS(req, res);
      else if (url.pathname === "/ui/app.js" && req.method === "GET") serveAppJS(req, res);
      else if (url.pathname.startsWith("/ui/assets/") && req.method === "GET") serveUiAsset(req, url.pathname, res);
      else if (url.pathname === "/api/chat" && req.method === "POST") await handleChat(req, res, ctx);
      else if (url.pathname === "/api/session" && req.method === "POST") await handleNewSession(req, res, ctx);
      else if (url.pathname === "/api/session" && req.method === "DELETE") await handleDeleteSession(req, res, ctx);
      else if (url.pathname === "/api/session/load" && req.method === "POST") await handleLoadSession(req, res, ctx);
      else if (url.pathname === "/api/sessions" && req.method === "GET") await handleSessions(url, res, ctx);
      else if (url.pathname === "/api/history" && req.method === "GET") await handleHistory(url, res, ctx);
      else if (url.pathname === "/api/agents" && req.method === "GET") handleAgents(res, ctx);
      else if (url.pathname === "/api/status" && req.method === "GET") handleStatus(res, ctx);
      else if (url.pathname === "/api/health" && req.method === "GET") await handleHealth(res, ctx);
      else if (url.pathname === "/api/settings" && req.method === "GET") handleGetSettings(res, ctx);
      else if (url.pathname === "/api/settings" && req.method === "PATCH") {
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          sendApiError(res, makeApiError(403, "web.settings_remote_forbidden", "Settings can only be changed from this machine", {
            retryable: false,
            action: "请在运行 sky web 的本机浏览器中修改设置。",
          }));
          return;
        }
        await handlePatchSettings(req, res, ctx, options.configDir);
      }
      else if (url.pathname.startsWith("/api/")) sendApiError(res, makeApiError(404, "web.not_found", "Not found", { retryable: false }));
      else serveUI(res);
    } catch (e) {
      if (e instanceof WebApiError) sendApiError(res, e);
      else sendUnknownError(res, e);
    }
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
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHAT_BODY_BYTES) {
    sendApiError(res, payloadTooLargeError());
    return null;
  }
  const buffers: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_CHAT_BODY_BYTES) {
      sendApiError(res, payloadTooLargeError());
      return null;
    }
    buffers.push(buf);
  }
  try {
    const raw = Buffer.concat(buffers).toString("utf-8").trim();
    const payload = raw ? JSON.parse(raw) : {};
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      sendApiError(res, makeApiError(400, "web.bad_request", "JSON body must be an object", { retryable: false }));
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    sendApiError(res, makeApiError(400, "web.invalid_json", "invalid JSON", {
      retryable: false,
      action: "发送有效的 JSON 对象。",
    }));
    return null;
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse, ctx: SystemContext) {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const { message, agent: agentName = "fog", sessionId } = payload;
  if (!message) { sendApiError(res, makeApiError(400, "web.bad_request", "message is required", { retryable: false })); return; }
  if (typeof message !== "string") { sendApiError(res, makeApiError(400, "web.bad_request", "message must be a string", { retryable: false })); return; }
  if (typeof agentName !== "string") { sendApiError(res, makeApiError(400, "web.bad_request", "agent must be a string", { retryable: false })); return; }
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) {
    sendApiError(res, makeApiError(400, "web.bad_request", "sessionId must be a non-empty string", { retryable: false })); return;
  }
  const agent = ctx.agentMap.get(agentName);
  if (!agent) { sendApiError(res, agentNotFoundError(agentName)); return; }
  await agent.init();
  if (agent.state !== AgentState.IDLE && agent.state !== AgentState.ERROR) {
    sendApiError(res, makeApiError(409, "web.agent_busy", "agent is busy", { retryable: true }));
    return;
  }
  if (typeof sessionId === "string") {
    const sessionExists = (agent.memory as unknown as { sessionExists?: (id: string) => Promise<boolean> }).sessionExists;
    if (sessionExists && !await sessionExists.call(agent.memory, sessionId)) {
      sendApiError(res, makeApiError(404, "web.session_not_found", "session not found", {
        retryable: false,
        action: "请在历史会话中重新选择，或点击新会话开始一段新的对话。",
      }));
      return;
    }
  }

  // Cancel agent work when the client disconnects (stop button / closed tab).
  // Without this the agent kept running tool rounds into a dead socket.
  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  // Real streaming over SSE — tokens, reasoning, and tool events as they happen.
  const responseSessionId = typeof sessionId === "string"
    ? sessionId
    : agent.memory.getActiveSession();
  const streamHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Expose-Headers": "X-Skyloom-Session-Id",
  };
  if (responseSessionId) streamHeaders["X-Skyloom-Session-Id"] = responseSessionId;
  res.writeHead(200, streamHeaders);
  const send = (ev: Record<string, unknown>) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  try {
    const stream = typeof sessionId === "string"
      ? agent.chatStreamInSession(sessionId, message, ac.signal)
      : agent.chatStream(message, ac.signal);
    for await (const ev of stream) send(ev as Record<string, unknown>);
  } catch (error) {
    const apiError = makeApiError(500, "web.chat_failed", error instanceof Error ? error.message : String(error), {
      retryable: true,
      action: "重试当前消息；如果持续失败，请打开健康中心查看模型、凭据与工具状态。",
    });
    send({ type: "error", text: apiError.payload.message, error: apiError.payload });
  }
  send({ type: "end" });
  res.end();
}

async function handleNewSession(req: IncomingMessage, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const agentName = payload.agent ?? "fog";
  if (typeof agentName !== "string") {
    sendApiError(res, makeApiError(400, "web.bad_request", "agent must be a string", { retryable: false }));
    return;
  }
  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    sendApiError(res, agentNotFoundError(agentName));
    return;
  }
  await agent.init();
  if (agent.state !== AgentState.IDLE && agent.state !== AgentState.ERROR) {
    sendApiError(res, makeApiError(409, "web.agent_busy", "agent is busy", { retryable: true }));
    return;
  }
  const sessionId = await agent.memory.createSession();
  sendJson(res, 200, { sessionId });
}

async function getIdleAgent(agentName: string, res: ServerResponse, ctx: SystemContext): Promise<BaseAgent | null> {
  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    sendApiError(res, agentNotFoundError(agentName));
    return null;
  }
  await agent.init();
  if (agent.state !== AgentState.IDLE && agent.state !== AgentState.ERROR) {
    sendApiError(res, makeApiError(409, "web.agent_busy", "agent is busy", { retryable: true }));
    return null;
  }
  return agent;
}

async function handleSessions(url: URL, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const agent = await getIdleAgent(url.searchParams.get("agent") || "fog", res, ctx);
  if (!agent) return;
  const sessions = await agent.memory.listSessions();
  sendJson(res, 200, {
    activeSessionId: agent.memory.getActiveSession(),
    sessions,
  });
}

async function handleLoadSession(req: IncomingMessage, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const agentName = payload.agent ?? "fog";
  const sessionId = payload.sessionId;
  if (typeof agentName !== "string" || typeof sessionId !== "string" || !sessionId.trim()) {
    sendApiError(res, makeApiError(400, "web.bad_request", "agent and sessionId must be strings", { retryable: false }));
    return;
  }
  const agent = await getIdleAgent(agentName, res, ctx);
  if (!agent) return;
  if (!await agent.memory.loadSession(sessionId)) {
    sendApiError(res, makeApiError(404, "web.session_not_found", "session not found", { retryable: false }));
    return;
  }
  sendJson(res, 200, { sessionId });
}

async function handleDeleteSession(req: IncomingMessage, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  const agentName = payload.agent ?? "fog";
  const sessionId = payload.sessionId;
  if (typeof agentName !== "string" || typeof sessionId !== "string" || !sessionId.trim()) {
    sendApiError(res, makeApiError(400, "web.bad_request", "agent and sessionId must be strings", { retryable: false }));
    return;
  }
  const agent = await getIdleAgent(agentName, res, ctx);
  if (!agent) return;
  const wasActive = agent.memory.getActiveSession() === sessionId;
  if (!await agent.memory.deleteSession(sessionId)) {
    sendApiError(res, makeApiError(404, "web.session_not_found", "session not found", { retryable: false }));
    return;
  }
  const activeSessionId = wasActive
    ? await agent.memory.createSession()
    : agent.memory.getActiveSession();
  sendJson(res, 200, {
    deleted: true,
    sessionId: activeSessionId,
  });
}

async function handleHistory(url: URL, res: ServerResponse, ctx: SystemContext): Promise<void> {
  const agentName = url.searchParams.get("agent") || "fog";
  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    sendApiError(res, agentNotFoundError(agentName));
    return;
  }
  await agent.init();
  if (agent.state !== AgentState.IDLE && agent.state !== AgentState.ERROR) {
    sendApiError(res, makeApiError(409, "web.agent_busy", "agent is busy", { retryable: true }));
    return;
  }
  const messages = agent.memory.getMessages()
    .filter((message: Record<string, unknown>) => {
      if (message.role === "user") return typeof message.content === "string";
      if (message.role !== "assistant" || typeof message.content !== "string") return false;
      return !Array.isArray(message.toolCalls) || message.toolCalls.length === 0;
    })
    .map((message: Record<string, unknown>) => ({ role: message.role, content: message.content }));
  sendJson(res, 200, {
    sessionId: agent.memory.getActiveSession(),
    messages,
  });
}

function handleAgents(res: ServerResponse, ctx: SystemContext) {
  sendJson(res, 200, {
    agents: [...ctx.agentMap.entries()].map(([n, a]) => ({ name: n, displayName: a.displayName, emoji: a.emoji, specialty: a.specialty, state: a.state })),
  });
}
function handleStatus(res: ServerResponse, ctx: SystemContext) {
  sendJson(res, 200, buildRuntimeStatus(ctx));
}

async function handleHealth(res: ServerResponse, ctx: SystemContext): Promise<void> {
  sendJson(res, 200, await buildWebHealth(ctx));
}

function handleGetSettings(res: ServerResponse, ctx: SystemContext): void {
  sendJson(res, 200, buildWebSettings(ctx));
}

async function handlePatchSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SystemContext,
  configDir?: string,
): Promise<void> {
  const payload = await readJsonBody(req, res);
  if (!payload) return;
  try {
    const settings = applyWebSettings(ctx, payload, { configDir });
    sendJson(res, 200, settings);
  } catch (error) {
    if (error instanceof WebSettingsError) {
      sendApiError(res, makeApiError(400, "web.settings_invalid", error.message, { retryable: false }));
      return;
    }
    throw error;
  }
}

function serveUI(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderInkWashUI());
}

function serveCSS(req: IncomingMessage, res: ServerResponse): void {
  serveStaticResource(req, res, {
    content: renderInkWashCSS(),
    contentType: "text/css; charset=utf-8",
    cacheControl: "no-cache, max-age=0, must-revalidate",
  });
}

function serveAppJS(req: IncomingMessage, res: ServerResponse): void {
  serveStaticResource(req, res, {
    content: renderInkWashAppJS(),
    contentType: "application/javascript; charset=utf-8",
    cacheControl: "no-cache, max-age=0, must-revalidate",
  });
}

function serveFavicon(req: IncomingMessage, res: ServerResponse): void {
  serveStaticResource(req, res, {
    content: SKYLOOM_FAVICON_PNG,
    contentType: "image/png",
    cacheControl: "public, max-age=31536000, immutable",
  });
}

function serveUiAsset(req: IncomingMessage, pathname: string, res: ServerResponse): void {
  const name = pathname.slice("/ui/assets/".length);
  if (!/^[a-z0-9._-]+$/i.test(name)) {
    sendApiError(res, makeApiError(404, "web.asset_not_found", "Not found", { retryable: false }));
    return;
  }
  try {
    serveStaticResource(req, res, {
      content: name.endsWith(".png") ? readWebAssetBuffer(`assets/${name}`) : readWebAsset(`assets/${name}`),
      contentType: contentType(name),
      cacheControl: name.endsWith(".png")
        ? "public, max-age=31536000, immutable"
        : "no-cache, max-age=0, must-revalidate",
    });
  } catch {
    sendApiError(res, makeApiError(404, "web.asset_not_found", "Not found", { retryable: false }));
  }
}

function serveStaticResource(
  req: IncomingMessage,
  res: ServerResponse,
  options: { content: string | Buffer; contentType: string; cacheControl: string },
): void {
  const body = Buffer.isBuffer(options.content) ? options.content : Buffer.from(options.content, "utf8");
  const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
  const headers = {
    "Content-Type": options.contentType,
    "Cache-Control": options.cacheControl,
    "ETag": etag,
  };
  if (matchesIfNoneMatch(req.headers["if-none-match"], etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Length": String(body.length) });
  res.end(body);
}

function matchesIfNoneMatch(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (!raw) return false;
  return raw.split(",").map((part) => part.trim()).includes(etag);
}

function contentType(name: string): string {
  if (name.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}
