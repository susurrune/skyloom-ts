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
import { listProviders, modelsFor, providerLabel, validateModel } from "../core/catalog";
import { agentTheme } from "../core/theme";
import { classify } from "../core/router";
import { InteractiveMode, ModeController } from "./mode";
import { readInput, type TUIContext } from "./tui";

const MODE = new ModeController();
const VERSION = (() => { try { return require("../../package.json").version; } catch { return "1.5.2"; } })();

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
  const active = agentTheme(agent.name);
  const seal = chalk.hex(active.hex);
  const pad = " ".repeat(Math.max(0, Math.floor((w - 34) / 2)));
  process.stdout.write("\n" + pad + seal("✦    天 空 织 机    ✦\n"));
  process.stdout.write(pad + chalk.dim("S K Y L O O M\n\n"));
  // Six shuttles, each in its own mineral pigment; active one bolded with a seal.
  const parts: string[] = [];
  for (const n of AGENT_NAMES) {
    const t = agentTheme(n);
    const isActive = n === agent.name;
    const label = `${t.symbol} ${t.kanji}`;
    parts.push(isActive ? chalk.bold.hex(t.hex)(`▣ ${label}`) : chalk.hex(t.hex).dim(label));
  }
  process.stdout.write("  " + parts.join(chalk.dim("  ·  ")) + "\n");
  process.stdout.write("  " + chalk.dim.italic(active.poem) + "\n\n");
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
   Streaming renderer — consumes agent.chatStream()
   ═══════════════════════════════════════ */
/**
 * Render a streamed turn live: reasoning in faint ink, content in mineral
 * pigment, tool calls as pulsing weather events. Replaces the old blocking
 * chat() + fake render. Tokens appear as they arrive.
 */
async function streamResponse(agent: any, input: string): Promise<void> {
  const theme = agentTheme(agent.name);
  const pigment = chalk.hex(theme.hex);
  let mode: "none" | "reasoning" | "content" = "none";
  let atLineStart = true;

  const writeContent = (text: string) => {
    for (const ch of text) {
      if (atLineStart) { process.stdout.write("  "); atLineStart = false; }
      process.stdout.write(ch);
      if (ch === "\n") atLineStart = true;
    }
  };

  // Thinking indicator until the first event lands
  process.stdout.write(chalk.dim(`  ${theme.symbol} ${theme.pigment} …\r`));
  let cleared = false;
  const clearThinking = () => { if (!cleared) { process.stdout.write("\r" + " ".repeat(40) + "\r"); cleared = true; } };

  for await (const ev of agent.chatStream(input)) {
    switch (ev.type) {
      case "reasoning":
        clearThinking();
        if (mode !== "reasoning") { process.stdout.write(chalk.dim("\n  ◦ ")); mode = "reasoning"; }
        process.stdout.write(chalk.dim.italic(String(ev.text).replace(/\n/g, " ")));
        break;
      case "content":
        clearThinking();
        if (mode !== "content") { process.stdout.write(mode === "reasoning" ? "\n\n" : "\n"); atLineStart = true; mode = "content"; }
        writeContent(String(ev.text));
        break;
      case "tool_status":
        clearThinking();
        process.stdout.write("\n" + pigment(`  ${theme.symbol} ${ev.tool_name}`) + chalk.dim(`  ${ev.label || ""} …`) + "\n");
        atLineStart = true; mode = "none";
        break;
      case "tool_done":
        process.stdout.write((ev.success ? chalk.green("  ✓ ") : chalk.red("  ✗ ")) + chalk.dim(String(ev.tool_name)) + "\n");
        atLineStart = true; mode = "none";
        break;
      case "truncated":
        process.stdout.write(chalk.yellow(`\n  ⚠ 截断: ${ev.reason}\n`));
        break;
      case "done":
        break;
    }
  }
  clearThinking();
  process.stdout.write("\n\n");
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

/* ═══════════════════════════════════════
   Interactive setup wizard
   ═══════════════════════════════════════ */
async function setupWizard(): Promise<{ provider: string; key: string; model: string } | null> {
  // Derived from the single-source model catalog (config/models.yaml).
  // Every listed model is callable — no hardcoded/fictional entries.
  const providers = listProviders().map((id) => ({
    id,
    name: providerLabel(id),
    models: modelsFor(id).map((m) => m.id),
  }));

  process.stdout.write("\n" + chalk.cyan("  ✦ API Key 设置向导 ✦\n\n"));
  process.stdout.write(chalk.dim("  选择 Provider（Key 保存在 ~/.skyloom/config.yaml）:\n\n"));

  for (let i = 0; i < providers.length; i++) {
    process.stdout.write(chalk.dim(`  ${String(i+1).padStart(2)}. ${providers[i].name.padEnd(22)} ${providers[i].models.slice(0,3).join(", ")}\n`));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

  const choice = await ask(chalk.cyan("\n  编号 (1-"+providers.length+", q退出): "));
  if (choice === "q") { rl.close(); return null; }
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= providers.length) { rl.close(); process.stdout.write(chalk.dim("  已取消\n")); return null; }

  const prov = providers[idx];
  const key = await ask(chalk.cyan(`  ${prov.name} API Key: `));
  if (!key.trim()) { rl.close(); return null; }

  saveApiKey(prov.id, key.trim());

  process.stdout.write(chalk.dim("\n  可用模型:\n"));
  for (let i = 0; i < prov.models.length; i++) process.stdout.write(chalk.dim(`  ${i+1}. ${prov.models[i]}\n`));

  const mc = await ask(chalk.cyan("\n  选择模型 (1-"+prov.models.length+", 默认1): ")) || "1";
  const mi = (parseInt(mc) || 1) - 1;
  const model = prov.models[Math.max(0, Math.min(mi, prov.models.length - 1))];

  // Save to config
  const path = require("path"); const fs = require("fs"); const yaml = require("yaml");
  const cfgPath = path.join(require("os").homedir(), ".skyloom", "config.yaml");
  let cfg: any = {}; if (fs.existsSync(cfgPath)) { try { cfg = yaml.parse(fs.readFileSync(cfgPath, "utf-8")) || {}; } catch { } }
  cfg.default_model = model; cfg.default_provider = prov.id;
  fs.writeFileSync(cfgPath, yaml.stringify(cfg), "utf-8");

  rl.close();
  process.stdout.write(chalk.green(`\n  ✓ ${prov.name} · ${model} · 就绪!\n\n`));
  return { provider: prov.id, key: key.trim(), model };
}

async function chat(agentName: string, modelOverride?: string): Promise<void> {
  const haveKey = checkApiKeys();
  if (!haveKey) {
    process.stdout.write("\n" + chalk.cyan("  ✦ 天空织机 Skyloom ✦\n"));
    process.stdout.write(chalk.dim("  检测到未配置 API Key，进入设置向导...\n\n"));
    const result = await setupWizard();
    if (!result) { process.stdout.write(chalk.red("  设置未完成，请重新运行 sky 配置。\n")); process.exit(0); }
    process.stdout.write(chalk.green(`  ✓ ${result.provider} 已就绪 · 模型: ${result.model}\n\n`));
  }

  const ctx = createSystemContext();
  let agent = ctx.agentMap.get(agentName);
  if (!agent) { process.stdout.write(chalk.red("Unknown agent: " + agentName) + "\n"); return; }

  // Validate the active model is real — catches stale/fictional configs
  // before they 404 mid-request.
  try {
    const cfg = loadConfig();
    const activeModel = cfg.agents?.[agentName]?.model || (cfg as any).llm?.default_model;
    const v = validateModel(activeModel);
    if (!v.ok) {
      process.stdout.write(chalk.yellow(`\n  ⚠ 配置的模型 "${activeModel || "(未设置)"}" 不在可用目录中。\n`));
      process.stdout.write(chalk.dim(`     可选: ${v.suggestions.join(", ")}\n`));
      process.stdout.write(chalk.dim(`     运行 /setup 重新选择，或编辑 ~/.skyloom/config.yaml。\n\n`));
    }
  } catch { /* validation is best-effort */ }

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

    // Agent switch — stamp a mineral seal on change
    let switched = false;
    for (const n of AGENT_NAMES) {
      if (cmdL === "/" + n) {
        const a = ctx.agentMap.get(n);
        if (a) {
          await a.init(); currentAgent = a; ctx_.agent = a;
          const t = agentTheme(n);
          process.stdout.write("\n  " + chalk.bold.hex(t.hex)(`▣ ${t.kanji} ${t.pigment}`) + chalk.dim(`  · ${t.specialty}`) + "\n");
          process.stdout.write("  " + chalk.dim.italic(t.poem) + "\n\n");
        }
        switched = true; break;
      }
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
    if (cmdL === "/setup") { const r = await setupWizard(); if (r) process.stdout.write(chalk.green(`  ${r.provider} · ${r.model} — Ready!\n`)); continue; }
    if (cmdL.startsWith("/model")) { process.stdout.write(chalk.dim("  Run /setup to reconfigure models\n")); continue; }
    if (inp.startsWith("/")) { process.stdout.write(helpText()); continue; }

    // ── Chat (real streaming) ──
    try {
      await streamResponse(currentAgent, inp);
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
