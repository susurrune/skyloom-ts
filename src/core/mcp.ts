/**
 * MCP (Model Context Protocol) client — Anthropic-compatible transport.
 *
 * Implements the MCP 2025-03-26 specification with two transports:
 * - stdio: subprocess-based with JSON-RPC over stdin/stdout
 * - SSE: text/event-stream via HTTP/fetch with jsonrpc POST endpoint
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";
import type { Logger } from "./logger";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "skyloom", version: "1.0.0" };

/**
 * MCP server configuration.
 */
export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled?: boolean;
}

/**
 * MCP tool definition from server.
 */
export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export type MCPHealthState = "configured" | "connected" | "healthy" | "unhealthy" | "disconnected";

export interface MCPServerHealth {
  name: string;
  transport: "stdio" | "sse";
  target: string;
  tools: number;
  connected: boolean;
  state: MCPHealthState;
  healthy: boolean | null;
  details: string;
  lastCheckedAt: string | null;
  connectedAt: string | null;
}

export function formatMcpHealthLines(health: MCPServerHealth[], fallback: string[] = []): string[] {
  if (health.length === 0) {
    return fallback.length > 0 ? fallback : ["none"];
  }

  return health.map((server) => {
    const mark = server.state === "healthy" ? "[ok]"
      : server.state === "connected" ? "[up]"
        : server.state === "unhealthy" ? "[bad]"
          : "[off]";
    const target = server.target ? ` | ${server.target}` : "";
    const details = server.details && server.details !== "connected" ? ` | ${server.details}` : "";
    return `${mark} ${server.name} | ${server.transport} | ${server.state} | ${server.tools} tools${target}${details}`;
  });
}

/**
 * JSON-RPC 2.0 request/response.
 */
interface JsonRpcMessage {
  jsonrpc: string;
  method?: string;
  params?: Record<string, any>;
  id?: number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * Client for connecting to a single MCP server.
 *
 * Supports both stdio (subprocess) and SSE (text/event-stream) transports.
 * Uses JSON-RPC 2.0 with id-based correlation for concurrent requests.
 */
export class MCPClient {
  private config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private serverTools: MCPToolDef[] = [];
  private nextId: number = 0;
  private pending: Map<number, {
    resolve: (value: JsonRpcMessage) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = new Map();
  private log: Logger | null = null;
  private connectedAt: string | null = null;
  private lastHealth: { healthy: boolean; details: string; checkedAt: string } | null = null;
  private lastError: string = "";

  // SSE-specific state
  private sseResponse: any = null;
  private sseAbort: AbortController | null = null;
  private sseMessageUrl: string = "";
  private sseEndpointResolver: (() => void) | null = null;

  constructor(config: MCPServerConfig, log?: Logger | null) {
    this.config = config;
    this.log = log || null;
  }

  /**
   * Generate next request ID.
   */
  private newId(): number {
    return ++this.nextId;
  }

  /**
   * Connect to the MCP server and list available tools.
   */
  async initialize(): Promise<MCPToolDef[]> {
    try {
      this.lastError = "";
      if (this.config.command) {
        const tools = await this.initStdio();
        this.markInitialized(tools);
        return tools;
      } else if (this.config.url) {
        const tools = await this.initSSE();
        this.markInitialized(tools);
        return tools;
      }
    } catch (e) {
      this.lastError = String(e);
      this.log?.warn("mcp_server_unavailable", {
        server: this.config.name,
        error: String(e),
      });
    }
    return [];
  }

  /**
   * Perform a health check on the MCP connection.
   */
  async healthCheck(): Promise<{ healthy: boolean; details: string }> {
    let health: { healthy: boolean; details: string };
    if (this.config.command) {
      health = await this.healthStdio();
    } else if (this.config.url) {
      health = await this.healthSSE();
    } else {
      health = { healthy: false, details: "No transport configured" };
    }

    this.lastHealth = { ...health, checkedAt: new Date().toISOString() };
    if (!health.healthy) {
      this.lastError = health.details;
    }
    return health;
  }

  /**
   * Return a synchronous, non-blocking health snapshot for status UIs.
   */
  getHealthSnapshot(toolCount?: number): MCPServerHealth {
    const connected = this.isTransportConnected();
    const health = this.lastHealth;
    const healthy = connected ? health?.healthy ?? null : false;
    let state: MCPHealthState = connected ? "connected" : "disconnected";
    if (connected && health?.healthy === true) state = "healthy";
    if (connected && health?.healthy === false) state = "unhealthy";

    return {
      name: this.config.name,
      transport: this.config.command ? "stdio" : "sse",
      target: this.config.command || this.config.url || "",
      tools: toolCount ?? this.serverTools.length,
      connected,
      state,
      healthy,
      details: health?.details || this.lastError || (connected ? "connected" : "not connected"),
      lastCheckedAt: health?.checkedAt || null,
      connectedAt: this.connectedAt,
    };
  }

  private markInitialized(tools: MCPToolDef[]): void {
    if (tools.length > 0) {
      this.connectedAt = new Date().toISOString();
      this.lastError = "";
    }
  }

  private isTransportConnected(): boolean {
    if (this.config.command) {
      return Boolean(this.process && this.process.exitCode === null);
    }
    if (this.config.url) {
      return Boolean(this.sseMessageUrl && this.sseResponse);
    }
    return false;
  }

  /**
   * Initialize stdio transport.
   */
  private async initStdio(): Promise<MCPToolDef[]> {
    const cmd = this.config.command;
    if (!cmd) {
      return [];
    }

    const env = {
      ...process.env,
      ...(this.config.env || {}),
    };

    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(cmd, this.config.args || [], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (!this.process) {
          return resolve([]);
        }

        // Start background reading tasks
        this.readStdioLoop();
        this.drainStderr();

        // Send initialize request
        this.requestStdio("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        }).then((initResp) => {
          if (!initResp || initResp.error) {
            resolve([]);
            return null;
          }

          // Send initialized notification
          this.sendJson({
            jsonrpc: "2.0",
            method: "notifications/initialized",
            params: {},
          }).catch(() => {});

          // Request tool list
          return this.requestStdio("tools/list", {});
        }).then((toolsResp) => {
            if (toolsResp && toolsResp.result) {
              this.serverTools = toolsResp.result.tools || [];
            }
            resolve(this.serverTools);
          })
          .catch((err) => {
            this.log?.warn("mcp_stdio_init_failed", {
              server: this.config.name,
              error: String(err),
            });
            this.close().catch(() => {});
            resolve([]);
          });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Initialize SSE transport.
   *
   * Opens a persistent `text/event-stream` GET to the configured URL. The
   * server first emits an `endpoint` event carrying the URL to POST JSON-RPC
   * messages to; subsequent `message` events carry responses/notifications,
   * which are correlated against `this.pending` by request id (same path the
   * stdio loop uses). Once the endpoint is known we run the standard
   * initialize → initialized → tools/list handshake.
   */
  private async initSSE(): Promise<MCPToolDef[]> {
    const url = this.config.url;
    if (!url) {
      return [];
    }

    // Wait for the server to advertise its message endpoint before we can POST.
    const endpointReady = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SSE endpoint handshake timeout")),
        10000
      );
      this.sseEndpointResolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    try {
      await this.openSSEStream(url);
      await endpointReady;
    } catch (e) {
      this.log?.warn("mcp_sse_connect_failed", {
        server: this.config.name,
        error: String(e),
      });
      await this.close().catch(() => {});
      return [];
    }

    try {
      const initResp = await this.requestSSE("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      if (!initResp || initResp.error) {
        return [];
      }

      // Fire-and-forget the initialized notification (no id → no response).
      this.postJson({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }).catch(() => {});

      const toolsResp = await this.requestSSE("tools/list", {});
      if (toolsResp && toolsResp.result) {
        this.serverTools = toolsResp.result.tools || [];
      }
      return this.serverTools;
    } catch (err) {
      this.log?.warn("mcp_sse_init_failed", {
        server: this.config.name,
        error: String(err),
      });
      await this.close().catch(() => {});
      return [];
    }
  }

  /**
   * Open the SSE stream and dispatch parsed events. Resolves once the HTTP
   * connection is established (not when it closes).
   */
  private async openSSEStream(url: string): Promise<void> {
    const controller = new AbortController();
    this.sseAbort = controller;

    const resp = await axios.get(url, {
      responseType: "stream",
      signal: controller.signal,
      headers: {
        Accept: "text/event-stream",
        ...(this.config.env || {}),
      },
      timeout: 0,
    });
    this.sseResponse = resp.data;

    let buffer = "";
    resp.data.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      // SSE events are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        this.handleSSEEvent(rawEvent, url);
      }
    });

    resp.data.on("end", () => this.failPendingSSE("MCP SSE stream closed"));
    resp.data.on("error", (err: Error) =>
      this.failPendingSSE(`MCP SSE stream error: ${err.message}`)
    );
  }

  /**
   * Parse one raw SSE event block (`event:`/`data:` lines) and dispatch it.
   */
  private handleSSEEvent(rawEvent: string, baseUrl: string): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const data = dataLines.join("\n");
    if (!data) {
      return;
    }

    if (eventName === "endpoint") {
      // `data` is the (possibly relative) URL to POST messages to.
      try {
        this.sseMessageUrl = new URL(data, baseUrl).toString();
      } catch {
        this.sseMessageUrl = data;
      }
      this.sseEndpointResolver?.();
      this.sseEndpointResolver = null;
      return;
    }

    // event: message (or default) — a JSON-RPC response/notification.
    const msg = this.parseJsonLine(data);
    if (!msg) {
      return;
    }
    const msgId = msg.id;
    if (msgId === undefined || msgId === null) {
      return;
    }
    const pending = this.pending.get(msgId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(msg);
      this.pending.delete(msgId);
    }
  }

  /**
   * Reject every in-flight SSE request (stream closed or errored).
   */
  private failPendingSSE(reason: string): void {
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /**
   * Health check via stdio.
   */
  private async healthStdio(): Promise<{ healthy: boolean; details: string }> {
    if (!this.process || this.process.exitCode !== null) {
      return { healthy: false, details: "stdio process not running" };
    }

    try {
      const resp = await this.requestStdio("ping", {}, 5000);
      if (resp && resp.result) {
        return { healthy: true, details: "ok" };
      }
      return {
        healthy: false,
        details: `unexpected ping response: ${JSON.stringify(resp)}`,
      };
    } catch (e) {
      return { healthy: false, details: String(e) };
    }
  }

  /**
   * Health check via SSE.
   */
  private async healthSSE(): Promise<{ healthy: boolean; details: string }> {
    if (!this.sseMessageUrl) {
      return {
        healthy: false,
        details: "SSE connection not established",
      };
    }

    try {
      const resp = await this.requestSSE("ping", {}, 5000);
      if (resp && resp.result) {
        return { healthy: true, details: "ok" };
      }
      return {
        healthy: false,
        details: `unexpected ping response: ${JSON.stringify(resp)}`,
      };
    } catch (e) {
      return { healthy: false, details: String(e) };
    }
  }

  /**
   * Background task: read from subprocess stdout.
   */
  private async readStdioLoop(): Promise<void> {
    if (!this.process?.stdout) {
      return;
    }

    try {
      let buffer = "";

      this.process.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");

        // Process complete lines (JSON-RPC messages are newline-delimited)
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n");
          const line = idx >= 0 ? buffer.slice(0, idx) : buffer;
          buffer = idx >= 0 ? buffer.slice(idx + 1) : "";

          const msg = this.parseJsonLine(line);
          if (!msg) {
            continue;
          }

          const msgId = msg.id;
          if (msgId === undefined || msgId === null) {
            continue;
          }

          const pending = this.pending.get(msgId);
          if (pending) {
            clearTimeout(pending.timer);
            pending.resolve(msg);
            this.pending.delete(msgId);
          }
        }
      });

      this.process.stdout.on("end", () => {
        // Fail all pending requests when stdout closes
        for (const [id, { reject, timer }] of this.pending) {
          clearTimeout(timer);
          reject(new Error("MCP server stdout closed"));
          this.pending.delete(id);
        }
      });
    } catch (e) {
      this.log?.warn("mcp_stdio_read_error", {
        server: this.config.name,
        error: String(e),
      });
    }
  }

  /**
   * Background task: drain stderr to prevent blocking.
   */
  private async drainStderr(): Promise<void> {
    if (!this.process?.stderr) {
      return;
    }

    try {
      this.process.stderr.on("data", (chunk: Buffer) => {
        const line = chunk.toString("utf-8", 0, Math.min(100, chunk.length));
        this.log?.debug("mcp_stderr", {
          server: this.config.name,
          line: line.trim(),
        });
      });
    } catch (e) {
      // Ignore stderr drain errors
    }
  }

  /**
   * Send JSON-RPC request via stdio and wait for response.
   */
  private async requestStdio(
    method: string,
    params: Record<string, any>,
    timeoutMs: number = 10000
  ): Promise<JsonRpcMessage | null> {
    if (!this.process?.stdin) {
      return null;
    }

    const reqId = this.newId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.log?.warn("mcp_stdio_timeout", {
          server: this.config.name,
          method,
        });
        reject(new Error("Request timeout"));
      }, timeoutMs);

      this.pending.set(reqId, {
        resolve,
        reject: (err) => {
          reject(err);
        },
        timer,
      });

      this.sendJson({
        jsonrpc: "2.0",
        method,
        params,
        id: reqId,
      }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err);
      });
    });
  }

  /**
   * Send JSON-RPC request via SSE and wait for response.
   */
  private async requestSSE(
    method: string,
    params: Record<string, any>,
    timeoutMs: number = 10000
  ): Promise<JsonRpcMessage | null> {
    const reqId = this.newId();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.log?.warn("mcp_sse_timeout", {
          server: this.config.name,
          method,
        });
        reject(new Error("Request timeout"));
      }, timeoutMs);

      this.pending.set(reqId, {
        resolve,
        reject: (err) => {
          reject(err);
        },
        timer,
      });

      this.postJson({
        jsonrpc: "2.0",
        method,
        params,
        id: reqId,
      }).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err);
      });
    });
  }

  /**
   * Send JSON data via stdin.
   */
  private async sendJson(data: JsonRpcMessage): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error("stdin not available");
    }

    // Serialize to JSON and ensure newline termination
    const line = JSON.stringify(data) + "\n";

    return new Promise((resolve, reject) => {
      this.process!.stdin!.write(line, "utf-8", (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * POST JSON-RPC data to the SSE message endpoint. The actual response
   * arrives asynchronously over the event stream (see handleSSEEvent), so
   * this only confirms the message was accepted by the server.
   */
  private async postJson(data: JsonRpcMessage): Promise<void> {
    if (!this.sseMessageUrl) {
      throw new Error("SSE message URL not set");
    }

    await axios.post(this.sseMessageUrl, data, {
      headers: {
        "Content-Type": "application/json",
        ...(this.config.env || {}),
      },
      timeout: 10000,
    });
  }

  /**
   * Parse a single JSON line.
   */
  private parseJsonLine(line: string): JsonRpcMessage | null {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(
    name: string,
    args: Record<string, any>
  ): Promise<string> {
    let response: JsonRpcMessage | null = null;

    if (this.config.command) {
      response = await this.requestStdio("tools/call", {
        name,
        arguments: args,
      });
    } else if (this.config.url) {
      response = await this.requestSSE("tools/call", {
        name,
        arguments: args,
      });
    }

    if (response && response.result) {
      return this.extractToolResult(response.result);
    }

    const error = response?.error || {};
    return `MCP tool error: ${(error as any).message || "unknown"}`;
  }

  /**
   * Extract text content from MCP tool result.
   */
  private extractToolResult(result: any): string {
    const parts: string[] = [];

    if (Array.isArray(result.content)) {
      for (const item of result.content) {
        if (item.type === "text") {
          parts.push(item.text);
        } else if (item.type === "resource") {
          parts.push(JSON.stringify(item.resource || {}));
        }
      }
    }

    return parts.length > 0 ? parts.join("\n") : "Tool returned no content.";
  }

  /**
   * Get list of tool definitions from server.
   */
  getToolDefinitions(): MCPToolDef[] {
    return [...this.serverTools];
  }

  /**
   * Close the connection and clean up resources.
   */
  async close(): Promise<void> {
    // Cancel pending requests
    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error("Connection closed"));
    }
    this.pending.clear();

    // Terminate subprocess
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
        // Wait for graceful shutdown
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.process?.kill("SIGKILL");
            resolve();
          }, 5000);

          this.process!.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch (e) {
        // Ignore cleanup errors
      }
      this.process = null;
    }

    // Close SSE response if exists
    if (this.sseAbort) {
      try {
        this.sseAbort.abort();
      } catch {
        // Ignore
      }
      this.sseAbort = null;
    }
    if (this.sseResponse) {
      try {
        this.sseResponse.destroy?.();
        await this.sseResponse.close?.();
      } catch {
        // Ignore
      }
      this.sseResponse = null;
    }

    this.sseEndpointResolver = null;
    this.sseMessageUrl = "";
  }
}

/**
 * Manages multiple MCP server connections and registers their tools.
 */
export class MCPManager {
  private toolRegistry: any; // ToolRegistry type
  private clients: Map<string, MCPClient> = new Map();
  private serverConfigs: MCPServerConfig[] = [];
  private serverDiagnostics: Map<string, string> = new Map();
  private agents: Map<string, any> = new Map();
  private log: Logger | null = null;

  constructor(toolRegistry: any, log?: Logger) {
    this.toolRegistry = toolRegistry;
    this.log = log || null;
  }

  /**
   * Bind live agent instances for tool refresh.
   */
  bindAgents(agents: Map<string, any>): void {
    this.agents = agents;
  }

  /**
   * Configure MCP servers from config data.
   */
  configure(servers: MCPServerConfig[]): void {
    this.serverConfigs = servers
      .filter((s) => s.enabled !== false)
      .map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args || [],
        url: s.url,
        env: s.env || {},
        enabled: s.enabled !== false,
      }));
    for (const cfg of this.serverConfigs) {
      if (!this.serverDiagnostics.has(cfg.name)) {
        this.serverDiagnostics.set(cfg.name, "configured");
      }
    }
  }

  /**
   * Connect to all configured MCP servers in parallel.
   * Returns list of "server_name: N tools" status strings.
   */
  async connectAll(): Promise<string[]> {
    const enabled = this.serverConfigs.filter((cfg) => cfg.enabled !== false);

    if (enabled.length === 0) {
      return [];
    }

    // Connect all servers in parallel
    const results = await Promise.all(
      enabled.map(async (cfg) => {
        const client = new MCPClient(cfg, this.log);
        try {
          const tools = await client.initialize();
          if (!tools || tools.length === 0) {
            this.serverDiagnostics.set(cfg.name, "no tools returned or connection failed");
            await client.close().catch(() => {});
            return null;
          }
          return { cfg, client, tools };
        } catch (e) {
          this.serverDiagnostics.set(cfg.name, String(e));
          this.log?.warn("mcp_init_failed", {
            server: cfg.name,
            error: String(e),
          });
          return null;
        }
      })
    );

    // Register tools from successful connections
    const statusLines: string[] = [];
    for (const result of results) {
      if (!result) {
        continue;
      }

      const { cfg, client, tools } = result;
      this.clients.set(cfg.name, client);
      this.serverDiagnostics.delete(cfg.name);
      const count = this.registerMCPTools(cfg.name, tools);
      statusLines.push(`${cfg.name}: ${count} tools`);
    }

    return statusLines;
  }

  /**
   * Register MCP tools into the tool registry and agents.
   */
  private registerMCPTools(
    serverName: string,
    mcpTools: MCPToolDef[]
  ): number {
    let count = 0;

    for (const mt of mcpTools) {
      const name = mt.name;
      const description = mt.description || "";
      const inputSchema = mt.inputSchema || {};

      if (!name) {
        continue;
      }

      // Convert MCP tool schema to internal tool format
      const parameters: any[] = [];
      const props = inputSchema.properties || {};
      const required = inputSchema.required || [];

      for (const [paramName, paramSchema] of Object.entries(props)) {
        parameters.push({
          name: paramName,
          type: (paramSchema as any).type || "string",
          description: (paramSchema as any).description || "",
          required: required.includes(paramName),
        });
      }

      // Create tool wrapper
      const mcpToolName = `mcp_${serverName}_${name}`;
      const tool = {
        name: mcpToolName,
        description: `[MCP/${serverName}] ${description}`,
        parameters,
        handler: this.makeMCPHandler(serverName, name),
      };

      // Register in all registries
      this.toolRegistry.register(tool);

      for (const agent of this.agents.values()) {
        const reg = agent.toolRegistry;
        if (reg) {
          reg.register(tool);
        }
      }

      count++;
    }

    // Refresh agents' tool lists
    for (const agent of this.agents.values()) {
      try {
        agent.refreshTools?.();
      } catch {
        // Ignore refresh errors
      }
    }

    return count;
  }

  /**
   * Create a handler function that calls an MCP tool.
   */
  private makeMCPHandler(
    serverName: string,
    toolName: string
  ): (kwargs: Record<string, any>) => Promise<string> {
    return async (kwargs: Record<string, any>) => {
      const client = this.clients.get(serverName);
      if (!client) {
        return `Error: MCP server '${serverName}' not connected.`;
      }
      return client.callTool(toolName, kwargs);
    };
  }

  /**
   * Add a new MCP server at runtime.
   */
  async addServer(config: MCPServerConfig): Promise<string> {
    const name = config.name?.trim();
    if (!name) {
      return "Error: server name is required";
    }

    if (this.clients.has(name)) {
      return `MCP server '${name}' is already connected`;
    }

    if (!config.command && !config.url) {
      return "Error: provide either 'command' (stdio) or 'url' (SSE)";
    }

    const client = new MCPClient(config, this.log);

    try {
      const tools = await client.initialize();

      if (!tools || tools.length === 0) {
        await client.close();
        this.serverDiagnostics.set(name, "no tools returned or connection failed");
        return `MCP server '${name}' 未返回任何工具`;
      }

      this.clients.set(name, client);
      this.serverDiagnostics.delete(name);
      this.serverConfigs.push(config);

      const count = this.registerMCPTools(name, tools);
      const toolNames = tools
        .slice(0, 10)
        .map((t) => t.name)
        .join(", ");

      return `✓ 已接入 MCP server '${name}'，注册 ${count} 个工具: ${toolNames}`;
    } catch (e) {
      await client.close();
      this.serverDiagnostics.set(name, String(e));
      return `连接 MCP server '${name}' 失败: ${String(e)}`;
    }
  }

  /**
   * Remove an MCP server and unregister its tools.
   */
  async removeServer(name: string): Promise<string> {
    const cleanName = name?.trim();
    const client = this.clients.get(cleanName);

    if (!client) {
      return `未连接 MCP server '${cleanName}'`;
    }

    await client.close();
    this.clients.delete(cleanName);
    this.serverDiagnostics.delete(cleanName);
    this.serverConfigs = this.serverConfigs.filter(
      (c) => c.name !== cleanName
    );

    // Unregister tools
    const prefix = `mcp_${cleanName}_`;
    let removed = 0;

    // Get all tool names with this prefix
    const toolNames = this.toolRegistry.listNames?.() || [];
    for (const toolName of toolNames) {
      if (toolName.startsWith(prefix)) {
        this.toolRegistry.unregister(toolName);

        for (const agent of this.agents.values()) {
          agent.toolRegistry?.unregister(toolName);
        }

        removed++;
      }
    }

    // Refresh agents
    for (const agent of this.agents.values()) {
      try {
        agent.refreshTools?.();
      } catch {
        // Ignore
      }
    }

    return `✓ 已断开 MCP server '${cleanName}'，移除 ${removed} 个工具`;
  }

  /**
   * Get list of connected servers and their tool counts.
   */
  listServers(): Array<{
    name: string;
    transport: string;
    target: string;
    tools: number;
    connected: boolean;
  }> {
    const result = [];

    for (const cfg of this.serverConfigs) {
      const prefix = `mcp_${cfg.name}_`;
      const toolNames = this.toolRegistry.listNames?.() || [];
      const count = toolNames.filter((n: string) => n.startsWith(prefix))
        .length;

      result.push({
        name: cfg.name,
        transport: cfg.command ? "stdio" : "sse",
        target: cfg.command || cfg.url || "",
        tools: count,
        connected: this.clients.has(cfg.name),
      });
    }

    return result;
  }

  /**
   * Synchronous MCP health snapshot for Web, CLI/TUI and doctor surfaces.
   */
  getHealthSnapshot(): MCPServerHealth[] {
    const toolNames = this.toolRegistry.listNames?.() || [];

    return this.serverConfigs.map((cfg) => {
      const prefix = `mcp_${cfg.name}_`;
      const count = toolNames.filter((n: string) => n.startsWith(prefix)).length;
      const client = this.clients.get(cfg.name);
      if (client) {
        return client.getHealthSnapshot(count);
      }

      return {
        name: cfg.name,
        transport: cfg.command ? "stdio" : "sse",
        target: cfg.command || cfg.url || "",
        tools: count,
        connected: false,
        state: "configured",
        healthy: false,
        details: this.serverDiagnostics.get(cfg.name) || "not connected",
        lastCheckedAt: null,
        connectedAt: null,
      };
    });
  }

  /**
   * Close all server connections and clean up.
   */
  async closeAll(): Promise<void> {
    const errors: Array<{ server: string; error: string }> = [];

    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch (e) {
        errors.push({
          server: client["config"]?.name || "unknown",
          error: String(e),
        });
      }
    }

    this.clients.clear();

    // Log any errors that occurred during cleanup
    for (const err of errors) {
      this.log?.warn("mcp_close_failed", {
        server: err.server,
        error: err.error,
      });
    }
  }
}

/**
 * Project-level .mcp.json (Claude Code standard) — drop the same file you
 * use with Claude Code into the repo root and Skyloom picks it up:
 *
 *   { "mcpServers": {
 *       "github": { "type": "http", "url": "https://api.example.com/mcp/" },
 *       "db": { "command": "npx", "args": ["-y", "@x/dbhub"],
 *               "env": { "DB_URL": "${DB_URL}" } } } }
 *
 * `${VAR}` references expand from the environment, so secrets stay out of
 * the committed file.
 */

/** Expand ${VAR} environment references (Claude Code .mcp.json convention). */
export function expandEnvRefs(s: string): string {
  return s.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, v) => process.env[v] ?? '');
}

/** Load and translate <cwd>/.mcp.json into Skyloom server configs. */
export function loadProjectMcpJson(cwd: string = process.cwd()): MCPServerConfig[] {
  const file = path.join(cwd, '.mcp.json');
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const servers = data?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    const out: MCPServerConfig[] = [];
    for (const [name, raw] of Object.entries<any>(servers)) {
      if (!raw || typeof raw !== 'object') continue;
      const cfg: MCPServerConfig = { name, enabled: true };
      if (typeof raw.command === 'string') {
        cfg.command = expandEnvRefs(raw.command);
        if (Array.isArray(raw.args)) cfg.args = raw.args.map((a: any) => expandEnvRefs(String(a)));
      }
      if (typeof raw.url === 'string') cfg.url = expandEnvRefs(raw.url);
      if (raw.env && typeof raw.env === 'object') {
        cfg.env = {};
        for (const [k, v] of Object.entries(raw.env)) cfg.env[k] = expandEnvRefs(String(v));
      }
      if (!cfg.command && !cfg.url) continue; // unsupported transport entry
      out.push(cfg);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Persistence helpers for runtime-added MCP servers.
 */

/**
 * Get path to persisted MCP servers file.
 */
function getPersistPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".skyloom", "mcp_servers.json");
}

/**
 * Load persisted MCP server configs.
 */
export function loadPersistedServers(): MCPServerConfig[] {
  try {
    const persistPath = getPersistPath();
    if (!fs.existsSync(persistPath)) {
      return [];
    }

    const data = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Save MCP server config (add or update).
 */
export function savePersistedServer(config: MCPServerConfig): void {
  const name = config.name?.trim();
  if (!name) {
    return;
  }

  const persistPath = getPersistPath();
  const dir = path.dirname(persistPath);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load existing, update/add entry
  const items = loadPersistedServers();
  const filtered = items.filter((s) => s.name !== name);
  filtered.push(config);

  // Write atomically
  const tmpPath = persistPath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(filtered, null, 2), "utf-8");
  fs.renameSync(tmpPath, persistPath);
}

/**
 * Remove persisted MCP server config.
 */
export function removePersistedServer(name: string): void {
  const persistPath = getPersistPath();
  const items = loadPersistedServers();
  const filtered = items.filter((s) => s.name !== name);

  if (filtered.length === 0 && fs.existsSync(persistPath)) {
    try {
      fs.unlinkSync(persistPath);
    } catch {
      // Ignore
    }
    return;
  }

  if (fs.existsSync(path.dirname(persistPath))) {
    const tmpPath = persistPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(filtered, null, 2), "utf-8");
    fs.renameSync(tmpPath, persistPath);
  }
}
