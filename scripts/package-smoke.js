#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "skyloom-package-"));
const node = process.execPath;
const npmCli = process.env.npm_execpath || path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function runWithInput(command, args, input, cwd = root) {
  const result = spawnSync(command, args, { cwd, input, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

try {
  const packed = JSON.parse(run(node, [npmCli, "pack", "--json", "--pack-destination", temp]));
  const archive = path.join(temp, packed[0].filename);
  const installDir = path.join(temp, "install");
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ private: true }));
  run(node, [npmCli, "install", archive, "--ignore-scripts", "--no-audit", "--no-fund"], installDir);

  const installed = path.join(installDir, "node_modules", "skyloom");
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  if (installedPackage.scripts && installedPackage.scripts.postinstall) {
    throw new Error("published package must not mutate global npm links during install");
  }
  for (const forbidden of ["src", "tests", ".github", "docs/superpowers"]) {
    if (fs.existsSync(path.join(installed, forbidden))) {
      throw new Error(`published package contains internal path: ${forbidden}`);
    }
  }
  for (const required of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli/main.js",
    "dist/web/ui/index.html",
    "dist/web/ui/styles.css",
    "dist/web/ui/app.js",
    "config/models.yaml",
  ]) {
    if (!fs.existsSync(path.join(installed, required))) {
      throw new Error(`published package is missing runtime path: ${required}`);
    }
  }

  const version = run(node, [path.join(installed, "dist", "cli", "main.js"), "version"], installDir);
  if (!/^Skyloom v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`unexpected packaged CLI output: ${version}`);
  }
  const sdk = JSON.parse(run(node, ["-e", `
    const skyloom = require("skyloom");
    process.stdout.write(JSON.stringify({
      version: skyloom.VERSION,
      factory: typeof skyloom.createSystemContext,
      router: typeof skyloom.classify,
    }));
  `], installDir));
  if (sdk.version !== version.replace("Skyloom v", "") || sdk.factory !== "function" || sdk.router !== "function") {
    throw new Error(`unexpected packaged SDK exports: ${JSON.stringify(sdk)}`);
  }

  const cli = path.join(installed, "dist", "cli", "main.js");
  const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
  const mcpOutput = runWithInput(node, [cli, "mcp"], initialize, installDir).split(/\r?\n/).find(Boolean);
  const mcp = JSON.parse(mcpOutput || "{}");
  if (mcp.result?.serverInfo?.version !== installedPackage.version) {
    throw new Error(`MCP version mismatch: ${JSON.stringify(mcp.result?.serverInfo)}`);
  }

  const port = 24000 + Math.floor(Math.random() * 1000);
  const web = spawn(node, [cli, "web", "--port", String(port)], {
    cwd: installDir,
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    const probe = run(node, ["-e", `
      const http = require("http");
      let attempts = 0;
      const retry = () => {
        if (++attempts >= 50) { process.exitCode = 1; return; }
        setTimeout(probe, 100);
      };
      const probe = () => {
        const request = http.get("http://127.0.0.1:${port}/api/status", (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { raw += chunk; });
          response.on("end", () => {
            try {
              const body = JSON.parse(raw);
              if (response.statusCode === 200 && body.version === ${JSON.stringify(installedPackage.version)}) return;
            } catch {}
            retry();
          });
        });
        request.setTimeout(500, () => request.destroy());
        request.on("error", retry);
      };
      probe();
    `], installDir);
    if (probe) process.stdout.write(probe + "\n");
  } finally {
    web.kill();
  }
  process.stdout.write(`${version} package smoke passed\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
