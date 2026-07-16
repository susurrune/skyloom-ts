import { createServer, type Server } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startWebCommand } from "../src/cli/web_runtime";
import { startWebServer } from "../src/web/server";

const servers: Server[] = [];

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP address");
  return address.port;
}

async function listenPlainServer(): Promise<Server> {
  const server = createServer((_request, response) => response.end("occupied"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  })));
});

describe("sky web command", () => {
  it("reuses an already running Skyloom server without throwing", async () => {
    const existing = await startWebServer(0);
    servers.push(existing);
    const output: string[] = [];

    const result = await startWebCommand(portOf(existing), (text) => output.push(text));

    expect(result).toBe("already-running");
    expect(output.join("")).toContain("Skyloom 已在运行");
    expect(output.join("")).toContain(String(portOf(existing)));
  });

  it("reuses an authenticated remotely-bound Skyloom server", async () => {
    const token = "remote-access-token-with-strong-length";
    const existing = await startWebServer(0, undefined, { host: "0.0.0.0", token });
    servers.push(existing);
    vi.stubEnv("SKYLOOM_WEB_HOST", "0.0.0.0");
    vi.stubEnv("SKYLOOM_WEB_TOKEN", token);

    const result = await startWebCommand(portOf(existing), () => undefined);

    expect(result).toBe("already-running");
  });

  it("reports an actionable error when another program owns the port", async () => {
    const existing = await listenPlainServer();
    const port = portOf(existing);

    await expect(startWebCommand(port)).rejects.toThrow(
      `端口 ${port} 已被其他程序占用，请改用: sky web --port ${port + 1}`,
    );
  });
});
