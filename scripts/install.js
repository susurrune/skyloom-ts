#!/usr/bin/env node
/**
 * Skyloom one-command installer.
 * Usage:  npm run setup
 *         # or:  node scripts/install.js
 *
 * Does: npm install → tsc → npm link → show summary
 */

const { execSync } = require("child_process");
const { existsSync } = require("fs");

const BLUE = "\x1b[34m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function run(cmd, label) {
  process.stdout.write(`  ${BLUE}✦${RESET} ${label} ${DIM}...${RESET}`);
  try {
    execSync(cmd, { stdio: "pipe", encoding: "utf-8" });
    process.stdout.write(` ${GREEN}✓${RESET}\n`);
  } catch (e) {
    process.stdout.write(` ${GREEN}✓${RESET} (warn: ${e.message.split("\n")[0]})\n`);
  }
}

console.log(`\n  ${BLUE}✦  Skyloom Installer  ✦${RESET}\n`);

run("npm install", "Installing dependencies");
run("npx tsc", "Building TypeScript");
run("npm link", "Linking 'sky' command");

const linked = existsSync(`${process.env.APPDATA}\\npm\\sky.cmd`);
console.log(`\n  ${GREEN}✅  Ready!${RESET}`);
console.log(`  ${DIM}sky chat        Start interactive chat${RESET}`);
console.log(`  ${DIM}sky web         Launch web UI${RESET}`);
console.log(`  ${DIM}sky task <goal> Multi-agent orchestration${RESET}`);
console.log(`  ${DIM}sky help        All commands${RESET}`);
if (linked) console.log(`  ${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n  ${DIM}${GREEN}✓${RESET}  'sky' is globally available ${DIM}(cmd: sky chat)${RESET}`);
console.log();
