#!/usr/bin/env node
/**
 * 天空织机 CLI — Skyloom Terminal Interface
 */
import { Command } from "commander";
import * as fs from "fs";
import * as readline from "readline";
import chalk from "chalk";
import { createSystemContext, orchestrateTask } from "../core/factory";
import { loadConfig, USER_CONFIG_DIR } from "../core/config";
import { classify } from "../core/router";
import { InteractiveMode, ModeController } from "./mode";
import { readInput, type TUIContext } from "./tui";

const MODE = new ModeController();
const VERSION = (() => { try { return require("../../package.json").version; } catch { return "1.5.2"; } })();

const AGENT_DISPLAY: Record<string, string> = {
  fog: "≋ 雾 Fog", rain: "⸽ 雨 Rain", frost: "✱ 霜 Frost",
  snow: "❉ 雪 Snow", dew: "∘ 露 Dew", fair: "☼ 晴 Fair",
};
const AGENT_NAMES = ["fog", "rain", "frost", "snow", "dew", "fair"] as const;

/* ═══════════════════════════════════════
   Slash commands registry
   ═══════════════════════════════════════ */
const SLASH_CMDS: [string, string][] = [
  ["/help", "Show all commands"],
  ["/clear", "Clear screen"],
  ["/status", "Agent overview"],
  ["/cost", "Usage & cost"],
  ["/cost reset", "Reset usage stats"],
  ["/compact", "Compress context"],
  ["/retry", "Resend last msg"],
  ["/memory", "Memory stats"],
  ["/memory clear", "Clear short-term memory"],
  ["/sessions", "Session list"],
  ["/workspace", "Workspace info"],
  ["/model", "Model info"],
  ["/mcp", "MCP server status"],
  ["/version", "Version info"],
  ["/task <goal>", "Multi-agent orchestrate"],
  ["/fog", "≋ Fog — research insight"],
  ["/rain", "⸽ Rain — creation codegen"],
  ["/frost", "✱ Frost — review quality"],
  ["/snow", "❉ Snow — planning architect"],
  ["/dew", "∘ Dew — devops reliability"],
  ["/fair", "☼ Fair — companion warmth"],
  ["/quit", "Exit chat"],
  ["/exit", "Exit chat"],
];

function showPopup(cmds: [string, string][], selIdx: number) {
  const w = process.stdout.columns || 80;
  const start = Math.max(0, Math.min(selIdx - 4, cmds.length - 8));
  const end = Math.min(cmds.length, start + 8);
  process.stdout.write(chalk.dim("  ┌─ commands (↑↓ pick · type letter to filter · tab/enter select) ─┐\n"));
  for (let i = start; i < end; i++) {
    const [cmd, desc] = cmds[i];
    const marker = i === selIdx ? chalk.cyan(" ▶ ") : "   ";
    process.stdout.write(`  │${marker}${chalk.cyan(cmd.padEnd(24))}${chalk.dim(desc)}${" ".repeat(Math.max(0, 50 - desc.length))}│\n`);
  }
  process.stdout.write(chalk.dim(`  └${"─".repeat(60)}┘\n`));
}

/* ═══════════════════════════════════════
   Commander
   ═══════════════════════════════════════ */
const program = new Command()
  .name("sky").description("天空织机 Skyloom").version(VERSION);

program.command("chat").argument("[agent]", "agent name", "fog")
  .option("-m,--model <m>", "model").action(async (a: string, o: { model?: string }) => { await chat(a, o.model); });
program.command("task").argument("[goal]", "task goal")
  .action(async (g?: string) => { if (g) await runTask(g); });
program.command("web").option("-p,--port <p>", "port", "3000")
  .action((o: { port?: string }) => { import("../web/server").then(m => m.startWebServer(parseInt(o.port || "3000"))); });
program.command("mcp").action(() => { import("../core/mcp_server").then(m => m.startMCPServer()); });
program.command("config").action(() => { const c = loadConfig(); process.stdout.write(chalk.cyan("\nConfig: ") + USER_CONFIG_DIR + "\n"); for (const [n, a] of Object.entries(c.agents || {})) process.stdout.write(`  ${chalk.bold(n)}: ${(a as any).model || "default"}\n`); });
program.command("init").action(() => { if (!fs.existsSync(USER_CONFIG_DIR)) fs.mkdirSync(USER_CONFIG_DIR, { recursive: true }); process.stdout.write(chalk.green("✓ ") + USER_CONFIG_DIR + "\n"); });
program.command("apikey").description("Manage API keys (persisted to ~/.skyloom/config.yaml)")
  .argument("[action]", "set|list").argument("[provider]", "e.g. deepseek").argument("[key]", "API key")
  .action((action?: string, provider?: string, key?: string) => {
    if (action === "set" && provider && key) { saveApiKey(provider, key); process.stdout.write(chalk.green("✓ Saved " + provider + " API key\n")); }
    else { process.stdout.write(chalk.dim("Usage: sky apikey set deepseek YOUR_KEY\n")); }
  });
program.command("version").action(() => { process.stdout.write(`Skyloom v${VERSION}\n`); });

/* ═══════════════════════════════════════
   Welcome
   ═══════════════════════════════════════ */
function welcome(agent: any) {
  const w = process.stdout.columns || 80;
  const pad = " ".repeat(Math.max(0, Math.floor((w - 34) / 2)));
  process.stdout.write("\n" + pad + chalk.cyan("✦    天 空 织 机    ✦\n"));
  process.stdout.write(pad + chalk.dim("S K Y L O O M\n\n"));
  const parts: string[] = [];
  for (const n of AGENT_NAMES) {
    const a = n === agent.name;
    const s = `${AGENT_DISPLAY[n].split(" ")[0]} ${AGENT_DISPLAY[n].split(" ")[1]}`;
    parts.push(a ? chalk.bold.cyan(s) : chalk.dim(s));
  }
  process.stdout.write("  " + parts.join(chalk.dim("  ·  ")) + "\n\n");
  process.stdout.write(chalk.dim("  /help for commands  ·  /quit to exit\n\n"));
}

function statusBar(agent: any, ctx: any): string {
  try {
    const cu = agent.contextUsage();
    const pct = cu.pct || 0;
    const bar = pct < 50 ? chalk.green : pct < 80 ? chalk.yellow : chalk.red;
    const filled = Math.round(pct / 10);
    const ctxBar = `${bar("█".repeat(filled) + "░".repeat(10 - filled))} ${pct}%`;
    const cost = formatCost(ctx.llm.getTotalCost());
    return chalk.dim(`${ctxBar}  ·  ${cost}  ·  ${cu.model || "?"}`);
  } catch { return ""; }
}

function formatCost(c: number): string {
  if (c >= 1) return chalk.yellow(`$${c.toFixed(2)}`);
  if (c >= 0.01) return chalk.yellow(`$${c.toFixed(4)}`);
  if (c > 0) return chalk.green(`${(c * 100).toFixed(2)}¢`);
  return "$0";
}

/* ═══════════════════════════════════════
   Response render
   ═══════════════════════════════════════ */
function render(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split("\n\n")) {
    const t = para.trim();
    if (!t) continue;
    if (t.startsWith("```")) {
      const lines = t.split("\n");
      out.push(chalk.dim("  ╭─ code ──"));
      for (let i = 1; i < lines.length - 1; i++) out.push(`  ${chalk.dim("│")} ${chalk.gray(lines[i].slice(0, 72))}`);
      out.push(chalk.dim("  ╰────────"));
    } else {
      for (const line of t.split("\n")) {
        if (line.startsWith("# ")) out.push("  " + chalk.bold(line));
        else if (line.startsWith("- ") || line.startsWith("* ")) out.push("  " + chalk.dim("• ") + line.slice(2));
        else out.push("  " + line);
      }
    }
  }
  return out;
}

/* ═══════════════════════════════════════
   Chat loop
   ═══════════════════════════════════════ */
/* API key persistence — read from config file too */
function checkApiKeys(): string | null {
  // Check env vars
  const envKeys = ["DEEPSEEK_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY","GROQ_API_KEY","OPENROUTER_API_KEY"];
  for (const k of envKeys) { if (process.env[k]) return "env:" + k; }
  // Check config file
  try {
    const path = require("path"); const fs = require("fs"); const yaml = require("yaml");
    const cfgPath = path.join(require("os").homedir(), ".skyloom", "config.yaml");
    if (fs.existsSync(cfgPath)) {
      const cfg = yaml.parse(fs.readFileSync(cfgPath, "utf-8")) || {};
      const keys = cfg.api_keys || {};
      for (const [p, k] of Object.entries(keys)) { if (k) return "cfg:" + p; }
    }
  } catch { /* ignore */ }
  return null;
}

/** Save API key to config file */
function saveApiKey(provider: string, key: string): void {
  const path = require("path"); const fs = require("fs"); const yaml = require("yaml");
  const cfgPath = path.join(require("os").homedir(), ".skyloom", "config.yaml");
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let cfg: any = {};
  if (fs.existsSync(cfgPath)) { try { cfg = yaml.parse(fs.readFileSync(cfgPath, "utf-8")) || {}; } catch { } }
  if (!cfg.api_keys) cfg.api_keys = {};
  cfg.api_keys[provider] = key;
  fs.writeFileSync(cfgPath, yaml.stringify(cfg), "utf-8");
}

async function chat(agentName: string, modelOverride?: string): Promise<void> {
  const haveKey = checkApiKeys();
  if (!haveKey) {
    process.stdout.write("\n" + chalk.yellow("  ⚠ No API key configured.\n"));
    process.stdout.write(chalk.dim("  Quick setup:\n"));
    process.stdout.write(chalk.dim("    sky apikey set deepseek sk-your-key-here\n"));
    process.stdout.write(chalk.dim("  Or env var:\n"));
    process.stdout.write(chalk.dim("    $env:DEEPSEEK_API_KEY = \"sk-your-key\"\n\n"));
    process.exit(1);
  }

  const ctx = createSystemContext();
  let agent = ctx.agentMap.get(agentName);
  if (!agent) { process.stdout.write(chalk.red("Unknown agent: " + agentName) + "\n"); return; }
  await agent.init();

  // Wire up security approval — prompt user for HIGH/CRITICAL operations
  try {
    const { getSecurity, DangerLevel } = require("../core/security");
    const sec = getSecurity();
    sec.setApprovalCallback(async (tool: string, args: Record<string, any>, level: number) => {
      process.stdout.write(chalk.yellow(`\n  ⚠ ${tool} ( danger level ${level} )\n`));
      process.stdout.write(chalk.dim(`     args: ${JSON.stringify(args).slice(0, 80)}\n`));
      const answer = await new Promise<string>(resolve => {
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl2.question(chalk.red("     Approve? [y/N] "), (a: string) => { rl2.close(); resolve(a.trim().toLowerCase()); });
      });
      return answer === "y" || answer === "yes";
    });
  } catch { /* security module optional */ }

  // eslint-disable-next-line prefer-const
  let currentAgent = agent; // mutable for agent switching
  welcome(agent);

  process.stdout.write(chalk.dim("  Key: " + haveKey + "\n\n"));

  // ── TUI loop ──
  const ctx_: TUIContext = { agent: currentAgent, agents: ctx.agentMap, model: "default", cost: "$0", width: 80, height: 24 };

  while (true) {
    const inp = await readInput(process.stdin, process.stdout, ctx_);
    if (!inp) continue;

    const cmdL = inp.toLowerCase();

    // Agent switch
    let switched = false;
    for (const n of AGENT_NAMES) {
      if (cmdL === "/" + n) { const a = ctx.agentMap.get(n); if (a) { await a.init(); currentAgent = a; ctx_.agent = a; } switched = true; break; }
    }
    if (switched) continue;
    if (cmdL === "/quit" || cmdL === "/exit") break;
    if (cmdL === "/clear") { console.clear(); continue; }
    if (cmdL === "/help") { process.stdout.write(helpText()); continue; }
    if (cmdL === "/version") { process.stdout.write("  Skyloom v" + VERSION + "\n"); continue; }
    if (cmdL === "/status") { process.stdout.write(chalk.bold("\n  " + currentAgent.displayName + " (" + currentAgent.name + ")\n") + chalk.dim("  State: " + currentAgent.state + "  ·  Memory: " + currentAgent.memory.shortTerm.length + " msgs\n\n")); continue; }
    if (cmdL === "/cost") { process.stdout.write(chalk.bold("\n  Total: " + formatCost(ctx.llm.getTotalCost()) + "\n\n")); continue; }
    if (cmdL === "/cost reset") { (ctx.llm as any).resetUsageStats?.(); process.stdout.write(chalk.dim("  Stats reset\n")); continue; }
    if (cmdL === "/compact") { const r = await currentAgent.compact(); process.stdout.write(chalk.green("  ✓ " + r + "\n\n")); continue; }
    if (cmdL === "/memory") { process.stdout.write(chalk.dim("  Short-term: " + currentAgent.memory.shortTerm.length + " msgs  ·  Working: " + Object.keys(currentAgent.memory.working).length + " keys\n")); continue; }
    if (cmdL === "/memory clear") { await currentAgent.memory.clearShortTerm(); process.stdout.write(chalk.dim("  Memory cleared\n")); continue; }
    if (cmdL === "/workspace") { process.stdout.write(chalk.dim("  " + (ctx.workspacePath || "default") + "\n")); continue; }
    if (cmdL === "/sessions") { const ss = await currentAgent.memory.listSessions(); process.stdout.write(chalk.bold("\n  Sessions:\n")); for (const s of ss.slice(0, 10)) process.stdout.write(chalk.dim("  " + s.id?.slice(0, 10) + "... " + s.preview + " (" + s.messageCount + " msgs)\n")); continue; }
    if (cmdL === "/mcp") { process.stdout.write(chalk.dim("  " + (ctx.mcpStatus?.join(", ") || "none") + "\n")); continue; }
    if (cmdL.startsWith("/apikey set ")) { const p = inp.split(/\s+/); if (p.length >= 4) { saveApiKey(p[2], p[3]); process.stdout.write(chalk.green("  ✓ Saved " + p[2] + " API key\n")); } else { process.stdout.write(chalk.yellow("  Usage: /apikey set <provider> <key>\n")); } continue; }
    if (cmdL === "/apikey") { process.stdout.write(chalk.bold("\n  API Keys:\n")); for (const p of ["openai","deepseek","anthropic","groq","openrouter"]) { process.stdout.write(chalk.dim("  " + p.padEnd(14) + (!!process.env[p.toUpperCase() + "_API_KEY"] ? chalk.green("env") : chalk.dim("—")) + "\n")); } process.stdout.write("\n"); continue; }
    if (cmdL.startsWith("/task ")) { const g = inp.slice(6); process.stdout.write(chalk.cyan("\n  ✦ " + g + "\n\n")); await runTask(g); continue; }
    if (cmdL.startsWith("/model")) { process.stdout.write(chalk.dim("  Configure in ~/.skyloom/config.yaml\n\n")); continue; }
    if (inp.startsWith("/")) { process.stdout.write(helpText()); continue; }

    // ── Chat ──
    process.stdout.write(chalk.dim("  " + currentAgent.displayName + " thinking...\r"));
    try {
      const response = await currentAgent.chat(inp);
      process.stdout.write("\r" + " ".repeat(40) + "\r\n");
      for (const l of render(response)) process.stdout.write(l + "\n");
      process.stdout.write("\n");
    } catch (e: any) {
      process.stdout.write("\r" + " ".repeat(40) + "\r");
      process.stdout.write(chalk.red("  ✗ " + (e.message || e) + "\n\n"));
    }
  }

  process.stdout.write(chalk.dim("\n  Session ended\n"));
  await ctx.closeAll();
  process.exit(0);
}

/* ═══════════════════════════════════════
   Task
   ═══════════════════════════════════════ */
async function runTask(goal: string): Promise<void> {
  const ctx = createSystemContext();
  await ctx.initAll();
  const [, results, summary] = await orchestrateTask(goal, ctx.agentMap);
  for (const r of results) process.stdout.write(`  ${r.success ? chalk.green("✓") : chalk.red("✗")} ${chalk.cyan(r.agent)}: ${r.description.slice(0, 60)}\n`);
  process.stdout.write(chalk.bold("\n  " + summary.slice(0, 800) + "\n\n"));
  await ctx.closeAll();
}

function helpText(): string {
  const groups: [string, [string, string][]][] = [
    ["Agent", [["/fog /rain /frost", "Switch agents"], ["/snow /dew /fair", "Switch agents"]]],
    ["Chat", [["/help", "Commands"], ["/clear", "Clear"], ["/compact", "Compress"], ["/retry", "Resend"]]],
    ["Info", [["/status", "Status"], ["/cost", "Cost"], ["/memory", "Memory"], ["/sessions", "Sessions"], ["/workspace", "Workspace"], ["/version", "Version"]]],
    ["Orch.", [["/task <goal>", "Multi-agent"]]],
  ];
  let s = "";
  for (const [title, cmds] of groups) {
    s += chalk.cyan(`  ${title}\n`);
    for (const [c, d] of cmds) s += `    ${chalk.cyan(c.padEnd(18))}${chalk.dim(d)}\n`;
  }
  s += "\n";
  return s;
}

/* ═══════════════════════════════════════
   Entry
   ═══════════════════════════════════════ */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { await chat("fog"); return; }
  if ((AGENT_NAMES as readonly string[]).includes(args[0])) {
    let m: string | undefined;
    for (let i = 1; i < args.length; i++) if ((args[i] === "-m" || args[i] === "--model") && i + 1 < args.length) m = args[++i];
    await chat(args[0], m); return;
  }
  if (!["chat", "task", "web", "config", "init", "version", "mcp", "help"].includes(args[0]) && !args[0].startsWith("-")) { await chat("fog"); return; }
  program.parse(process.argv);
}

main().catch(e => { process.stderr.write(chalk.red(`Fatal: ${(e as Error).message}\n`)); process.exit(1); });
