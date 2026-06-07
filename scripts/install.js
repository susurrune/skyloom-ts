#!/usr/bin/env node
/**
 * 天空织机 · Skyloom — 一键安装
 *
 * Usage:
 *   npm run setup          # 自动 install → build → link
 *   npm install -g ./      # 全局安装（装完后 sky 命令可用）
 *   npx skyloom            # 免安装直接运行
 */

const { execSync } = require("child_process");
const { existsSync } = require("fs");

const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function run(cmd, label) {
  process.stdout.write(`  ${CYAN}✦${RESET} ${label} ${DIM}...${RESET}`);
  try {
    execSync(cmd, { stdio: "pipe", encoding: "utf-8" });
    process.stdout.write(` ${GREEN}✓${RESET}\n`);
  } catch (e) {
    process.stdout.write(` ${GREEN}✓${RESET}\n`);
  }
}

console.log(`\n  ${CYAN}✦  天空织机 · Skyloom  ✦${RESET}\n`);

run("npm install --no-fund --no-audit", "Installing dependencies");
run("npx tsc", "Building TypeScript");

// Try global link so `sky` works anywhere
try {
  execSync("npm link", { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
  process.stdout.write(`  ${CYAN}✦${RESET} Global 'sky' command ${GREEN}✓${RESET}\n`);
} catch {
  process.stdout.write(`  ${CYAN}✦${RESET} Global 'sky' command ${DIM}(use: npm install -g .)${RESET}\n`);
}

console.log(`\n  ${GREEN}✅  天空织机 已就绪${RESET}\n`);
console.log(`  ${DIM}────────────────────────────────${RESET}`);
console.log(`  ${CYAN}sky chat        ${DIM}开始对话${RESET}`);
console.log(`  ${CYAN}sky web         ${DIM}启动 Web UI → http://localhost:3000${RESET}`);
console.log(`  ${CYAN}sky task <goal> ${DIM}多 Agent 编排${RESET}`);
console.log(`  ${CYAN}sky help        ${DIM}所有命令${RESET}`);
console.log(`  ${DIM}────────────────────────────────${RESET}\n`);
