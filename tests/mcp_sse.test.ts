/**
 * MCP SSE transport — integration test against a local mock SSE server.
 *
 * Exercises the full handshake: GET event-stream → `endpoint` event →
 * initialize → tools/list → tools/call, with every response delivered back
 * over the persistent SSE stream and correlated by JSON-RPC id.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import { AddressInfo } from "net";
import { formatMcpHealthLines, MCPClient } from "../src/core/mcp";

/**
 * A minimal MCP-over-SSE server: one event-stream connection, a POST endpoint
 * that echoes JSON-RPC responses back over that stream.
 */
function startMockSSEServer(): Promise<{ url: string; close: () => void }> {
  let sseRes: http.ServerResponse | null = null;

  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseRes = res;
      // Advertise the message endpoint (relative path, resolved by the client).
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(202).end();
        const msg = JSON.parse(body);
        if (msg.id === undefined || msg.id === null) return; // notification
        const reply = (result: unknown) => {
          sseRes?.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`
          );
        };
        if (msg.method === "initialize") {
          reply({ protocolVersion: "2025-03-26", capabilities: {} });
        } else if (msg.method === "tools/list") {
          reply({ tools: [{ name: "echo", description: "echo back" }] });
        } else if (msg.method === "tools/call") {
          reply({ content: [{ type: "text", text: `hi ${msg.params.arguments.who}` }] });
        } else if (msg.method === "ping") {
          reply({});
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/sse`,
        close: () => {
          sseRes?.end();
          server.close();
        },
      });
    });
  });
}

describe("MCP SSE transport", () => {
  let mock: { url: string; close: () => void } | null = null;
  let client: MCPClient | null = null;

  afterEach(async () => {
    await client?.close();
    mock?.close();
    client = null;
    mock = null;
  });

  it("completes the endpoint handshake and lists tools", async () => {
    mock = await startMockSSEServer();
    client = new MCPClient({ name: "mock", url: mock.url });

    const tools = await client.initialize();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(client.getToolDefinitions()).toHaveLength(1);
  });

  it("calls a tool and extracts the text result over the stream", async () => {
    mock = await startMockSSEServer();
    client = new MCPClient({ name: "mock", url: mock.url });

    await client.initialize();
    const result = await client.callTool("echo", { who: "skyloom" });
    expect(result).toBe("hi skyloom");
  });

  it("reports healthy after the handshake via an SSE ping round-trip", async () => {
    mock = await startMockSSEServer();
    client = new MCPClient({ name: "mock", url: mock.url });

    expect(client.getHealthSnapshot()).toMatchObject({
      name: "mock",
      transport: "sse",
      connected: false,
      state: "disconnected",
      healthy: false,
    });

    await client.initialize();
    expect(client.getHealthSnapshot()).toMatchObject({
      connected: true,
      state: "connected",
      healthy: null,
      tools: 1,
    });

    const health = await client.healthCheck();
    expect(health.healthy).toBe(true);
    expect(client.getHealthSnapshot()).toMatchObject({
      connected: true,
      state: "healthy",
      healthy: true,
      details: "ok",
      tools: 1,
    });
    expect(client.getHealthSnapshot().lastCheckedAt).toEqual(expect.any(String));
  });

  it("formats MCP health snapshots for TUI surfaces", () => {
    expect(formatMcpHealthLines([], ["legacy: 2 tools"])).toEqual(["legacy: 2 tools"]);
    expect(formatMcpHealthLines([{
      name: "mock",
      transport: "sse",
      target: "http://127.0.0.1/sse",
      tools: 1,
      connected: true,
      state: "healthy",
      healthy: true,
      details: "ok",
      lastCheckedAt: "2026-07-12T00:00:00.000Z",
      connectedAt: "2026-07-12T00:00:00.000Z",
    }])[0]).toContain("mock | sse | healthy | 1 tools");
  });
});
