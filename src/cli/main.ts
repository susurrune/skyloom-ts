#!/usr/bin/env node
/**
 * 天空织机 CLI — Skyloom Terminal Interface
 */
import { Command } from "commander";
import * as fs from "fs";
import * as readline from "readline";
import chalk from "chalk";
import { createSystemContext } from "../core/factory";
import { loadConfig, USER_CONFIG_DIR } from "../core/config";
import { validateModel } from "../core/catalog";
import { agentTheme } from "../core/theme";
import { InteractiveMode, ModeController } from "./mode";
import { readLine, renderPalette } from "./tui";
import { loomChat } from "./loom_chat";
import { executeSlashCommand, type CommandRuntime } from "./command_handlers";
import { isTopLevelCommand, parseHeadlessInvocation, readPipedInput, selectChatSurface } from "./runtime";
import { formatCost, renderClassicCommandLine, streamResponse, welcome } from "./classic_runtime";
import { listTaskRuns, runHeadless, runTask } from "./headless";
import { channelsWizard, checkApiKeys, saveApiKey, setupWizard } from "./setup_wizards";
import { startWebCommand } from "./web_runtime";
import { runDoctorCommand } from "./doctor";
import { formatMcpHealthLines } from "../core/mcp";
const MODE = new ModeController();
const VERSION = (() => { try { return require("../../package.json").version; } catch { return "1.5.2"; } })();

const AGENT_NAMES = ["fog", "rain", "frost", "snow", "dew", "fair"] as const;

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
  .option("--resume [run-id]", "resume a failed or interrupted orchestration run")
  .option("--json", "machine-readable run result")
  .action(async (g: string | undefined, o: { resume?: boolean | string; json?: boolean }) => {
    const resume = o.resume !== undefined && o.resume !== false;
    process.exitCode = await runTask(g, {
      resume,
      runId: typeof o.resume === "string" ? o.resume : undefined,
      json: o.json,
    });
  });
program.command("runs").description("List durable orchestration runs")
  .option("--json", "machine-readable run list")
  .action((o: { json?: boolean }) => listTaskRuns(o.json));
program.command("web").option("-p,--port <p>", "port", "7777")
  .action(async (o: { port?: string }) => { await startWebCommand(parseInt(o.port || "7777")); });
program.command("mcp").action(() => { import("../core/mcp_server").then(m => m.startMCPServer()); });
program.command("gateway").description("Run the channel gateway (Feishu / WeCom / QQ)")
  .option("-p,--port <p>", "port", "8848")
  .action((o: { port?: string }) => { import("../gateway/gateway").then(m => m.startGateway({ port: parseInt(o.port || "8848") })); });
program.command("channels").description("Configure a chat channel (Feishu / WeCom / QQ) with QR shortcuts")
  .action(async () => { await channelsWizard(); });
program.command("config").action(() => { const c = loadConfig(); process.stdout.write(chalk.cyan("\nConfig: ") + USER_CONFIG_DIR + "\n"); for (const [n, a] of Object.entries(c.agents || {})) process.stdout.write(`  ${chalk.bold(n)}: ${(a as any).model || "default"}\n`); });
program.command("init").action(() => { if (!fs.existsSync(USER_CONFIG_DIR)) fs.mkdirSync(USER_CONFIG_DIR, { recursive: true }); process.stdout.write(chalk.green("✓ ") + USER_CONFIG_DIR + "\n"); });
program.command("apikey").description("Manage API keys (persisted to ~/.skyloom/config.yaml)")
  .argument("[action]", "set|list").argument("[provider]", "e.g. deepseek").argument("[key]", "API key")
  .action((action?: string, provider?: string, key?: string) => {
    if (action === "set" && provider && key) { saveApiKey(provider, key); process.stdout.write(chalk.green("✓ Saved " + provider + " API key\n")); }
    else { process.stdout.write(chalk.dim("Usage: sky apikey set deepseek YOUR_KEY\n")); }
  });
program.command("version").action(() => { process.stdout.write(`Skyloom v${VERSION}\n`); });
program.command("doctor").description("Diagnose configuration and runtime readiness")
  .option("--json", "machine-readable JSON output")
  .action(async (options: { json?: boolean }) => {
    process.exitCode = await runDoctorCommand({ json: options.json });
  });

/* ═══════════════════════════════════════
   Chat loop
   ═══════════════════════════════════════ */
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
  const agent = ctx.agentMap.get(agentName);
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

  // Interactive UI (loom or classic): route logs to a file so warn/error lines
  // (e.g. web_search provider timeouts) never paint over the TUI frame. Opt out
  // with SKYLOOM_LOG_CONSOLE=1; override path with SKYLOOM_LOG_FILE.
  if (process.env.SKYLOOM_LOG_CONSOLE !== "1") {
    try { require("../core/logger").setLogFile(process.env.SKYLOOM_LOG_FILE); } catch { /* optional */ }
  }

  // Wire up security approval — prompt user for HIGH/CRITICAL operations
  try {
    const { getSecurity, PERMISSION_MODE_ALIASES } = require("../core/security");
    const sec = getSecurity();
    // Honor a configured permission mode (config.yaml cli.approvalMode), mapped
    // through the same aliases as /perm.
    const cfgMode = (ctx as any).config?.cli?.approvalMode || (ctx as any).config?.cli?.approval_mode;
    if (cfgMode && PERMISSION_MODE_ALIASES[String(cfgMode).toLowerCase()]) {
      sec.setMode(PERMISSION_MODE_ALIASES[String(cfgMode).toLowerCase()]);
    }
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
  const surface = selectChatSurface({
    classic,
    forceClassic: !!process.env.SKYLOOM_CLASSIC,
    stdinTTY: !!process.stdin.isTTY,
    stdoutTTY: !!process.stdout.isTTY,
    rows: process.stdout.rows,
    columns: process.stdout.columns,
  });
  if (surface === "loom") {
    await loomChat(ctx, agent, { version: VERSION, setupWizard, saveApiKey });
    return; // loomChat exits the process itself
  }

  let currentAgent = agent; // mutable for agent switching
  const sessionCache: CommandRuntime["sessionCache"] = { items: [] };
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
          await a.init(); currentAgent = a; sessionCache.items = [];
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
    const sharedCommand = await executeSlashCommand(inp, {
      agent: currentAgent as unknown as CommandRuntime["agent"],
      config: (ctx as any).config,
      sessionCache,
    });
    if (sharedCommand.handled) {
      process.stdout.write("\n" + sharedCommand.lines.map(renderClassicCommandLine).join("") + "\n");
      continue;
    }
    if (cmdL === "/cost") { process.stdout.write(chalk.bold("\n  Total: " + formatCost(ctx.llm.getTotalCost()) + "\n\n")); continue; }
    if (cmdL === "/cost reset") { (ctx.llm as any).resetUsageStats?.(); process.stdout.write(chalk.dim("  Stats reset\n")); continue; }
    if (cmdL === "/compact") { const r = await currentAgent.compact(); process.stdout.write(chalk.green("  ✓ " + r + "\n\n")); continue; }
    if (cmdL === "/memory") { process.stdout.write(chalk.dim("  Short-term: " + currentAgent.memory.shortTerm.length + " msgs  ·  Working: " + Object.keys(currentAgent.memory.working).length + " keys\n")); continue; }
    if (cmdL === "/memory clear") { await currentAgent.memory.clearShortTerm(); process.stdout.write(chalk.dim("  Memory cleared\n")); continue; }
    if (cmdL === "/workspace") { process.stdout.write(chalk.dim("  " + (ctx.workspacePath || "default") + "\n")); continue; }
    if (cmdL === "/mcp") {
      const lines = formatMcpHealthLines(ctx.mcp?.getHealthSnapshot?.() ?? [], ctx.mcpStatus ?? []);
      process.stdout.write(chalk.dim(lines.map((line) => "  " + line).join("\n") + "\n"));
      continue;
    }
    if (cmdL.startsWith("/apikey set ")) { const p = inp.split(/\s+/); if (p.length >= 4) { saveApiKey(p[2], p[3]); process.stdout.write(chalk.green("  ✓ Saved " + p[2] + " API key\n")); } else { process.stdout.write(chalk.yellow("  Usage: /apikey set <provider> <key>\n")); } continue; }
    if (cmdL === "/apikey") { process.stdout.write(chalk.bold("\n  API Keys:\n")); for (const p of ["openai","deepseek","anthropic","groq","openrouter"]) { process.stdout.write(chalk.dim("  " + p.padEnd(14) + (!!process.env[p.toUpperCase() + "_API_KEY"] ? chalk.green("env") : chalk.dim("—")) + "\n")); } process.stdout.write("\n"); continue; }
    if (cmdL === "/plan" || cmdL === "/auto" || cmdL === "/default") {
      MODE.set(cmdL === "/plan" ? InteractiveMode.PLAN : cmdL === "/auto" ? InteractiveMode.AUTO : InteractiveMode.DEFAULT);
      currentAgent.planMode = MODE.current === InteractiveMode.PLAN;
      process.stdout.write(chalk.dim(`  模式 → ${MODE.current} · ${MODE.describe()}\n`));
      continue;
    }
    if (cmdL === "/perm" || cmdL.startsWith("/perm ")) {
      const { getSecurity, PERMISSION_MODE_ALIASES } = require("../core/security");
      const sec = getSecurity();
      const arg = inp.split(/\s+/)[1]?.toLowerCase();
      if (!arg) { process.stdout.write(chalk.dim(`  权限模式: ${sec.approvalMode} · 可选 default | auto | accept | strict | bypass\n`)); continue; }
      const m = PERMISSION_MODE_ALIASES[arg];
      if (!m) { process.stdout.write(chalk.yellow(`  未知权限模式 '${arg}' · 可选 default | auto | accept | strict | bypass\n`)); continue; }
      sec.setMode(m);
      process.stdout.write(chalk.green(`  ✓ 权限模式 → ${m}\n`));
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
    if (cmdL === "/tools") {
      const stats = (currentAgent as any).toolRegistry?.getStats?.() || [];
      if (!stats.length) { process.stdout.write(chalk.dim("  本会话当前灵还没有工具调用\n")); continue; }
      process.stdout.write(chalk.bold(`\n  工具调用 · ${currentAgent.name}\n`));
      for (const s of stats.slice(0, 12)) {
        const extra = `${s.failures ? ` ✗${s.failures}` : ""}${s.cacheHits ? ` ⊙${s.cacheHits}` : ""}${s.breaker !== "closed" ? ` [熔断:${s.breaker}]` : ""}`;
        process.stdout.write(chalk.dim(`  ${s.name.padEnd(16)} ${s.calls} 次 · ${s.avgMs}ms${extra}\n`));
      }
      process.stdout.write("\n");
      continue;
    }
    if (cmdL === "/agents") {
      const { loadSubagentDefinitions } = require("../core/subagent");
      const defs = loadSubagentDefinitions();
      process.stdout.write(chalk.bold(`\n  可派生子智能体 · spawn_agent\n`));
      for (const d of defs.values()) {
        const scope = d.source === "builtin" ? "内置" : "自定义";
        const tools = d.tools === null ? "全部工具" : `${d.tools.length} 个工具`;
        process.stdout.write(chalk.dim(`  ◇ ${String(d.name).padEnd(18)} ${d.description}\n`));
        process.stdout.write(chalk.dim(`    └ ${scope} · ${tools}${d.model ? ` · ${d.model}` : ""}\n`));
      }
      process.stdout.write(chalk.dim(`\n  自定义: 在 .sky/agents/ 或 .claude/agents/ 放 <name>.md (frontmatter: description/tools/model)\n\n`));
      continue;
    }
    if (cmdL === "/trace") {
      const trace = (currentAgent as any).getLastTrace?.();
      if (!trace || !trace.spans?.length) { process.stdout.write(chalk.dim("  本会话还没有可追踪的运行\n")); continue; }
      const { renderTrace } = require("../core/trace");
      process.stdout.write(chalk.bold(`\n  运行追踪 · ${trace.label}\n`));
      process.stdout.write("  " + renderTrace(trace, {
        dim: (s: string) => chalk.dim(s),
        ok: (s: string) => chalk.green(s),
        err: (s: string) => chalk.red(s),
      }).split("\n").join("\n  ") + "\n\n");
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
    if (cmdL === "/channels") { await channelsWizard(); continue; }
    if (cmdL === "/rewind" || cmdL.startsWith("/rewind ")) {
      const { getFileCheckpoints } = require("../core/file_checkpoint");
      const cp = getFileCheckpoints();
      const arg = inp.slice(7).trim();
      const r = cp.rewind(/^\d+$/.test(arg) ? parseInt(arg, 10) : 1);
      if (r.turns === 0) {
        const turns = cp.list();
        if (!turns.length) { process.stdout.write(chalk.dim("  没有可回退的文件改动\n")); continue; }
        process.stdout.write(chalk.bold(`  检查点 · ${turns.length} 轮可回退\n`));
        for (const t of turns.slice(0, 8)) process.stdout.write(chalk.dim(`  ${t.label} · ${t.files.length} 个文件\n`));
        continue;
      }
      process.stdout.write(chalk.green(`  ↺ 已回退 ${r.turns} 轮`) + chalk.dim(` · 恢复 ${r.restored.length} 个文件${r.deleted.length ? ` · 删除 ${r.deleted.length} 个新建文件` : ""}\n`));
      for (const f of [...r.restored, ...r.deleted].slice(0, 10)) process.stdout.write(chalk.dim(`  ${f}\n`));
      continue;
    }
    if (cmdL === "/undo" || cmdL.startsWith("/undo ")) {
      // /undo is alias for /rewind
      const { getFileCheckpoints } = require("../core/file_checkpoint");
      const cp = getFileCheckpoints();
      const arg = inp.slice(5).trim();
      const r = cp.rewind(/^\d+$/.test(arg) ? parseInt(arg, 10) : 1);
      if (r.turns === 0) {
        const turns = cp.list();
        if (!turns.length) { process.stdout.write(chalk.dim("  没有可回退的文件改动\n")); continue; }
        process.stdout.write(chalk.bold(`  检查点 · ${turns.length} 轮可回退\n`));
        for (const t of turns.slice(0, 8)) process.stdout.write(chalk.dim(`  ${t.label} · ${t.files.length} 个文件\n`));
        continue;
      }
      process.stdout.write(chalk.green(`  ↺ 已撤销 ${r.turns} 轮`) + chalk.dim(` · 恢复 ${r.restored.length} 个文件${r.deleted.length ? ` · 删除 ${r.deleted.length} 个新建文件` : ""}\n`));
      for (const f of [...r.restored, ...r.deleted].slice(0, 10)) process.stdout.write(chalk.dim(`  ${f}\n`));
      continue;
    }
    if (cmdL === "/redo") {
      const { getFileCheckpoints } = require("../core/file_checkpoint");
      const cp = getFileCheckpoints();
      const r = cp.redo();
      if (r.turns === 0) { process.stdout.write(chalk.dim("  没有可重做的操作\n")); continue; }
      process.stdout.write(chalk.green(`  ↻ 已重做 ${r.turns} 轮`) + chalk.dim(` · 恢复 ${r.restored.length} 个文件\n`));
      for (const f of r.restored.slice(0, 10)) process.stdout.write(chalk.dim(`  ${f}\n`));
      continue;
    }
    if (cmdL === "/export" || cmdL.startsWith("/export ")) {
      const filename = inp.slice(8).trim() || `skyloom-export-${Date.now()}.md`;
      const msgs = currentAgent.memory.shortTerm.filter((m: any) => m.role !== "system");
      let md = `# Skyloom Session Export\n\n**Agent**: ${currentAgent.name}\n**Date**: ${new Date().toISOString()}\n**Messages**: ${msgs.length}\n\n---\n\n`;
      for (const m of msgs) {
        const role = m.role === "user" ? "👤 User" : `🤖 ${currentAgent.name}`;
        md += `## ${role}\n\n${m.content}\n\n`;
      }
      fs.writeFileSync(filename, md, "utf-8");
      process.stdout.write(chalk.green(`  ✓ 已导出到 ${filename}`) + chalk.dim(` · ${msgs.length} 条消息\n`));
      continue;
    }
    if (cmdL === "/thinking") {
      const cfg = (ctx as any).config;
      cfg.show_thinking = !cfg.show_thinking;
      process.stdout.write(chalk.dim(`  推理过程显示 → ${cfg.show_thinking ? "开启" : "关闭"}\n`));
      continue;
    }
    if (cmdL === "/details") {
      const cfg = (ctx as any).config;
      cfg.show_tool_details = !cfg.show_tool_details;
      process.stdout.write(chalk.dim(`  工具执行详情 → ${cfg.show_tool_details ? "开启" : "关闭"}\n`));
      continue;
    }
    if (cmdL === "/skills") {
      const { globalSkillRegistry } = require("../core/skill");
      const skills = globalSkillRegistry.getSkills();
      process.stdout.write(chalk.bold("\n  ✦ 技能目录 · Skills\n"));
      process.stdout.write(chalk.dim("  ─────────────────────────────────────────────\n"));
      for (const s of skills.slice(0, 20)) {
        process.stdout.write(chalk.dim("  · ") + chalk.white(s.name.padEnd(24)) + chalk.gray(s.description.slice(0, 50)) + "\n");
      }
      process.stdout.write(chalk.dim(`\n  共 ${skills.length} 个技能 · 使用时自动激活\n\n`));
      continue;
    }
    if (cmdL === "/review" || cmdL.startsWith("/review ")) {
      const target = inp.slice(9).trim() || "uncommitted";
      process.stdout.write(chalk.bold("\n   代码审查 · Code Review\n"));
      process.stdout.write(chalk.dim(`  目标: ${target}\n\n`));
      const reviewPrompt = `Please review the code changes for ${target}. Focus on:
1. Code quality and best practices
2. Potential bugs or issues
3. Security concerns
4. Performance implications
5. Suggestions for improvement

Provide specific, actionable feedback.`;
      try { await streamResponse(currentAgent, reviewPrompt); }
      catch (e: any) { process.stdout.write(chalk.red("  ✗ " + (e.message || e) + "\n")); }
      continue;
    }
    if (cmdL === "/connect" || cmdL.startsWith("/connect ")) {
      const provider = inp.slice(9).trim();
      if (!provider) {
        process.stdout.write(chalk.bold("\n  ✦ 配置 Provider\n"));
        process.stdout.write(chalk.dim("  用法: /connect <provider>\n"));
        process.stdout.write(chalk.dim("  示例: /connect openai\n\n"));
        continue;
      }
      const { PROVIDER_META } = require("../core/catalog");
      const meta = PROVIDER_META[provider.toLowerCase()];
      if (!meta) {
        process.stdout.write(chalk.dim(`  '${provider}' 不是已知 Provider\n`));
        continue;
      }
      process.stdout.write(chalk.bold(`\n  ${meta.name}\n`));
      process.stdout.write(chalk.dim(`  环境变量: ${meta.envVar || "(无)"}\n`));
      process.stdout.write(chalk.dim(`  设置: /apikey set ${provider} <key>\n\n`));
      continue;
    }
    if (cmdL === "/warp" || cmdL.startsWith("/warp ")) {
      const newPath = inp.slice(6).trim();
      if (!newPath) {
        process.stdout.write(chalk.dim("  用法: /warp <path> — 切换工作区\n"));
        continue;
      }
      const resolved = require("path").resolve(newPath);
      if (!fs.existsSync(resolved)) {
        process.stdout.write(chalk.dim(`  路径不存在: ${resolved}\n`));
        continue;
      }
      (ctx as any).workspacePath = resolved;
      currentAgent.reloadProjectMemory();
      process.stdout.write(chalk.green(`  ✓ 工作区 → ${resolved}\n`));
      continue;
    }
    if (cmdL === "/move" || cmdL.startsWith("/move ")) {
      const newPath = inp.slice(6).trim();
      if (!newPath) {
        process.stdout.write(chalk.dim("  用法: /move <path> — 移动会话到项目\n"));
        continue;
      }
      const resolved = require("path").resolve(newPath);
      if (!fs.existsSync(resolved)) {
        process.stdout.write(chalk.dim(`  路径不存在: ${resolved}\n`));
        continue;
      }
      // Change workspace to new project
      (ctx as any).workspacePath = resolved;
      currentAgent.reloadProjectMemory();
      process.stdout.write(chalk.green(`  ✓ 工作区 → ${resolved}\n`));
      continue;
    }
    if (cmdL === "/summarize") {
      const r = await currentAgent.compact();
      process.stdout.write(chalk.green("  ✓ " + r + "\n\n"));
      continue;
    }
    if (inp.startsWith("/")) {
      // 自定义斜杠命令（.sky/commands/ + ~/.skyloom/commands/）
      const { loadCustomCommands, resolveCustomCommand } = require("./commands_md");
      const hit = resolveCustomCommand(inp, loadCustomCommands());
      if (hit) {
        const target = hit.command.agent ? ctx.agentMap.get(hit.command.agent) : undefined;
        if (target) {
          await target.init();
          currentAgent = target;
        }
        process.stdout.write(chalk.dim(`  ⌘ /${hit.command.name}${hit.command.agent ? ` → ${hit.command.agent}` : ""}\n`));
        try { await streamResponse(currentAgent, hit.prompt); } catch (e: any) { process.stdout.write(chalk.red("  ✗ " + (e.message || e) + "\n")); }
        continue;
      }
    }
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

async function main() {
  const args = process.argv.slice(2);
  const classic = args.includes("--classic");

  // ── headless: sky -p "prompt" [--agent fog] [--json | --stream-json] ──
  const headlessRequested = args.some((arg) => arg === "-p" || arg === "--print");
  const piped = headlessRequested ? await readPipedInput(process.stdin) : "";
  let headless;
  try {
    headless = parseHeadlessInvocation(args, piped);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUsage: sky -p "prompt" [--agent fog] [--json|--stream-json]\n`);
    process.exit(1);
  }
  if (headless) {
    await runHeadless(headless.prompt, {
      agent: headless.agent,
      json: headless.json,
      streamJson: headless.streamJson,
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
  if (!isTopLevelCommand(rest[0]) && !rest[0].startsWith("-")) { await chat("fog", undefined, classic); return; }
  await program.parseAsync(process.argv);
}

main().catch(e => { process.stderr.write(chalk.red(`Fatal: ${(e as Error).message}\n`)); process.exit(1); });
