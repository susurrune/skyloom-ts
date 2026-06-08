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

const MODE = new ModeController();
const VERSION = "1.4.4";

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
/* Check for API key availability */
function checkApiKeys(): string | null {
  const keys = ["DEEPSEEK_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY","GROQ_API_KEY","OPENROUTER_API_KEY"];
  for (const k of keys) { if (process.env[k]) return k; }
  return null;
}

async function chat(agentName: string, modelOverride?: string): Promise<void> {
  const haveKey = checkApiKeys();
  if (!haveKey) {
    process.stdout.write("\n" + chalk.yellow("  ⚠ No API key configured.\n"));
    process.stdout.write(chalk.dim("  Set one:  $env:DEEPSEEK_API_KEY = \"sk-your-key\"  (PowerShell)\n"));
    process.stdout.write(chalk.dim("            export DEEPSEEK_API_KEY=sk-your-key    (Bash)\n\n"));
    process.stdout.write(chalk.dim("  Then run: sky\n\n"));
    process.exit(1);
  }

  const ctx = createSystemContext();
  let agent = ctx.agentMap.get(agentName);
  if (!agent) { process.stdout.write(chalk.red("Unknown agent: " + agentName) + "\n"); return; }
  await agent.init();
  // eslint-disable-next-line prefer-const
  let currentAgent = agent; // mutable for agent switching
  welcome(agent);

  process.stdout.write(chalk.dim("  Key: " + haveKey + "\n\n"));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  function ask() { rl.question(chalk.cyan("  " + currentAgent.displayName + " ❯ "), handler); }
  async function handler(inp: string) {
    inp = inp.trim();
    if (!inp) { ask(); return; }

    const cmdL = inp.toLowerCase();

    // Agent switch
    for (const n of AGENT_NAMES) {
      if (cmdL === "/" + n) { const a = ctx.agentMap.get(n); if (a) { await a.init(); currentAgent = a; } process.stdout.write(chalk.dim("  ⟳ " + AGENT_DISPLAY[n] + "\n")); ask(); return; }
    }

    if (cmdL === "/quit" || cmdL === "/exit") { process.stdout.write(chalk.dim("\n  Session ended\n")); rl.close(); await ctx.closeAll(); process.exit(0); return; }
    if (cmdL === "/help") { process.stdout.write(helpText()); ask(); return; }
    if (cmdL === "/clear") { console.clear(); welcome(agent); process.stdout.write(chalk.dim("  Key: " + haveKey + "\n\n")); ask(); return; }
    if (cmdL === "/status") { process.stdout.write(chalk.bold("\n  " + currentAgent.displayName + " (" + currentAgent.name + ")\n") + chalk.dim("  State: " + currentAgent.state + "  ·  Memory: " + currentAgent.memory.shortTerm.length + " msgs\n\n")); ask(); return; }
    if (cmdL === "/cost") { process.stdout.write(chalk.bold("\n  Total: " + formatCost(ctx.llm.getTotalCost()) + "\n\n")); ask(); return; }
    if (cmdL === "/compact") { const r = await currentAgent.compact(); process.stdout.write(chalk.green("  ✓ " + r + "\n\n")); ask(); return; }
    if (cmdL === "/version") { process.stdout.write("  Skyloom v" + VERSION + "\n"); ask(); return; }
    if (cmdL.startsWith("/task ")) { const g = inp.slice(6); process.stdout.write(chalk.cyan("\n  ✦ " + g + "\n\n")); await runTask(g); ask(); return; }
    if (inp.startsWith("/")) { process.stdout.write(helpText()); ask(); return; }

    // ── Chat ──
    process.stdout.write(chalk.dim("  " + currentAgent.displayName + " thinking...\r"));
    try {
      const response = await currentAgent.chat(inp);
      process.stdout.write("\r" + " ".repeat(40) + "\r\n");
      const lines = render(response);
      for (const l of lines) process.stdout.write(l + "\n");
      process.stdout.write("\n");
    } catch (e: any) {
      process.stdout.write("\r" + " ".repeat(40) + "\r");
      process.stdout.write(chalk.red("  ✗ " + (e.message || e) + "\n\n"));
    }
    ask();
  }

  ask();
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
