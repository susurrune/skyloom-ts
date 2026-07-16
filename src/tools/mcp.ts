import type { MCPManager, MCPServerConfig } from "../core/mcp";
import { formatMcpHealthLines } from "../core/mcp";
import type { ToolRegistry } from "../core/tool";

type MCPManagerProvider = () => MCPManager | null | undefined;

function getManager(provider: MCPManagerProvider): MCPManager | null {
  return provider() ?? null;
}

function parseArgs(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // Fall through to shell-like whitespace splitting for simple commands.
  }
  return value.trim().split(/\s+/).filter(Boolean);
}

function parseEnv(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      out[key] = String(raw);
    }
    return out;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
        out[key] = String(raw);
      }
      return out;
    }
  }
  return {};
}

/** Register runtime MCP management tools. */
export function registerMcpTools(registry: ToolRegistry, getMcp: MCPManagerProvider): void {
  registry.register({
    name: "mcp_list_servers",
    idempotent: true,
    description: "List configured MCP servers with transport, connection health, and registered tool counts.",
    parameters: [],
    handler: async () => {
      const manager = getManager(getMcp);
      if (!manager) return "No MCP manager is available.";
      return formatMcpHealthLines(manager.getHealthSnapshot()).join("\n");
    },
  });

  registry.register({
    name: "mcp_add_server",
    description: "Connect a runtime MCP server by stdio command or SSE URL. Provide either command or url.",
    parameters: [
      { name: "name", type: "string", description: "Unique MCP server name.", required: true },
      { name: "command", type: "string", description: "Stdio command to launch.", required: false },
      { name: "args", type: "array", description: "Command arguments as an array, or a JSON array string.", required: false },
      { name: "url", type: "string", description: "SSE endpoint URL.", required: false },
      { name: "env", type: "object", description: "Environment variables as an object, or a JSON object string.", required: false },
    ],
    handler: async (params) => {
      const manager = getManager(getMcp);
      if (!manager) return "Error: MCP manager is not available.";
      const name = String(params.name || "").trim();
      const command = String(params.command || "").trim();
      const url = String(params.url || "").trim();
      if (!name) return "Error: name is required.";
      if (!command && !url) return "Error: provide either command or url.";
      if (command && url) return "Error: provide command or url, not both.";

      let env: Record<string, string>;
      try {
        env = parseEnv(params.env);
      } catch (e) {
        return `Error: env must be an object or JSON object string (${String((e as Error).message || e)})`;
      }

      const config: MCPServerConfig = {
        name,
        enabled: true,
        ...(command ? { command, args: parseArgs(params.args) } : {}),
        ...(url ? { url } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };

      return manager.addServer(config);
    },
  });

  registry.register({
    name: "mcp_remove_server",
    description: "Disconnect a runtime MCP server and unregister its exposed tools.",
    parameters: [
      { name: "name", type: "string", description: "MCP server name to remove.", required: true },
    ],
    handler: async (params) => {
      const manager = getManager(getMcp);
      if (!manager) return "Error: MCP manager is not available.";
      const name = String(params.name || "").trim();
      if (!name) return "Error: name is required.";
      return manager.removeServer(name);
    },
  });
}
