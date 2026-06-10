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
import { readLine, renderPalette, StreamRenderer } from "./tui";
import { loomChat } from "./loom_chat";

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
  .option("-m,--model <m>", "model")
  .option("--classic", "linear scrolling UI instead of the full-screen loom")
  .action(async (a: string, o: { model?: string; classic?: boolean }) => { await chat(a, o.model, o.classic); });
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
  const out = process.stdout;

  // ── Thinking spinner (animates until the first token lands; TTY only) ──
  const isTTY = !!out.isTTY;
  const frames = ["·  ", "·· ", " ··", "  ·"];
  let fi = 0, spinning = true;
  const draw = () => { if (spinning && isTTY) out.write(`\r  ${pigment(theme.symbol)} ${chalk.dim("思忖 " + frames[fi++ % frames.length])}`); };
  const timer = isTTY ? setInterval(draw, 140) : null; draw();
  const stopSpinner = () => { if (spinning) { spinning = false; if (timer) clearInterval(timer); if (isTTY) out.write("\r" + " ".repeat(20) + "\r"); } };

  let headerShown = false;
  let mode: "none" | "reasoning" | "content" = "none";
  let renderer: StreamRenderer | null = null;
  const header = () => { if (!headerShown) { out.write("\n  " + chalk.bold.hex(theme.hex)(`${theme.symbol} ${theme.kanji}`) + chalk.hex(theme.hex)(` ${theme.name}`) + "\n\n"); headerShown = true; } };
  const endBlock = () => { if (renderer) { renderer.flush(); renderer = null; out.write("\n"); } };

  // ── Ctrl-C interrupts this turn (keeps partial output); a 2nd Ctrl-C exits. ──
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) { out.write(chalk.dim("\n  再会。\n")); process.exit(130); }
    interrupted = true;
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    for await (const ev of agent.chatStream(input, controller.signal)) {
      if (ev.type === "interrupted") { interrupted = true; continue; }
      switch (ev.type) {
        case "reasoning":
          stopSpinner();
          if (mode !== "reasoning") { out.write(chalk.dim("  ◦ 思考  ")); mode = "reasoning"; }
          out.write(chalk.dim.italic(String(ev.text).replace(/\s+/g, " ")));
          break;
        case "content":
          stopSpinner();
          if (mode === "reasoning") out.write("\n");
          if (mode !== "content") { header(); renderer = new StreamRenderer(out, { gutter: "  " }); mode = "content"; }
          renderer!.write(String(ev.text));
          break;
        case "tool_status":
          stopSpinner();
          endBlock();
          out.write("\n  " + pigment(`${theme.symbol} ${ev.tool_name}`) + (ev.label ? chalk.dim(`  ${ev.label}`) : "") + chalk.dim(" …") + "\n");
          mode = "none";
          break;
        case "tool_done":
          out.write("  " + (ev.success ? chalk.hex("#3a7a6e")("✓") : chalk.hex("#b3342d")("✗")) + " " + chalk.dim(String(ev.tool_name)) + "\n");
          mode = "none";
          break;
        case "truncated":
          endBlock();
          out.write(chalk.yellow(`\n  ⚠ ${ev.reason}\n`));
          break;
        case "done":
          break;
      }
    }
  } catch (e: any) {
    // Abort surfaces here only if the network rejected before a clean stop.
    if (!interrupted && e?.name !== "AbortError") throw e;
  } finally {
    process.removeListener("SIGINT", onSigint);
    stopSpinner();
    endBlock();
  }
  if (interrupted) out.write(chalk.dim("\n  ⊘ 已中断（保留以上内容）\n"));
  out.write("\n");
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

async function chat(agentName: string, modelOverride?: string, classic?: boolean): Promise<void> {
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

  // ── 立轴 (full-screen loom) is the default on a real terminal;
  //    --classic / SKYLOOM_CLASSIC=1 / pipes fall back to the linear UI. ──
  const wantLoom =
    !classic &&
    !process.env.SKYLOOM_CLASSIC &&
    !!process.stdout.isTTY && !!process.stdin.isTTY &&
    (process.stdout.rows || 24) >= 14 && (process.stdout.columns || 80) >= 60;
  if (wantLoom) {
    await loomChat(ctx, agent, { version: VERSION, setupWizard, saveApiKey });
    return; // loomChat exits the process itself
  }

  // eslint-disable-next-line prefer-const
  let currentAgent = agent; // mutable for agent switching
  let lastSessions: any[] = []; // index→session map for /resume <n>
  welcome(agent);

  process.stdout.write(chalk.dim("  · 输入 / 看命令（Tab 补全）· ↑↓ 翻历史 · Ctrl-C 退出\n\n"));

  while (true) {
    let inp = await readLine(currentAgent.name);
    if (!inp) continue;

    // Bare "/" → show the inline command palette
    if (inp === "/") { process.stdout.write("\n" + renderPalette("") + "\n"); continue; }

    const cmdL = inp.toLowerCase();

    // Agent switch — stamp a mineral seal on change
    let switched = false;
    for (const n of AGENT_NAMES) {
      if (cmdL === "/" + n) {
        const a = ctx.agentMap.get(n);
        if (a) {
          await a.init(); currentAgent = a;
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
    if (cmdL === "/help") { process.stdout.write("\n" + renderPalette("") + "\n"); continue; }
    if (cmdL === "/version") { process.stdout.write("  Skyloom v" + VERSION + "\n"); continue; }
    if (cmdL === "/status") { process.stdout.write(chalk.bold("\n  " + currentAgent.displayName + " (" + currentAgent.name + ")\n") + chalk.dim("  State: " + currentAgent.state + "  ·  Memory: " + currentAgent.memory.shortTerm.length + " msgs\n\n")); continue; }
    if (cmdL === "/cost") { process.stdout.write(chalk.bold("\n  Total: " + formatCost(ctx.llm.getTotalCost()) + "\n\n")); continue; }
    if (cmdL === "/cost reset") { (ctx.llm as any).resetUsageStats?.(); process.stdout.write(chalk.dim("  Stats reset\n")); continue; }
    if (cmdL === "/compact") { const r = await currentAgent.compact(); process.stdout.write(chalk.green("  ✓ " + r + "\n\n")); continue; }
    if (cmdL === "/memory") { process.stdout.write(chalk.dim("  Short-term: " + currentAgent.memory.shortTerm.length + " msgs  ·  Working: " + Object.keys(currentAgent.memory.working).length + " keys\n")); continue; }
    if (cmdL === "/memory clear") { await currentAgent.memory.clearShortTerm(); process.stdout.write(chalk.dim("  Memory cleared\n")); continue; }
    if (cmdL === "/workspace") { process.stdout.write(chalk.dim("  " + (ctx.workspacePath || "default") + "\n")); continue; }
    if (cmdL === "/sessions") {
      lastSessions = await currentAgent.memory.listSessions();
      const active = currentAgent.memory.getActiveSession();
      const t = agentTheme(currentAgent.name);
      process.stdout.write("\n  " + chalk.bold.hex(t.hex)(`${t.symbol} ${t.kanji} 会话`) + chalk.dim(`  (${lastSessions.length})\n`));
      if (lastSessions.length === 0) process.stdout.write(chalk.dim("  （暂无历史会话）\n"));
      lastSessions.slice(0, 20).forEach((s, i) => {
        const mark = s.id === active ? chalk.hex(t.hex)("●") : chalk.dim("·");
        const preview = (s.preview || "(空)").replace(/\s+/g, " ").slice(0, 42);
        process.stdout.write(`  ${mark} ${chalk.dim(String(i + 1).padStart(2))} ${preview} ${chalk.dim(`· ${s.messageCount}条 · ${s.id?.slice(0, 8)}`)}\n`);
      });
      process.stdout.write(chalk.dim("  /resume <序号或id> 恢复 · /new 新会话\n\n"));
      continue;
    }
    if (cmdL === "/new") {
      await currentAgent.memory.clearShortTerm();
      const id = await currentAgent.memory.createSession();
      process.stdout.write("\n  " + chalk.green("✦ 新会话已开始") + chalk.dim(`  · ${String(id).slice(0, 8)}\n\n`));
      continue;
    }
    if (cmdL === "/resume" || cmdL.startsWith("/resume ")) {
      const arg = inp.slice(7).trim();
      if (!lastSessions.length) lastSessions = await currentAgent.memory.listSessions();
      let target: any = null;
      if (!arg) target = lastSessions[0]; // most recent
      else if (/^\d+$/.test(arg)) target = lastSessions[parseInt(arg) - 1];
      else target = lastSessions.find((s) => String(s.id).startsWith(arg));
      if (!target) { process.stdout.write(chalk.yellow("\n  未找到该会话。先 /sessions 看列表。\n\n")); continue; }
      const ok = await currentAgent.memory.loadSession(target.id);
      if (!ok) { process.stdout.write(chalk.yellow("\n  恢复失败。\n\n")); continue; }
      const n = currentAgent.memory.shortTerm.filter((m: any) => m.role !== "system").length;
      const t = agentTheme(currentAgent.name);
      process.stdout.write("\n  " + chalk.bold.hex(t.hex)("↺ 已恢复会话") + chalk.dim(`  · ${n} 条消息 · ${String(target.id).slice(0, 8)}\n`));
      process.stdout.write(chalk.dim(`  「${(target.preview || "").replace(/\s+/g, " ").slice(0, 50)}」\n\n`));
      continue;
    }
    if (cmdL === "/mcp") { process.stdout.write(chalk.dim("  " + (ctx.mcpStatus?.join(", ") || "none") + "\n")); continue; }
    if (cmdL.startsWith("/apikey set ")) { const p = inp.split(/\s+/); if (p.length >= 4) { saveApiKey(p[2], p[3]); process.stdout.write(chalk.green("  ✓ Saved " + p[2] + " API key\n")); } else { process.stdout.write(chalk.yellow("  Usage: /apikey set <provider> <key>\n")); } continue; }
    if (cmdL === "/apikey") { process.stdout.write(chalk.bold("\n  API Keys:\n")); for (const p of ["openai","deepseek","anthropic","groq","openrouter"]) { process.stdout.write(chalk.dim("  " + p.padEnd(14) + (!!process.env[p.toUpperCase() + "_API_KEY"] ? chalk.green("env") : chalk.dim("—")) + "\n")); } process.stdout.write("\n"); continue; }
    if (cmdL === "/plan" || cmdL === "/auto" || cmdL === "/default") {
      MODE.set(cmdL === "/plan" ? InteractiveMode.PLAN : cmdL === "/auto" ? InteractiveMode.AUTO : InteractiveMode.DEFAULT);
      currentAgent.planMode = MODE.current === InteractiveMode.PLAN;
      process.stdout.write(chalk.dim(`  模式 → ${MODE.current} · ${MODE.describe()}\n`));
      continue;
    }
    if (cmdL === "/context") {
      try {
        const d = currentAgent.contextDetail();
        process.stdout.write(chalk.bold(`\n  上下文 ${d.estimatedTokens}/${d.maxTokens} tokens (${d.pct}%)`) + chalk.dim(` · ${d.model}\n`));
        process.stdout.write(chalk.dim(`  系统提示 ≈${d.systemPromptTokens} tk · 工具 ${d.toolCount} 个\n`));
        for (const [role, v] of Object.entries(d.byRole as Record<string, { tokens: number; count: number }>)) {
          process.stdout.write(chalk.dim(`  ${role.padEnd(9)} ${String(v.tokens).padStart(6)} tk · ${v.count} 条\n`));
        }
        process.stdout.write("\n");
      } catch (e: any) { process.stdout.write(chalk.dim(`  无法获取: ${e?.message || e}\n`)); }
      continue;
    }
    if (cmdL === "/verify") {
      const { resolveVerifyConfig, runVerify } = require("../core/verify");
      const vc = resolveVerifyConfig((ctx as any).config);
      if (!vc.commands.length) { process.stdout.write(chalk.dim("  未配置验证命令 — config.yaml verify.commands 或 SKY.md ## Verify\n")); continue; }
      process.stdout.write(chalk.dim(`  ⚙ verify · ${vc.commands.length} 条命令\n`));
      const vr = runVerify(vc);
      process.stdout.write("  " + vr.report.split("\n").slice(0, 30).join("\n  ") + "\n");
      continue;
    }
    if (cmdL === "/init") {
      const { INIT_PROMPT } = require("../core/skymd");
      process.stdout.write(chalk.dim("  开始扫描项目，生成 SKY.md …\n"));
      try { await streamResponse(currentAgent, INIT_PROMPT); currentAgent.reloadProjectMemory(); }
      catch (e: any) { process.stdout.write(chalk.red("  ✗ " + (e.message || e) + "\n")); }
      continue;
    }
    if (cmdL.startsWith("/task ")) { const g = inp.slice(6); process.stdout.write(chalk.cyan("\n  ✦ " + g + "\n\n")); await runTask(g); continue; }
    if (cmdL === "/setup") { const r = await setupWizard(); if (r) process.stdout.write(chalk.green(`  ${r.provider} · ${r.model} — Ready!\n`)); continue; }
    if (cmdL.startsWith("/model")) { process.stdout.write(chalk.dim("  Run /setup to reconfigure models\n")); continue; }
    if (inp.startsWith("/")) { process.stdout.write("\n" + chalk.dim(`  未知命令 ${inp.split(" ")[0]}\n`) + renderPalette(cmdL.split(" ")[0]) + "\n"); continue; }

    // ── input macros: # quick memory · ! shell · @file attach ──
    {
      const macros = require("./input_macros");
      if (macros.isHashMemory(inp)) {
        try {
          const { appendQuickMemory } = require("../core/skymd");
          const file = appendQuickMemory(macros.hashNote(inp));
          currentAgent.reloadProjectMemory();
          process.stdout.write(chalk.green("  ✦ 已记入 ") + chalk.dim(file + "\n"));
        } catch (e: any) { process.stdout.write(chalk.dim(`  记忆写入失败: ${e?.message || e}\n`)); }
        continue;
      }
      if (macros.isBangCommand(inp)) {
        const cmd = macros.bangCommand(inp);
        process.stdout.write(chalk.dim(`  $ ${cmd}\n`));
        const r = macros.runBang(cmd);
        process.stdout.write("  " + r.output.split("\n").slice(0, 40).join("\n  ") + "\n");
        currentAgent.memory.addMessage("system", `[用户执行 shell] $ ${cmd}\n${r.output.slice(0, 4000)}`);
        continue;
      }
      const expanded = macros.expandFileRefs(inp);
      if (expanded.attached.length) process.stdout.write(chalk.dim(`  已附加 ${expanded.attached.map((f: string) => "@" + f).join(" ")}\n`));
      inp = expanded.text;
    }

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
   Headless mode — sky -p "..." (pipes, CI, external orchestrators)
   ═══════════════════════════════════════ */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

async function runHeadless(
  prompt: string,
  opts: { agent?: string; json?: boolean; streamJson?: boolean }
): Promise<void> {
  // Fresh session: a one-shot invocation must not inherit (or pollute) the
  // interactive resume chain.
  process.env.WA_NO_RESUME = "1";
  const t0 = Date.now();
  const ctx = createSystemContext();
  const agentName = opts.agent || "fog";
  const agent = ctx.agentMap.get(agentName);
  if (!agent) { process.stderr.write(`Unknown agent: ${agentName}\n`); process.exit(1); }
  await agent.init();

  // No human to approve: dangerous tools are denied unless explicitly allowed.
  try {
    const { getSecurity } = require("../core/security");
    getSecurity().setApprovalCallback(async () =>
      process.env.SKYLOOM_ALLOW_DANGEROUS === "1");
  } catch { /* optional */ }

  const emit = (obj: Record<string, any>) => process.stdout.write(JSON.stringify(obj) + "\n");
  let content = "";
  let ok = true;
  try {
    for await (const ev of agent.chatStream(prompt)) {
      if (opts.streamJson) { emit(ev); if (ev.type === "content") content += ev.text; continue; }
      switch (ev.type) {
        case "content":
          content += ev.text;
          if (!opts.json) process.stdout.write(String(ev.text));
          break;
        case "tool_status":
          if (!opts.json) process.stderr.write(`[tool] ${ev.tool_name} ${ev.label || ""}\n`);
          break;
        case "truncated":
          ok = false;
          process.stderr.write(`[truncated] ${ev.reason}\n`);
          break;
      }
    }
  } catch (e: any) {
    ok = false;
    process.stderr.write(`Error: ${e?.message || e}\n`);
  }

  if (opts.json || opts.streamJson) {
    emit({
      type: "result",
      success: ok,
      agent: agentName,
      model: (() => { try { return agent.contextUsage().model; } catch { return undefined; } })(),
      content,
      cost_usd: (() => { try { return ctx.llm.getTotalCost(); } catch { return 0; } })(),
      duration_ms: Date.now() - t0,
    });
  } else if (content && !content.endsWith("\n")) {
    process.stdout.write("\n");
  }
  await ctx.closeAll();
  process.exit(ok ? 0 : 1);
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


/* ═══════════════════════════════════════
   Entry
   ═══════════════════════════════════════ */
async function main() {
  const args = process.argv.slice(2);
  const classic = args.includes("--classic");

  // ── headless: sky -p "prompt" [--agent fog] [--json | --stream-json] ──
  const pIdx = args.findIndex((a) => a === "-p" || a === "--print");
  if (pIdx >= 0) {
    const flags = new Set(args);
    const agentIdx = args.findIndex((a) => a === "--agent");
    const agentName = agentIdx >= 0 ? args[agentIdx + 1] : undefined;
    const inline = args[pIdx + 1] && !args[pIdx + 1].startsWith("-") ? args[pIdx + 1] : "";
    const piped = await readStdin();
    const prompt = [inline, piped].filter(Boolean).join("\n\n");
    if (!prompt) { process.stderr.write('Usage: sky -p "prompt" [--agent fog] [--json|--stream-json]\n'); process.exit(1); }
    await runHeadless(prompt, {
      agent: agentName,
      json: flags.has("--json"),
      streamJson: flags.has("--stream-json"),
    });
    return;
  }

  const rest = args.filter((a) => a !== "--classic");
  if (rest.length === 0) { await chat("fog", undefined, classic); return; }
  if ((AGENT_NAMES as readonly string[]).includes(rest[0])) {
    let m: string | undefined;
    for (let i = 1; i < rest.length; i++) if ((rest[i] === "-m" || rest[i] === "--model") && i + 1 < rest.length) m = rest[++i];
    await chat(rest[0], m, classic); return;
  }
  if (!["chat", "task", "web", "config", "init", "version", "mcp", "help"].includes(rest[0]) && !rest[0].startsWith("-")) { await chat("fog", undefined, classic); return; }
  program.parse(process.argv);
}

main().catch(e => { process.stderr.write(chalk.red(`Fatal: ${(e as Error).message}\n`)); process.exit(1); });
