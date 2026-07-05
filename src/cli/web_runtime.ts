type WebCommandResult = "started" | "already-running";

async function isSkyloomServer(port: number): Promise<boolean> {
  const host = process.env.SKYLOOM_WEB_HOST || "127.0.0.1";
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  try {
    const response = await fetch(`http://${probeHost}:${port}/api/status`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const status = await response.json() as Record<string, any>;
    return typeof status.version === "string" && typeof status.agents?.summary?.total === "number";
  } catch {
    return false;
  }
}

export async function startWebCommand(
  port: number,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<WebCommandResult> {
  const { startWebServer } = await import("../web/server");
  try {
    await startWebServer(port);
    return "started";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") throw error;
    if (await isSkyloomServer(port)) {
      write(`\n  Skyloom 已在运行: http://127.0.0.1:${port}\n\n`);
      return "already-running";
    }
    throw new Error(`端口 ${port} 已被其他程序占用，请改用: sky web --port ${port + 1}`);
  }
}
