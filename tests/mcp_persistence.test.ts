import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { MCPManager, loadPersistedServers } from "../src/core/mcp";
import { ToolRegistry } from "../src/core/tool";

function startMockSSEServer(): Promise<{ url: string; close: () => Promise<void> }> {
  let sseRes: http.ServerResponse | null = null;
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      sseRes = res;
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }

    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(202).end();
        const msg = JSON.parse(body);
        if (msg.id === undefined || msg.id === null) return;
        const result = msg.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: {} }
          : msg.method === "tools/list"
            ? { tools: [{ name: "echo", description: "echo back" }] }
            : {};
        sseRes?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
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
        close: async () => {
          sseRes?.end();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

describe("MCP runtime persistence", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tempHome = "";

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "skyloom-mcp-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("persists runtime-added MCP servers and removes them on disconnect", async () => {
    const mock = await startMockSSEServer();
    const registry = new ToolRegistry();
    const manager = new MCPManager(registry);

    try {
      const added = await manager.addServer({ name: "mock", url: mock.url, enabled: true });
      expect(added).toContain("已接入 MCP server 'mock'");
      expect(loadPersistedServers()).toEqual([{ name: "mock", url: mock.url, enabled: true }]);
      expect(registry.listNames()).toContain("mcp_mock_echo");

      const removed = await manager.removeServer("mock");
      expect(removed).toContain("已断开 MCP server 'mock'");
      expect(loadPersistedServers()).toEqual([]);
      expect(registry.listNames()).not.toContain("mcp_mock_echo");
    } finally {
      await manager.closeAll();
      await mock.close();
    }
  });

  it("removes configured servers even when they are not connected", async () => {
    const registry = new ToolRegistry();
    const manager = new MCPManager(registry);

    manager.configure([{ name: "ghost", url: "http://127.0.0.1:9/sse", enabled: true }]);
    expect(manager.getHealthSnapshot().map((server) => server.name)).toContain("ghost");

    const removed = await manager.removeServer("ghost");

    expect(removed).toContain("已断开 MCP server 'ghost'");
    expect(manager.getHealthSnapshot().map((server) => server.name)).not.toContain("ghost");
  });

  it("replaces stale same-name MCP config after a successful retry", async () => {
    const mock = await startMockSSEServer();
    const registry = new ToolRegistry();
    const manager = new MCPManager(registry);

    try {
      manager.configure([{ name: "mock", url: "http://127.0.0.1:9/sse", enabled: true }]);

      const added = await manager.addServer({ name: "mock", url: mock.url, enabled: true });

      expect(added).toContain("已接入 MCP server 'mock'");
      expect(manager.getHealthSnapshot().filter((server) => server.name === "mock")).toHaveLength(1);
      expect(loadPersistedServers()).toEqual([{ name: "mock", url: mock.url, enabled: true }]);
    } finally {
      await manager.closeAll();
      await mock.close();
    }
  });
});
