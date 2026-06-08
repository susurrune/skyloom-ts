#!/usr/bin/env node
/**
 * 天空织机 CLI — Skyloom Terminal Interface
 * Raw-mode input + slash command popup + streaming display
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
const VERSION = "1.4.2";

/* ── Agent colors ── */
const AGENT_COLORS: Record<string, string> = {
  fog: "#b8c6db", rain: "#4a90d9", frost: "#2cd4d4",
  snow: "#e8ecf1", dew: "#7bed9f", fair: "#f7b733",
};
const AGENT_DISPLAY: Record<string, string> = {
  fog: "≋ 雾 Fog", rain: "⸽ 雨 Rain", frost: "✱ 霜 Frost",
  snow: "❉ 雪 Snow", dew: "∘ 露 Dew", fair: "☼ 晴 Fair",
};
const AGENT_NAMES = ["fog", "rain", "frost", "snow", "dew", "fair"] as const;

/* ═══════════════════════════════════════
   Commander program
   ═══════════════════════════════════════ */
const program = new Command()
  .name("sky").description("天空织机 Skyloom — 6 weather-themed AI agents").version(VERSION);

program.command("chat").description("Start interactive chat")
  .argument("[agent]", "agent name", "fog")
  .option("-m,--model <model>", "Model override")
  .action(async (a: string, o: { model?: string }) => { await chat(a, o.model); });

program.command("task").description("Multi-agent orchestration")
  .argument("[goal]", "task goal")
  .option("-r,--resume", "resume from checkpoint")
  .action(async (g?: string, o?: { resume?: boolean }) => { if (g) await runTask(g, o?.resume); });

program.command("web").description("Start web server")
  .option("-p,--port <port>", "port", "3000")
  .action(async (o: { port?: string }) => { const { startWebServer } = await import("../web/server"); await startWebServer(parseInt(o.port || "3000", 10)); });

program.command("mcp").description("Start MCP server")
  .action(async () => { const { startMCPServer } = await import("../core/mcp_server"); await startMCPServer(); });

program.command("config").description("Show configuration")
  .action(() => { const c = loadConfig(); logLine(chalk.cyan("Config dir: ") + USER_CONFIG_DIR); logLine(chalk.cyan("Agent models:")); for (const [n, a] of Object.entries(c.agents || {})) logLine(`  ${chalk.bold(n)}: ${(a as any).model || "default"}`); });

program.command("init").description("Initialize config directory")
  .action(() => { const d = USER_CONFIG_DIR; if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); logLine(chalk.green("✓ ") + d); });

program.command("version").description("Show version")
  .action(() => logLine(`Skyloom v${VERSION}`));

/* ═══════════════════════════════════════
   Interactive Chat — raw-mode input + popup
   ═══════════════════════════════════════ */
const SLASH_CMDS: [string, string, boolean, string][] = [
  ["/help", "Show all commands", false, ""],
  ["/clear", "Clear screen", false, ""],
  ["/status", "Agent overview", false, ""],
  ["/cost", "Usage & cost", false, ""],
  ["/cost reset", "Reset usage stats", false, ""],
  ["/compact", "Compress context", false, ""],
  ["/retry", "Resend last message", false, ""],
  ["/mcp", "MCP server status", false, ""],
  ["/memory", "Memory stats", false, ""],
  ["/sessions", "Session list", false, ""],
  ["/workspace", "Workspace info", false, ""],
  ["/model", "Model info", false, ""],
  ["/version", "Version info", false, ""],
  ["/task <goal>", "Multi-agent orchestrate", true, ""],
  ["/quiz", "Export chat as quiz", false, ""],
  ["/fog", "≋ Fog — research", false, "fog"],
  ["/rain", "⸽ Rain — codegen", false, "rain"],
  ["/frost", "✱ Frost — review", false, "frost"],
  ["/snow", "❉ Snow — planning", false, "snow"],
  ["/dew", "∘ Dew — devops", false, "dew"],
  ["/fair", "☼ Fair — companion", false, "fair"],
  ["/quit", "Exit chat", false, ""],
  ["/exit", "Exit chat", false, ""],
];

function logLine(s: string) { process.stdout.write(s + "\n"); }

/* ── Stream response with spinner ── */
async function chatWithSpinner(
  agent: any, ctx: any, message: string
): Promise<string> {
  let frame = 0;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = setInterval(() => {
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(chalk.cyan(`  ${frames[frame % frames.length]} ${agent.displayName} thinking...`));
    frame++;
  }, 80);

  try {
    const response = await agent.chat(message);
    clearInterval(spinner);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(" ".repeat(50) + "\r");
    return response;
  } catch (e) {
    clearInterval(spinner);
    throw e;
  }
}

/* ── Render response ── */
function renderResponse(text: string): string[] {
  const lines: string[] = [];
  const w = process.stdout.columns || 80;
  const maxW = Math.min(w - 6, 76);
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    // Code blocks
    if (trimmed.startsWith("```")) {
      const codeLines = trimmed.split("\n");
      lines.push(chalk.dim("  ┌─ code ──────────────"));
      for (let i = 1; i < codeLines.length - 1; i++) {
        const cl = codeLines[i];
        lines.push(`  ${chalk.dim("│")} ${chalk.white(cl.slice(0, maxW - 4))}`);
      }
      lines.push(chalk.dim("  └────────────────────"));
      continue;
    }
    // Wrap long lines
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("#")) {
        lines.push("  " + chalk.bold(line));
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        lines.push("  " + chalk.dim("• ") + line.slice(2));
      } else {
        let remaining = line;
        while (remaining.length > maxW) {
          const cut = remaining.lastIndexOf(" ", maxW);
          const idx = cut > 0 ? cut : maxW;
          lines.push("  " + remaining.slice(0, idx));
          remaining = remaining.slice(idx).trimStart();
        }
        if (remaining) lines.push("  " + remaining);
      }
    }
  }
  return lines;
}

/* ── Welcome banner ── */
function printWelcome(agent: any, model: string) {
  const w = process.stdout.columns || 80;
  logLine("");
  logLine(" ".repeat(Math.max(0, Math.floor((w - 40) / 2))) + chalk.cyan("✦    天 空 织 机    ✦"));
  logLine(" ".repeat(Math.max(0, Math.floor((w - 36) / 2))) + chalk.dim("S K Y L O O M"));
  logLine("");
  const agentLine: string[] = [];
  for (const name of AGENT_NAMES) {
    const active = name === agent.name;
    const prefix = active ? chalk.bold(AGENT_DISPLAY[name].split(" ").slice(0, 2).join(" ")) : chalk.dim(AGENT_DISPLAY[name].split(" ")[0] + " " + AGENT_DISPLAY[name].split(" ")[1]);
    agentLine.push(prefix);
  }
  logLine("  " + agentLine.join(chalk.dim("  ·  ")));
  logLine("");
  logLine(chalk.dim(`  Model: ${model}  ·  /help for commands  ·  /quit to exit`));
  logLine("");
}

/* ── Status bar ── */
function statusBar(agent: any, ctx: any): string {
  let ctxStr = "";
  let costStr = "$0";
  let modelStr = "default";
  try {
    const cu = agent.contextUsage();
    modelStr = cu.model || "?";
    const pct = cu.pct || 0;
    const barColor = pct < 50 ? chalk.green : pct < 80 ? chalk.yellow : chalk.red;
    const barLen = Math.round(pct / 10);
    ctxStr = `${barColor("█".repeat(barLen) + "░".repeat(10 - barLen))} ${pct}%`;
    costStr = formatCost(ctx.llm.getTotalCost());
  } catch { /* ignore */ }
  const w = process.stdout.columns || 80;
  return chalk.dim(`┤ ${ctxStr}  ·  ${costStr}  ·  ${modelStr}  ├${"─".repeat(Math.max(0, w - 60))}`);
}

function formatCost(cost: number): string {
  if (cost >= 1) return chalk.yellow(`$${cost.toFixed(2)}`);
  if (cost >= 0.01) return chalk.yellow(`$${cost.toFixed(4)}`);
  if (cost > 0) return chalk.green(`${(cost * 100).toFixed(2)}¢`);
  return "$0";
}

/* ── Slash-command popup ── */
async function readWithPopup(agent: any, ctx: any): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise<string>(resolve => {
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => { rl.close(); resolve(line.trim()); });
    });
  }

  return new Promise<string>(resolve => {
    const stdin = process.stdin;
    try { stdin.setRawMode?.(true); } catch { /* non-TTY */ }
    stdin.resume();

    let buf = "";
    let cursor = 0;
    let popup = false;
    let selIdx = 0;
    const _history: string[] = (readWithPopup as any)._popupHistory || [];
    let histIdx = _history.length;

    function render() {
      const w = process.stdout.columns || 80;
      readline.cursorTo(process.stdout, 0);

      // Clear current line area
      const promptLine = `  ${chalk.cyan(agent.displayName)} ${chalk.dim("❯")} `;

      // Build filtered commands
      const filtered = popup ? SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase())) : [];
      if (filtered.length && selIdx >= filtered.length) selIdx = filtered.length - 1;

      const popupH = Math.min(filtered.length, 10);
      const totalH = popup ? popupH + 3 : 1;

      // Move cursor up
      if (popup) {
        for (let i = 0; i < popupH + 2; i++) process.stdout.write("\x1b[1A\x1b[2K");
      } else {
        process.stdout.write("\x1b[2K\r");
      }

      // Input line
      const before = buf.slice(0, cursor);
      const after = buf.slice(cursor);
      const cursorChar = after[0] || " ";
      process.stdout.write(promptLine + before + chalk.inverse(cursorChar) + after.slice(1) + "\n");

      // Popup
      if (popup && filtered.length) {
        const maxW = Math.min(w - 4, 60);
        const start = Math.max(0, Math.min(selIdx - 4, filtered.length - 8));
        const end = Math.min(filtered.length, start + 8);
        process.stdout.write(chalk.dim(`  ┌─ commands (↑↓ pick · type to filter · tab/enter select · esc close)${"─".repeat(Math.max(0, maxW - 58))}┐\n`));
        for (let i = start; i < end; i++) {
          const [cmd, desc] = filtered[i];
          const marker = i === selIdx ? chalk.cyan(" ▶ ") : "   ";
          const cmdColored = i === selIdx ? chalk.bold(cmd) : chalk.cyan(cmd);
          const line = `  │${marker}${cmdColored.padEnd(24)}${chalk.dim(desc)}`;
          process.stdout.write(line + " ".repeat(Math.max(0, maxW - line.length + 6)) + "│\n");
        }
        process.stdout.write(chalk.dim(`  └${"─".repeat(maxW + 1)}┘\n`));
      }

      // Status bar
      process.stdout.write(statusBar(agent, ctx) + (popup ? "" : "\n"));
    }

    function accept(line: string) {
      try { stdin.setRawMode?.(false); } catch { }
      stdin.pause();
      resolve(line);
    }

    stdin.on("data", (data: Buffer) => {
      const seq = data.toString();
      for (const ch of seq) {
        // Esc
        if (ch === "\x1b") {
          if (popup) { popup = false; render(); return; }
          accept(""); return;
        }
        // Enter
        if (ch === "\r" || ch === "\n") {
          if (popup && SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase())).length) {
            const filtered = SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase()));
            buf = filtered[selIdx]?.[0] || buf;
            popup = false;
          }
          accept(buf.trim()); return;
        }
        // Tab
        if (ch === "\t") {
          if (popup && SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase())).length) {
            const filtered = SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase()));
            buf = filtered[selIdx]?.[0] || buf;
            cursor = buf.length;
            popup = false;
            render(); return;
          }
          // Insert 2 spaces
          buf = buf.slice(0, cursor) + "  " + buf.slice(cursor);
          cursor += 2;
          render(); return;
        }
        // Backspace
        if (ch === "\x7f" || ch === "\b") {
          if (cursor > 0) { buf = buf.slice(0, cursor - 1) + buf.slice(cursor); cursor--; }
          if (!buf) { popup = false; }
          render(); return;
        }
        // Ctrl+C
        if (ch === "\x03") { accept("/quit"); return; }
        // Printable
        if (ch >= " ") {
          buf = buf.slice(0, cursor) + ch + buf.slice(cursor);
          cursor++;
          if (buf === "/") { popup = true; selIdx = 0; }
          else if (popup) { selIdx = 0; }
          render(); return;
        }
      }
    });

    // Arrow keys come as escape sequences — handle via process.stdin
    // For simplicity, arrow keys in raw mode are: \x1b[A (up), \x1b[B (down), \x1b[C (right), \x1b[D (left)
    // We handle them in the data handler above by checking for escape sequences
    // Actually the raw mode data comes byte by byte — let me use a state machine approach
    // For now, let me handle the common case: the full escape sequence arrives in one data event

    // Note: Arrow keys are 3 bytes: \x1b [ A/B/C/D. They may arrive in one or multiple data events.
    // In practice on Windows they arrive as one event. Let me add a simple buffered approach.

    stdin.removeAllListeners("data");

    let escBuf = "";
    stdin.on("data", (data: Buffer) => {
      const str = data.toString();
      escBuf += str;

      // If we have an escape sequence, process it
      if (escBuf.startsWith("\x1b[")) {
        if (escBuf.length >= 3) {
          const code = escBuf[2];
          escBuf = "";
          if (code === "A") {
            if (popup) { selIdx = Math.max(0, selIdx - 1); } else if (_history.length) { histIdx = Math.max(0, histIdx - 1); buf = _history[histIdx] || ""; cursor = buf.length; }
            render(); return;
          }
          if (code === "B") {
            if (popup) { const f = SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase())); selIdx = Math.min(f.length - 1, selIdx + 1); }
            else if (_history.length && histIdx < _history.length) { histIdx++; buf = _history[histIdx] || ""; cursor = buf.length; }
            render(); return;
          }
          if (code === "C") { if (cursor < buf.length) cursor++; if (popup) popup = false; render(); return; }
          if (code === "D") { if (cursor > 0) cursor--; if (popup) popup = false; render(); return; }
        } else { return; /* wait for more bytes */ }
      }

      // Not an escape sequence — process normally
      for (const ch of escBuf) {
        escBuf = "";
        if (ch === "\x1b") { if (popup) { popup = false; render(); } return; }
        if (ch === "\r" || ch === "\n") {
          if (popup && SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase())).length) {
            buf = SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase()))[selIdx]?.[0] || buf;
            popup = false;
          }
          accept(buf.trim()); return;
        }
        if (ch === "\t") {
          if (popup && SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase())).length) {
            const filtered = SLASH_CMDS.filter(c => c[0].toLowerCase().includes(buf.toLowerCase()));
            buf = filtered[selIdx]?.[0] || buf;
            cursor = buf.length; popup = false;
            render(); return;
          }
          buf = buf.slice(0, cursor) + "  " + buf.slice(cursor); cursor += 2;
          render(); return;
        }
        if (ch === "\x7f" || ch === "\b") { if (cursor > 0) { buf = buf.slice(0, cursor - 1) + buf.slice(cursor); cursor--; } if (!buf) popup = false; render(); return; }
        if (ch === "\x03") { accept("/quit"); return; }
        if (ch >= " ") {
          buf = buf.slice(0, cursor) + ch + buf.slice(cursor); cursor++;
          if (buf === "/") { popup = true; selIdx = 0; }
          else if (popup) selIdx = 0;
          render(); return;
        }
      }
    });

    render();
  });
}

/* ═══════════════════════════════════════
   Main chat loop
   ═══════════════════════════════════════ */
async function chat(agentName: string, modelOverride?: string): Promise<void> {
  const ctx = createSystemContext();
  let agent = ctx.agentMap.get(agentName);
  if (!agent) { logLine(chalk.red(`Unknown agent: ${agentName}`)); return; }
  await agent.init();

  const model = modelOverride || "default";
  printWelcome(agent, model);

  const inputHistory: string[] = [];

  while (true) {
    /* ── Read input ── */
    const inp = await readWithPopup(agent, ctx);
    if (!inp) { logLine(""); continue; }

    // Save to history
    if (!inputHistory[inputHistory.length - 1] || inputHistory[inputHistory.length - 1] !== inp) {
      inputHistory.push(inp);
      if (inputHistory.length > 50) inputHistory.shift();
    }
    (readWithPopup as any)._popupHistory = inputHistory;

    const cmd = inp.trim();
    const cmdLower = cmd.toLowerCase();

    /* ── Slash commands ── */
    let handled = false;

    // Agent switching
    for (const n of AGENT_NAMES) {
      if (cmdLower === `/${n}`) {
        const newAgent = ctx.agentMap.get(n);
        if (newAgent) {
          await newAgent.init();
          // Switch agent reference (mutate closure)
          logLine(chalk.dim(`\n  ⟳  ${AGENT_DISPLAY[n]}\n`));
          // We can't reassign the outer `agent` const, so use a workaround
          (chat as any)._currentAgent = newAgent;
          (chat as any)._currentCtx = ctx;
          // Actually, let me handle this differently — replace the agent in the closure
          agent = newAgent;
        }
        handled = true; break;
      }
    }

    if (cmdLower === "/quit" || cmdLower === "/exit") break;
    if (cmdLower === "/help") { printHelp(); handled = true; }
    if (cmdLower === "/clear") { console.clear(); handled = true; }
    if (cmdLower === "/version") { logLine(`  Skyloom v${VERSION}`); handled = true; }
    if (cmdLower === "/status") {
      logLine(chalk.bold(`\n  ${agent.displayName} (${agent.name})`));
      logLine(chalk.dim(`  State: ${agent.state}  ·  Specialty: ${agent.specialty}`));
      logLine(chalk.dim(`  Memory: ${agent.memory.shortTerm.length} messages  ·  ${Object.keys(agent.memory.working).length} working keys`));
      handled = true;
    }
    if (cmdLower === "/cost") {
      logLine(chalk.bold("\n  Usage & Cost"));
      logLine(chalk.dim("  ─".repeat(24)));
      logLine(`  Total: ${formatCost(ctx.llm.getTotalCost())}`);
      handled = true;
    }
    if (cmdLower === "/cost reset") { (ctx.llm as any).resetUsageStats?.(); logLine(chalk.dim("  Stats reset")); handled = true; }
    if (cmdLower === "/compact") {
      logLine(chalk.dim("  Compacting..."));
      const r = await agent.compact();
      logLine(chalk.green(`  ✓ ${r}`));
      handled = true;
    }
    if (cmdLower === "/memory") {
      logLine(chalk.bold("\n  Memory"));
      logLine(chalk.dim(`  Short-term: ${agent.memory.shortTerm.length} msgs  ·  Working: ${Object.keys(agent.memory.working).length} keys`));
      handled = true;
    }
    if (cmdLower === "/workspace") {
      logLine(chalk.dim(`\n  Workspace: ${ctx.workspacePath || "default"}`));
      handled = true;
    }
    if (cmdLower === "/mcp") {
      logLine(chalk.dim(`\n  MCP servers: ${ctx.mcpStatus?.length ? ctx.mcpStatus.join(", ") : "none configured"}`));
      handled = true;
    }
    if (cmdLower === "/sessions") {
      const sessions = await agent.memory.listSessions();
      if (sessions.length) {
        logLine(chalk.bold("\n  Sessions"));
        for (const s of sessions.slice(0, 10)) {
          logLine(chalk.dim(`  ${s.id?.slice(0, 10)}... ${s.preview || ""} (${s.messageCount || 0} msgs)`));
        }
      } else { logLine(chalk.dim("  No saved sessions")); }
      handled = true;
    }
    if (cmdLower.startsWith("/model")) { logLine(chalk.dim(`  Model: ${modelOverride || "default"}. Configure in ~/.skyloom/config.yaml`)); handled = true; }
    if (cmdLower.startsWith("/task ")) {
      const goal = cmd.slice(6).trim();
      if (goal) { logLine(chalk.cyan(`\n  ✦ Orchestrating: ${goal}\n`)); await runTask(goal); }
      handled = true;
    }

    if (handled) { logLine(""); continue; }

    /* ── Route message ── */
    const mode = MODE.current;
    if (mode === InteractiveMode.PLAN) {
      await runTask(cmd); logLine(""); continue;
    }

    const cls = classify(cmd);
    if (cls === "orchestrate" && mode !== InteractiveMode.AUTO) {
      await runTask(cmd); logLine(""); continue;
    }

    /* ── Chat ── */
    try {
      const response = await chatWithSpinner(agent, ctx, cmd);
      logLine("");
      for (const line of renderResponse(response)) {
        logLine(line);
      }
      logLine("");

      // Auto-continue
      if (mode === InteractiveMode.AUTO) {
        const tail = response.split("\n").slice(-6).join("\n");
        if (/(?:接下来|下一步|继续|next|let me|I'[vl]l)/i.test(tail) && !/(?:完成了|全部完成|all done)/i.test(tail)) {
          logLine(chalk.yellow("  [auto-continue]\n"));
          try {
            const r2 = await chatWithSpinner(agent, ctx, "请继续完成");
            logLine("");
            for (const line of renderResponse(r2)) logLine(line);
            logLine("");
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      logLine(chalk.red(`\n  ✗ Error: ${(e as Error).message || e}\n`));
    }
  }

  logLine(chalk.dim("\n  Session ended"));
  await ctx.closeAll();
  process.exit(0);
}

/* ═══════════════════════════════════════
   Task execution
   ═══════════════════════════════════════ */
async function runTask(goal: string, resume?: boolean): Promise<void> {
  const ctx = createSystemContext();
  await ctx.initAll();
  const [, results, summary] = await orchestrateTask(goal, ctx.agentMap, null, {
    resultTruncate: 500, maxTaskRetries: 3, maxReplanRounds: 1, resume,
  });

  logLine(chalk.bold("\n  Task Results"));
  logLine(chalk.dim("  ─".repeat(30)));
  for (const r of results) {
    logLine(`  ${r.success ? chalk.green("✓") : chalk.red("✗")} ${chalk.cyan(r.agent)}: ${r.description.slice(0, 60)}`);
  }
  logLine(chalk.bold("\n  Summary"));
  logLine(chalk.dim("  ─".repeat(30)));
  logLine(`  ${summary.slice(0, 1000)}`);
  logLine("");
  await ctx.closeAll();
}

function printHelp() {
  logLine(chalk.bold("\n  Slash Commands"));
  logLine(chalk.dim("  ─".repeat(40)));
  const groups: [string, [string, string][]][] = [
    ["Agent", [["/fog /rain /frost", "Switch agents"], ["/snow /dew /fair", "Switch agents"]]],
    ["Chat", [["/help", "Show commands"], ["/clear", "Clear screen"], ["/compact", "Compress context"], ["/retry", "Resend last msg"], ["/quit", "Exit"]]],
    ["Info", [["/status", "Agent status"], ["/cost", "Usage & cost"], ["/memory", "Memory stats"], ["/sessions", "Session list"], ["/workspace", "Workspace info"], ["/version", "Version"]]],
    ["Orch.", [["/task <goal>", "Multi-agent task"]]],
  ];
  for (const [title, cmds] of groups) {
    logLine(chalk.cyan(`  ${title}`));
    for (const [c, d] of cmds) logLine(`    ${chalk.cyan(c.padEnd(18))}${chalk.dim(d)}`);
  }
  logLine("");
}

/* ═══════════════════════════════════════
   Entry
   ═══════════════════════════════════════ */
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { await chat("fog"); return; }
  if ((AGENT_NAMES as readonly string[]).includes(args[0])) {
    let m: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if ((args[i] === "-m" || args[i] === "--model") && i + 1 < args.length) m = args[++i];
    }
    await chat(args[0], m); return;
  }
  const subCmds = ["chat", "task", "web", "config", "init", "version", "mcp", "help"];
  if (!subCmds.includes(args[0]) && !args[0].startsWith("-")) { await chat("fog"); return; }
  program.parse(process.argv);
}

main().catch(e => { logLine(chalk.red(`Fatal: ${(e as Error).message}`)); process.exit(1); });
