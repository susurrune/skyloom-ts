import { describe, expect, it, vi } from "vitest";
import { createSystemContext } from "../src/core/factory";
import { ToolRegistry } from "../src/core/tool";
import { registerMcpTools } from "../src/tools/mcp";

describe("MCP management tools", () => {
  function setup(manager: any) {
    const registry = new ToolRegistry();
    registerMcpTools(registry, () => manager);
    return registry;
  }

  it("registers MCP management tools in the system context", () => {
    const ctx = createSystemContext();
    expect(ctx.toolRegistry.listNames()).toEqual(expect.arrayContaining([
      "mcp_list_servers",
      "mcp_add_server",
      "mcp_remove_server",
    ]));
  });

  it("lists structured MCP health through the tool surface", async () => {
    const registry = setup({
      getHealthSnapshot: () => [{
        name: "mock",
        transport: "sse",
        target: "http://127.0.0.1/sse",
        tools: 2,
        connected: true,
        state: "healthy",
        healthy: true,
        details: "ok",
        lastCheckedAt: "2026-07-13T00:00:00.000Z",
        connectedAt: "2026-07-13T00:00:00.000Z",
      }],
    });

    const result = await registry.execute("mcp_list_servers", {});
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain("mock | sse | healthy | 2 tools");
  });

  it("adds stdio servers with parsed args and env", async () => {
    const addServer = vi.fn().mockResolvedValue("added");
    const registry = setup({ addServer, getHealthSnapshot: () => [] });

    const result = await registry.execute("mcp_add_server", {
      name: "local",
      command: "node",
      args: "[\"server.js\",\"--stdio\"]",
      env: "{\"TOKEN\":\"abc\"}",
    });

    expect(result).toMatchObject({ success: true, result: "added" });
    expect(addServer).toHaveBeenCalledWith({
      name: "local",
      enabled: true,
      command: "node",
      args: ["server.js", "--stdio"],
      env: { TOKEN: "abc" },
    });
  });

  it("rejects ambiguous MCP server targets before connecting", async () => {
    const addServer = vi.fn();
    const registry = setup({ addServer, getHealthSnapshot: () => [] });

    const result = await registry.execute("mcp_add_server", {
      name: "bad",
      command: "node",
      url: "http://127.0.0.1/sse",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("provide command or url, not both");
    expect(addServer).not.toHaveBeenCalled();
  });

  it("removes servers through the tool surface", async () => {
    const removeServer = vi.fn().mockResolvedValue("removed");
    const registry = setup({ removeServer, getHealthSnapshot: () => [] });

    const result = await registry.execute("mcp_remove_server", { name: "local" });
    expect(result).toMatchObject({ success: true, result: "removed" });
    expect(removeServer).toHaveBeenCalledWith("local");
  });
});
