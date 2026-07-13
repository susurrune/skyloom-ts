#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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

try {
  const packed = JSON.parse(run(node, [npmCli, "pack", "--json", "--pack-destination", temp]));
  const archive = path.join(temp, packed[0].filename);
  const installDir = path.join(temp, "install");
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ private: true }));
  run(node, [npmCli, "install", archive, "--ignore-scripts", "--no-audit", "--no-fund"], installDir);

  const installed = path.join(installDir, "node_modules", "skyloom");
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
  process.stdout.write(`${version} package smoke passed\n`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
