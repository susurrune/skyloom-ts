/**
 * 立轴模式的对话主循环 — drives LoomUI with real agents.
 *
 * Streaming, slash commands, and the multi-agent "织谱" (weave chart): when
 * /task orchestration runs, every sub-task is a live line in the viewport,
 * the left rail badges each agent's tally, and shuttles fly across the sky
 * band in their mineral pigments. All of it is event-driven off the
 * orchestrator's onPlanned/onTaskStart/onTaskDone/onToolStatus callbacks.
 */

import chalk from "chalk";
import { agentTheme, PALETTE } from "../core/theme";
import { orchestrateTask } from "../core/factory";
import { appendQuickMemory, INIT_PROMPT } from "../core/skymd";
import { resolveVerifyConfig, runVerify } from "../core/verify";
import { InteractiveMode, ModeController } from "./mode";
import { expandFileRefs, isBangCommand, bangCommand, runBang, isHashMemory, hashNote } from "./input_macros";
import { loadCustomCommands, resolveCustomCommand } from "./commands_md";
import { getFileCheckpoints } from "../core/file_checkpoint";
import { LoomUI, OrchTask, circled, cutVisual } from "./loom";
import { PROVIDER_META } from "../core/catalog";
import { globalSkillRegistry } from "../core/skill";

const OK_HEX = "#3a7a6e"; // 石绿 — success
const ERR_HEX = "#b3342d"; // 朱砂 — failure

const AGENT_NAMES = ["fog", "rain", "frost", "snow", "dew", "fair"] as const;

function fmtCost(c: number): string {
  if (c >= 1) return `$${c.toFixed(2)}`;
  if (c >= 0.01) return `$${c.toFixed(4)}`;
  if (c > 0) return `${(c * 100).toFixed(2)}¢`;
  return "$0";
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/* ════════════════════════════════════════
   Streaming a single turn into the loom
   ════════════════════════════════════════ */

let turnSeq = 0;

async function loomStream(ui: LoomUI, agent: any, input: string): Promise<void> {
  const t = agentTheme(agent.name);
  const turn = ++turnSeq;
  ui.busy = true;
  ui.busyLabel = "思忖";

  const controller = new AbortController();
  let interrupted = false;
  ui.onInterrupt = () => {
    if (!interrupted) { interrupted = true; controller.abort(); ui.flash("⊘ 中断本轮（保留已写内容）"); }
  };

  let headerShown = false;
  let streaming = false;
  let reasonText = "";
  let toolSeq = 0;
  let lastToolId = "";

  try {
    for await (const ev of agent.chatStream(input, controller.signal)) {
      switch (ev.type) {
        case "interrupted":
          interrupted = true;
          break;
        case "reasoning": {
          ui.busyLabel = "思考";
          reasonText = (reasonText + String(ev.text).replace(/\s+/g, " ")).slice(-72);
          ui.line(chalk.dim("◦ 思考 ") + chalk.dim.italic(reasonText), `reason-${turn}`);
          break;
        }
        case "content":
          ui.busyLabel = "书写";
          if (!streaming) {
            if (!headerShown) { ui.beginStream(agent.name); headerShown = true; }
            else ui.continueStream();
            streaming = true;
          }
          ui.streamWrite(String(ev.text));
          break;
        case "tool_status": {
          ui.endStream();
          streaming = false;
          ui.busyLabel = String(ev.tool_name);
          lastToolId = `tool-${turn}-${++toolSeq}`;
          ui.line(
            chalk.hex(t.hex)(`${t.symbol} ${ev.tool_name}`) +
              (ev.label ? chalk.dim(`  ${ev.label}`) : "") + chalk.dim(" …"),
            lastToolId,
          );
          break;
        }
        case "tool_done":
          if (lastToolId) {
            ui.update(
              lastToolId,
              (ev.success ? chalk.hex(OK_HEX)("✓") : chalk.hex(ERR_HEX)("✗")) +
                " " + chalk.dim(String(ev.tool_name)),
            );
          }
          // live task checklist: re-render in place whenever the agent updates it
          if (ev.tool_name === "todo_write" && ev.success) {
            try {
              const items = agent.memory.getWorking("todos") || [];
              if (items.length) {
                const { renderTodoList } = require("../tools/todo");
                ui.text(renderTodoList(items), undefined, " ☰ ", "todo-live");
              }
            } catch { /* checklist rendering is best-effort */ }
          }
          break;
        case "truncated":
          ui.endStream();
          streaming = false;
          ui.line(chalk.yellow(`⚠ ${ev.reason}`));
          break;
        case "done":
          break;
      }
    }
  } catch (e: any) {
    if (!interrupted && e?.name !== "AbortError") {
      ui.endStream();
      ui.line(chalk.hex(ERR_HEX)("✗ ") + chalk.dim(String(e?.message || e)));
    }
  } finally {
    ui.endStream();
    if (interrupted) ui.line(chalk.dim("⊘ 已中断（保留以上内容）"));
    ui.blank();
    ui.busy = false;
    ui.busyLabel = "";
    ui.onInterrupt = null;
    ui.turns++;
    ui.paint();
  }
}

/* ════════════════════════════════════════
   Multi-agent orchestration — the live 织谱
   ════════════════════════════════════════ */

function renderTaskLine(ui: LoomUI, t: OrchTask, spin: number, idxOf: Map<string, number>): string {
  const th = agentTheme(t.agent);
  const pigment = chalk.hex(th.hex);
  let glyph: string;
  switch (t.state) {
    case "wait": glyph = chalk.hex(PALETTE.inkFaint)("·"); break;
    case "run": glyph = spin % 2 ? pigment(th.symbol) : pigment.dim(th.symbol); break;
    case "ok": glyph = chalk.hex(OK_HEX)("✓"); break;
    case "fail": glyph = chalk.hex(ERR_HEX)("✗"); break;
  }
  const deps = t.deps.length
    ? chalk.dim(" ←" + t.deps.map((d) => circled(idxOf.get(d) ?? 0)).join(""))
    : "";
  const time = t.ms !== undefined ? chalk.dim(` (${fmtMs(t.ms)})`) : "";
  const desc = t.state === "wait" ? chalk.dim(t.desc) : t.desc;
  return ` ${glyph} ${chalk.dim(circled(t.index))} ${pigment(th.kanji)} ${cutVisual(desc, 999)}${deps}${time}`;
}

async function runLoomTask(ui: LoomUI, ctx: any, goal: string): Promise<void> {
  const t = agentTheme(ui.agentName);
  ui.busy = true;
  ui.busyLabel = "织谱推演";
  ui.onInterrupt = () => ui.flash("织造中 · 单梭无法中断 · 再按 Ctrl-C 强制退出");

  ui.blank();
  ui.line(chalk.bold.hex(t.hex)("✦ 織 ") + chalk.bold(cutVisual(goal, 999)));
  ui.blank();

  const idxOf = new Map<string, number>();
  let spin = 0;
  const redraw = () => {
    for (const id of ui.orch.order) {
      const task = ui.orch.tasks.get(id)!;
      ui.update(`task-${id}`, renderTaskLine(ui, task, spin, idxOf));
    }
  };
  const spinner = setInterval(() => { spin++; redraw(); }, 480);

  try {
    const [, results, summary] = await orchestrateTask(goal, ctx.agentMap, null, {
      onPlanned: async (tasks: any[]) => {
        ui.orch.plan(tasks);
        for (const id of ui.orch.order) idxOf.set(id, ui.orch.tasks.get(id)!.index);
        ui.update("orch-head", "");
        ui.line(chalk.hex(t.hex)("✦ 织谱") + chalk.dim(` · ${ui.orch.order.length} 梭`), "orch-head");
        for (const id of ui.orch.order) {
          const task = ui.orch.tasks.get(id)!;
          ui.line(renderTaskLine(ui, task, 0, idxOf), `task-${id}`);
        }
        ui.line(chalk.dim("   ⸙ …"), "orch-tool");
        ui.paint();
        return true;
      },
      onTaskStart: async (task: any) => {
        ui.orch.start(task.id);
        ui.busyLabel = `织造 ${agentTheme(task.assignedTo || "fog").kanji}`;
        redraw();
        ui.paint();
      },
      onTaskDone: async (task: any, r: any) => {
        ui.orch.done(task.id, !!r.success);
        const p = ui.orch.progress();
        ui.busyLabel = `织造 ${p.done}/${p.total}`;
        redraw();
        ui.paint();
      },
      onToolStatus: (status: string) => {
        ui.update("orch-tool", chalk.dim(`   ⸙ ${cutVisual(status, 64)}`));
      },
    });

    ui.update("orch-tool", chalk.dim("   ⸙ 收梭"));
    ui.blank();
    if (results.length) {
      ui.line(chalk.hex(t.hex)("─ 汇总 ") + chalk.dim("─".repeat(8)));
      ui.blank();
      ui.text(String(summary || ""));
    } else {
      ui.line(chalk.dim(String(summary || "没有需要执行的任务。")));
    }
    ui.blank();
  } catch (e: any) {
    ui.line(chalk.hex(ERR_HEX)("✗ 织造失败 ") + chalk.dim(String(e?.message || e)));
    ui.blank();
  } finally {
    clearInterval(spinner);
    ui.orch.finish();
    ui.busy = false;
    ui.busyLabel = "";
    ui.onInterrupt = null;
    ui.turns++;
    ui.paint();
  }
}

/* ════════════════════════════════════════
   Welcome scroll
   ════════════════════════════════════════ */

function welcome(ui: LoomUI, version: string) {
  const t = agentTheme(ui.agentName);
  ui.blank();
  ui.line(chalk.bold.hex(t.hex)(" ✦ 天空织机 ") + chalk.dim(`v${version}`));
  ui.blank();
  ui.line(" " + chalk.hex(t.hex).italic(t.poem));
  ui.blank();
  ui.line(chalk.dim(" / 命令 · /task 多灵织造 · Shift+Tab 切模式 · @文件 !命令 #记忆"));
  ui.blank();
}

/* ════════════════════════════════════════
   The chat loop
   ════════════════════════════════════════ */

export interface LoomChatDeps {
  version: string;
  setupWizard: () => Promise<{ provider: string; key: string; model: string } | null>;
  saveApiKey: (provider: string, key: string) => void;
}

export async function loomChat(ctx: any, startAgent: any, deps: LoomChatDeps): Promise<void> {
  let agent = startAgent;
  let lastSessions: any[] = [];
  const ui = new LoomUI();
  ui.agentName = agent.name;

  ui.statusRight = () => {
    try {
      const cu = agent.contextUsage();
      const pct: number = cu.pct || 0;
      const t = agentTheme(agent.name);
      const cells = 5;
      const filled = Math.round((pct / 100) * cells);
      const bar = chalk.hex(t.hex)("▰".repeat(filled)) + chalk.hex(PALETTE.inkFaint)("▱".repeat(cells - filled));
      return chalk.dim(`${cu.model || "?"} · ${fmtCost(ctx.llm.getTotalCost())} · `) + bar + chalk.dim(` ${pct}%`);
    } catch { return ""; }
  };

  // ── Interactive modes (Shift+Tab cycles default → plan → auto) ──
  const mode = new ModeController();
  const applyMode = () => {
    const m = mode.current;
    agent.planMode = m === InteractiveMode.PLAN;
    ui.modeBadge =
      m === InteractiveMode.PLAN ? chalk.hex("#8a8a82").bold("◇ 计划 · 只读出方案") :
      m === InteractiveMode.AUTO ? chalk.hex("#b3342d").bold("⚡ 自动 · 免审批") : "";
    if (m !== InteractiveMode.DEFAULT) {
      ui.flash(m === InteractiveMode.PLAN ? "计划模式：只读调研 → 出方案 → 批准后切回执行" : "自动模式：危险工具免审批，注意风险");
    }
  };
  ui.onModeCycle = () => { mode.cycle(); applyMode(); };

  // Tool approval becomes a loom-native modal instead of a raw readline prompt.
  // AUTO mode approves automatically (with a visible trace line).
  try {
    const { getSecurity } = require("../core/security");
    getSecurity().setApprovalCallback(async (tool: string, args: Record<string, any>, level: number) => {
      if (mode.current === InteractiveMode.AUTO) {
        ui.line(chalk.dim(` ⚡ 自动批准 ${tool} (危险等级 ${level})`));
        return true;
      }
      const summary = `${tool} (危险等级 ${level}) ${JSON.stringify(args).slice(0, 48)}`;
      return ui.confirm(summary);
    });
  } catch { /* security module optional */ }

  ui.start();
  welcome(ui, deps.version);

  const say = (s: string) => { ui.line(s); };
  const dim = (s: string) => { ui.line(chalk.dim(" " + s)); };

  // 自定义斜杠命令（.sky/commands/ + ~/.skyloom/commands/），每轮重扫即时生效
  let customCommands = loadCustomCommands();
  ui.extraCommands = customCommands.map((c) => ["/" + c.name, c.description] as [string, string]);

  // Pre-load the session list so the /resume wizard has choices from the start.
  try { lastSessions = await agent.memory.listSessions(); } catch { /* best-effort */ }

  // Guided argument wizard for structured commands (/model · /apikey · /connect · /resume):
  // pick a provider/model/session from a ↑↓ list, paste a key — no syntax to memorize.
  ui.wizardStep = (command, prior) => {
    try {
      const { nextWizardStep } = require("./command_args");
      const { listProviders, modelsFor, providerLabel, allModels } = require("../core/catalog");
      const { loadConfig } = require("../core/config");
      const cfg = loadConfig();
      const configured = (p: string): boolean => {
        const meta = PROVIDER_META[p];
        if (meta?.envVar && process.env[meta.envVar]) return true;
        if (cfg?.api_keys?.[p]) return true;
        const models = modelsFor(p);
        return models.length > 0 && models.every((m: any) => m.local); // local providers need no key
      };
      const providers = listProviders().map((p: string) => ({
        id: p, label: providerLabel(p), configured: configured(p), envVar: PROVIDER_META[p]?.envVar,
      }));
      const models = allModels().map((m: any) => ({
        id: m.id, provider: m.provider, label: m.id,
        hint: m.local ? "本地/免费" : (m.costIn != null ? `$${m.costIn}/$${m.costOut}` : undefined),
      }));
      const sessions = lastSessions.map((s: any) => ({
        id: String(s.id),
        label: (s.preview || "(空)").replace(/\s+/g, " ").slice(0, 40),
      }));
      return nextWizardStep(command, prior, { providers, models, sessions });
    } catch { return null; }
  };

  try {
    while (true) {
      const inp = await ui.readInput();
      if (!inp) continue;
      const cmdL = inp.toLowerCase();
      if (inp.startsWith("/")) {
        customCommands = loadCustomCommands();
        ui.extraCommands = customCommands.map((c) => ["/" + c.name, c.description] as [string, string]);
      }

      if (cmdL === "/quit" || cmdL === "/exit") break;

      // agent switch — stamp a seal
      let switched = false;
      for (const n of AGENT_NAMES) {
        if (cmdL === "/" + n) {
          const a = ctx.agentMap.get(n);
          if (a) {
            await a.memory.initDb();
            a._baseSystemPrompt = '';
            a.reinitLanguage();
            agent.planMode = false;
            agent = a;
            applyMode(); // plan mode follows the session, not the agent instance
            ui.agentName = n;
            const t = agentTheme(n);
            ui.blank();
            say(" " + chalk.bgHex(t.hex).hex(PALETTE.paper).bold(` ${t.kanji} `) + " " + chalk.bold.hex(t.hex)(t.pigment) + chalk.dim(` · ${t.specialty}`));
            say(" " + chalk.hex(t.hex).italic(t.poem));
            ui.blank();
          }
          switched = true;
          break;
        }
      }
      if (switched) continue;

      if (cmdL === "/clear") { ui.clearViewport(); continue; }
      if (cmdL === "/" || cmdL === "/help") { dim("输入 / 后键入字母筛选命令，Tab 补全，↑↓ 选择，Shift+Tab 切模式。"); continue; }
      if (cmdL === "/plan" || cmdL === "/auto" || cmdL === "/default") {
        mode.set(cmdL === "/plan" ? InteractiveMode.PLAN : cmdL === "/auto" ? InteractiveMode.AUTO : InteractiveMode.DEFAULT);
        applyMode();
        dim(`模式 → ${mode.current}${mode.current === "default" ? "" : " · Shift+Tab 或 /default 切回"}`);
        continue;
      }
      if (cmdL === "/context") {
        try {
          const d = agent.contextDetail();
          ui.blank();
          say(" " + chalk.bold(`上下文 ${d.estimatedTokens}/${d.maxTokens} tokens (${d.pct}%)`) + chalk.dim(` · ${d.model}`));
          dim(`系统提示 ≈${d.systemPromptTokens} tokens · 工具 ${d.toolCount} 个 · 技能 ${d.activeSkills.length ? d.activeSkills.join(",") : "无"}`);
          for (const [role, v] of Object.entries(d.byRole as Record<string, { tokens: number; count: number }>)) {
            const bar = "▰".repeat(Math.max(1, Math.min(20, Math.round((v.tokens / Math.max(1, d.estimatedTokens)) * 20))));
            dim(`${role.padEnd(9)} ${String(v.tokens).padStart(6)} tk · ${v.count} 条 ${bar}`);
          }
          ui.blank();
        } catch (e: any) { dim(`无法获取: ${e?.message || e}`); }
        continue;
      }
      if (cmdL === "/tools") {
        const stats = (agent as any).toolRegistry?.getStats?.() || [];
        if (!stats.length) { dim("本会话当前灵还没有工具调用"); continue; }
        const t = agentTheme(agent.name);
        ui.blank();
        say(" " + chalk.bold.hex(t.hex)(`${t.symbol} 工具调用`) + chalk.dim(` · ${agent.name}`));
        for (const s of stats.slice(0, 12)) {
          const fail = s.failures ? chalk.hex(ERR_HEX)(` ✗${s.failures}`) : "";
          const cache = s.cacheHits ? chalk.dim(` ⊙${s.cacheHits}`) : "";
          const breaker = s.breaker !== "closed" ? chalk.yellow(` [熔断:${s.breaker}]`) : "";
          ui.line(` ${chalk.dim("·")} ${s.name.padEnd(16)} ${chalk.dim(`${s.calls} 次 · ${s.avgMs}ms`)}${fail}${cache}${breaker}`);
        }
        ui.blank();
        continue;
      }
      if (cmdL === "/trace") {
        const trace = agent.getLastTrace?.();
        if (!trace || !trace.spans?.length) { dim("本会话还没有可追踪的运行（先对话一次）"); continue; }
        const { renderTrace } = require("../core/trace");
        const t = agentTheme(agent.name);
        ui.blank();
        say(" " + chalk.bold.hex(t.hex)(`${t.symbol} 运行追踪`) + chalk.dim(` · ${trace.label}`));
        const rendered = renderTrace(trace, {
          dim: (s: string) => chalk.dim(s),
          ok: (s: string) => chalk.hex(OK_HEX)(s),
          err: (s: string) => chalk.hex(ERR_HEX)(s),
        });
        for (const ln of rendered.split("\n")) ui.line(" " + ln);
        ui.blank();
        continue;
      }
      if (cmdL === "/verify") {
        const vc = resolveVerifyConfig((ctx as any).config);
        if (!vc.commands.length) { dim("未配置验证命令 — 在 config.yaml 的 verify.commands 或 SKY.md 的 ## Verify 小节声明"); continue; }
        ui.busy = true; ui.busyLabel = "验证";
        ui.blank();
        say(" " + chalk.bold("⚙ verify") + chalk.dim(` · ${vc.commands.length} 条命令`));
        const vr = runVerify(vc);
        ui.busy = false; ui.busyLabel = "";
        for (const ln of vr.report.split("\n").slice(0, 30)) ui.line(" " + (ln.startsWith("✓") ? chalk.hex(OK_HEX)(ln) : ln.startsWith("✗") ? chalk.hex(ERR_HEX)(ln) : chalk.dim(cutVisual(ln, 200))));
        if (!vr.ok) dim(`验证失败 — 直接说「修复 verify 失败」让 ${agent.name} 处理`);
        ui.blank();
        continue;
      }
      if (cmdL === "/init") {
        dim("开始扫描项目，生成 SKY.md 项目记忆 …");
        ui.blank();
        ui.text(INIT_PROMPT.split("\n")[0], (s) => chalk.hex(PALETTE.inkLight)(s), chalk.hex(PALETTE.inkLight)("❯ "));
        await loomStream(ui, agent, INIT_PROMPT);
        agent.reloadProjectMemory();
        continue;
      }
      if (cmdL === "/version") { dim(`Skyloom v${deps.version}`); continue; }
      if (cmdL === "/status") { dim(`${agent.displayName} (${agent.name}) · ${agent.state} · 记忆 ${agent.memory.shortTerm.length} 条`); continue; }
      if (cmdL === "/cost") { dim(`总费用 ${fmtCost(ctx.llm.getTotalCost())}`); continue; }
      if (cmdL === "/cost reset") { (ctx.llm as any).resetUsageStats?.(); dim("已重置费用统计"); continue; }
      if (cmdL === "/compact") {
        ui.busy = true; ui.busyLabel = "压缩上下文";
        try { const r = await agent.compact(); say(" " + chalk.hex(OK_HEX)("✓ ") + chalk.dim(String(r))); }
        catch (e: any) { say(" " + chalk.hex(ERR_HEX)("✗ ") + chalk.dim(String(e?.message || e))); }
        ui.busy = false; ui.busyLabel = "";
        continue;
      }
      if (cmdL === "/memory") { dim(`短期 ${agent.memory.shortTerm.length} 条 · 工作记忆 ${Object.keys(agent.memory.working).length} 键`); continue; }
      if (cmdL === "/memory clear") { await agent.memory.clearShortTerm(); dim("记忆已清空"); continue; }
      if (cmdL === "/workspace") { dim(String(ctx.workspacePath || "default")); continue; }
      if (cmdL === "/mcp") { dim(String(ctx.mcpStatus?.join(", ") || "none")); continue; }
      if (cmdL === "/model" || cmdL.startsWith("/model ")) {
        const { setAgentModel, setUnifiedModel, clearAgentModel, setAgentApiKey, describeAgentLLM } = require("../core/model_config");
        const cfg = (ctx as any).config;
        const parts = inp.split(/\s+/).slice(1);
        const t = agentTheme(agent.name);
        if (parts.length === 0) {
          const d = describeAgentLLM(cfg, agent.name);
          const keyLabel = { agent: "独立 key", env: "环境变量", global: "全局 key", missing: chalk.yellow("缺失!") }[d.keySource as string] || d.keySource;
          ui.blank();
          say(" " + chalk.bold.hex(t.hex)(`${t.symbol} ${agent.name}`) + chalk.bold(` · ${d.model}`) + chalk.dim(` (${d.source === "agent" ? "独立配置" : "统一配置"} · ${d.provider || "?"} · ${keyLabel})`));
          dim(`统一默认: ${cfg.default_model || cfg.llm?.default_model || "gpt-4o"}`);
          dim("/model <id> 给当前灵单独换 · /model unified <id> 改统一默认 · /model reset 回到统一 · /model key <key> 独立 key");
          ui.blank();
          continue;
        }
        if (parts[0] === "reset") {
          clearAgentModel(cfg, agent.name);
          say(" " + chalk.hex(OK_HEX)(`✓ ${agent.name} 已回到统一配置`) + chalk.dim(` · ${describeAgentLLM(cfg, agent.name).model}`));
          continue;
        }
        if (parts[0] === "unified" || parts[0] === "default") {
          if (!parts[1]) { dim("用法: /model unified <模型id>"); continue; }
          const r = setUnifiedModel(cfg, parts[1]);
          if (!r.ok) { dim(`'${parts[1]}' 不在目录中${r.suggestions.length ? " · 可选: " + r.suggestions.join(", ") : ""}`); continue; }
          say(" " + chalk.hex(OK_HEX)(`✓ 统一默认 → ${parts[1]}`) + chalk.dim(r.provider ? ` (${r.provider})` : ""));
          continue;
        }
        if (parts[0] === "key") {
          if (!parts[1]) { dim("用法: /model key <api-key> — 仅当前灵使用"); continue; }
          setAgentApiKey(cfg, agent.name, parts[1]);
          say(" " + chalk.hex(OK_HEX)(`✓ ${agent.name} 的独立 API key 已保存`));
          continue;
        }
        const r = setAgentModel(cfg, agent.name, parts[0]);
        if (!r.ok) { dim(`'${parts[0]}' 不在目录中${r.suggestions.length ? " · 可选: " + r.suggestions.join(", ") : " · /setup 查看全部"}`); continue; }
        say(" " + chalk.hex(OK_HEX)(`✓ ${agent.name} → ${parts[0]}`) + chalk.dim(`${r.provider ? ` (${r.provider})` : ""} · 下一条消息生效 · /model reset 撤销`));
        const d = describeAgentLLM(cfg, agent.name);
        if (d.keySource === "missing") dim(`⚠ ${r.provider} 还没有 API key — /apikey set ${r.provider} <key> 或 /model key <key>`);
        continue;
      }
      if (cmdL === "/models" || cmdL.startsWith("/models ")) {
        const { listProviders, modelsFor, providerLabel } = require("../core/catalog");
        const args = inp.split(/\s+/).slice(1);
        const filter = args[0]?.toLowerCase() || "";
        ui.blank();
        say(" " + chalk.bold.hex("#3a7a6e")("✦ 模型目录 · Model Catalog"));
        dim("  ─────────────────────────────────────────────");
        const providers = listProviders();
        let totalModels = 0;
        for (const p of providers) {
          const models = modelsFor(p);
          if (!models.length) continue;
          if (filter && !p.toLowerCase().includes(filter) && !providerLabel(p).toLowerCase().includes(filter)) continue;
          const label = providerLabel(p);
          say(" " + chalk.bold.hex("#3a7a6e")(`  ${label}`));
          for (const m of models) {
            totalModels++;
            const costStr = m.costIn === 0 && m.costOut === 0 ? chalk.green("免费") : chalk.dim(`$${m.costIn.toFixed(2)}/$${m.costOut.toFixed(2)}`);
            const ctxStr = m.context >= 1000000 ? chalk.cyan(`${(m.context / 1000000).toFixed(0)}M`) : m.context >= 1000 ? chalk.cyan(`${(m.context / 1000).toFixed(0)}K`) : chalk.cyan(`${m.context}`);
            say(`   ${chalk.dim("·")} ${chalk.white(m.id.padEnd(38))} ${ctxStr} ${chalk.dim(" ")} ${costStr} ${chalk.gray(m.desc)}`);
          }
        }
        dim(`  ────────────────────────────────────────────`);
        dim(`  共 ${providers.length} 个 Provider · ${totalModels} 个模型`);
        dim("  用法: /models [provider] 筛选 · /model <id> 切换");
        ui.blank();
        continue;
      }
      if (cmdL === "/sessions") {
        lastSessions = await agent.memory.listSessions();
        const active = agent.memory.getActiveSession();
        const t = agentTheme(agent.name);
        ui.blank();
        say(" " + chalk.bold.hex(t.hex)(`${t.symbol} ${t.kanji} 会话`) + chalk.dim(` (${lastSessions.length})`));
        if (!lastSessions.length) dim("（暂无历史会话）");
        lastSessions.slice(0, 15).forEach((s: any, i: number) => {
          const mark = s.id === active ? chalk.hex(t.hex)("●") : chalk.dim("·");
          const preview = (s.preview || "(空)").replace(/\s+/g, " ").slice(0, 36);
          say(` ${mark} ${chalk.dim(String(i + 1).padStart(2))} ${preview} ${chalk.dim(`· ${s.messageCount}条 · ${String(s.id).slice(0, 8)}`)}`);
        });
        dim("/resume <序号或id> 恢复 · /new 新会话");
        ui.blank();
        continue;
      }
      if (cmdL === "/new") {
        await agent.memory.clearShortTerm();
        agent._baseSystemPrompt = ''; agent.reinitLanguage();
        const id = await agent.memory.createSession();
        say(" " + chalk.hex(OK_HEX)("✦ 新会话已开始") + chalk.dim(` · ${String(id).slice(0, 8)}`));
        continue;
      }
      if (cmdL === "/resume" || cmdL.startsWith("/resume ")) {
        const arg = inp.slice(7).trim();
        if (!lastSessions.length) lastSessions = await agent.memory.listSessions();
        let target: any = null;
        if (!arg) target = lastSessions[0];
        else if (/^\d+$/.test(arg)) target = lastSessions[parseInt(arg) - 1];
        else target = lastSessions.find((s: any) => String(s.id).startsWith(arg));
        if (!target) { dim("未找到该会话。先 /sessions 看列表。"); continue; }
        const ok = await agent.memory.loadSession(target.id);
        if (!ok) { dim("恢复失败。"); continue; }
        const n = agent.memory.shortTerm.filter((m: any) => m.role !== "system").length;
        const t = agentTheme(agent.name);
        say(" " + chalk.bold.hex(t.hex)("↺ 已恢复会话") + chalk.dim(` · ${n} 条消息 · ${String(target.id).slice(0, 8)}`));
        continue;
      }
      if (cmdL.startsWith("/apikey set ")) {
        const p = inp.split(/\s+/);
        if (p.length >= 4) { deps.saveApiKey(p[2], p[3]); say(" " + chalk.hex(OK_HEX)(`✓ 已保存 ${p[2]} API key`)); }
        else dim("用法: /apikey set <provider> <key>");
        continue;
      }
      if (cmdL === "/setup") {
        const r = await ui.suspend(() => deps.setupWizard());
        if (r) say(" " + chalk.hex(OK_HEX)(`✓ ${r.provider} · ${r.model} · 就绪`));
        continue;
      }
      if (cmdL.startsWith("/task ")) {
        const goal = inp.slice(6).trim();
        if (!goal) { dim("用法: /task <目标>"); continue; }
        await runLoomTask(ui, ctx, goal);
        continue;
      }
      if (cmdL === "/rewind" || cmdL.startsWith("/rewind ")) {
        const cp = getFileCheckpoints();
        const arg = inp.slice(7).trim();
        const n = /^\d+$/.test(arg) ? parseInt(arg, 10) : 1;
        const r = cp.rewind(n);
        if (r.turns === 0) {
          const turns = cp.list();
          if (!turns.length) { dim("没有可回退的文件改动（检查点覆盖 write/edit/delete_file；run_bash 的副作用无法回退）"); continue; }
          say(" " + chalk.bold("检查点") + chalk.dim(` · ${turns.length} 轮可回退 — /rewind [n]`));
          for (const t of turns.slice(0, 8)) dim(`${t.label} · ${t.files.length} 个文件`);
          continue;
        }
        say(" " + chalk.hex(OK_HEX)(`↺ 已回退 ${r.turns} 轮`) + chalk.dim(` · 恢复 ${r.restored.length} 个文件${r.deleted.length ? ` · 删除 ${r.deleted.length} 个新建文件` : ""}`));
        for (const f of [...r.restored, ...r.deleted].slice(0, 10)) dim(f);
        continue;
      }
      if (cmdL === "/undo" || cmdL.startsWith("/undo ")) {
        const cp = getFileCheckpoints();
        const arg = inp.slice(5).trim();
        const n = /^\d+$/.test(arg) ? parseInt(arg, 10) : 1;
        const r = cp.rewind(n);
        if (r.turns === 0) {
          const turns = cp.list();
          if (!turns.length) { dim("没有可撤销的文件改动"); continue; }
          say(" " + chalk.bold("检查点") + chalk.dim(` · ${turns.length} 轮可撤销`));
          for (const t of turns.slice(0, 8)) dim(`${t.label} · ${t.files.length} 个文件`);
          continue;
        }
        say(" " + chalk.hex(OK_HEX)(`↺ 已撤销 ${r.turns} 轮`) + chalk.dim(` · 恢复 ${r.restored.length} 个文件`));
        for (const f of r.restored.slice(0, 10)) dim(f);
        continue;
      }
      if (cmdL === "/redo") {
        const cp = getFileCheckpoints();
        const r = cp.redo();
        if (r.turns === 0) { dim("没有可重做的操作"); continue; }
        say(" " + chalk.hex(OK_HEX)(`↻ 已重做 ${r.turns} 轮`) + chalk.dim(` · 恢复 ${r.restored.length} 个文件`));
        for (const f of r.restored.slice(0, 10)) dim(f);
        continue;
      }
      if (cmdL === "/export" || cmdL.startsWith("/export ")) {
        const filename = inp.slice(8).trim() || `skyloom-export-${Date.now()}.md`;
        const msgs = agent.memory.shortTerm.filter((m: any) => m.role !== "system");
        let md = `# Skyloom Session Export\n\n**Agent**: ${agent.name}\n**Date**: ${new Date().toISOString()}\n**Messages**: ${msgs.length}\n\n---\n\n`;
        for (const m of msgs) {
          const role = m.role === "user" ? "👤 User" : `🤖 ${agent.name}`;
          md += `## ${role}\n\n${m.content}\n\n`;
        }
        require("fs").writeFileSync(filename, md, "utf-8");
        say(" " + chalk.hex(OK_HEX)(`✓ 已导出到 ${filename}`) + chalk.dim(` · ${msgs.length} 条消息`));
        continue;
      }
      if (cmdL === "/thinking") {
        const cfg = (ctx as any).config;
        cfg.show_thinking = !cfg.show_thinking;
        dim(`推理过程显示 → ${cfg.show_thinking ? "开启" : "关闭"}`);
        continue;
      }
      if (cmdL === "/details") {
        const cfg = (ctx as any).config;
        cfg.show_tool_details = !cfg.show_tool_details;
        dim(`工具执行详情 → ${cfg.show_tool_details ? "开启" : "关闭"}`);
        continue;
      }
      if (cmdL === "/skills") {
        const skills = globalSkillRegistry.getSkills();
        ui.blank();
        say(" " + chalk.bold.hex("#3a7a6e")("✦ 技能目录 · Skills"));
        dim("  ─────────────────────────────────────────────");
        for (const s of skills.slice(0, 20)) {
          say(`   ${chalk.dim("·")} ${chalk.white(s.name.padEnd(24))} ${chalk.gray(s.description.slice(0, 50))}`);
        }
        dim(`  共 ${skills.length} 个技能 · 使用时自动激活`);
        ui.blank();
        continue;
      }
      if (cmdL === "/review" || cmdL.startsWith("/review ")) {
        const target = inp.slice(9).trim() || "uncommitted";
        ui.blank();
        say(" " + chalk.bold("  代码审查 · Code Review"));
        dim(`  目标: ${target}`);
        ui.blank();
        const reviewPrompt = `Please review the code changes for ${target}. Focus on:
1. Code quality and best practices
2. Potential bugs or issues
3. Security concerns
4. Performance implications
5. Suggestions for improvement

Provide specific, actionable feedback.`;
        await loomStream(ui, agent, reviewPrompt);
        continue;
      }
      if (cmdL === "/connect" || cmdL.startsWith("/connect ")) {
        const provider = inp.slice(9).trim();
        if (!provider) {
          ui.blank();
          say(" " + chalk.bold("✦ 配置 Provider"));
          dim("  用法: /connect <provider>");
          dim("  示例: /connect openai");
          ui.blank();
          continue;
        }
        const meta = PROVIDER_META[provider.toLowerCase()];
        if (!meta) { dim(`'${provider}' 不是已知 Provider`); continue; }
        ui.blank();
        say(" " + chalk.bold.hex("#3a7a6e")(meta.name));
        dim(`  环境变量: ${meta.envVar || "(无)"}`);
        dim(`  设置: /apikey set ${provider} <key>`);
        ui.blank();
        continue;
      }
      if (cmdL === "/warp" || cmdL.startsWith("/warp ")) {
        const newPath = inp.slice(6).trim();
        if (!newPath) { dim("用法: /warp <path> — 切换工作区"); continue; }
        const resolved = require("path").resolve(newPath);
        if (!require("fs").existsSync(resolved)) { dim(`路径不存在: ${resolved}`); continue; }
        (ctx as any).workspacePath = resolved;
        agent.reloadProjectMemory();
        say(" " + chalk.hex(OK_HEX)(`✓ 工作区 → ${resolved}`));
        continue;
      }
      if (cmdL === "/move" || cmdL.startsWith("/move ")) {
        const newPath = inp.slice(6).trim();
        if (!newPath) { dim("用法: /move <path> — 移动会话到项目"); continue; }
        const resolved = require("path").resolve(newPath);
        if (!require("fs").existsSync(resolved)) { dim(`路径不存在: ${resolved}`); continue; }
        (ctx as any).workspacePath = resolved;
        agent.reloadProjectMemory();
        say(" " + chalk.hex(OK_HEX)(`✓ 工作区 → ${resolved}`));
        continue;
      }
      if (cmdL === "/summarize") {
        ui.busy = true; ui.busyLabel = "压缩上下文";
        try { const r = await agent.compact(); say(" " + chalk.hex(OK_HEX)("✓ ") + chalk.dim(String(r))); }
        catch (e: any) { say(" " + chalk.hex(ERR_HEX)("✗ ") + chalk.dim(String(e?.message || e))); }
        ui.busy = false; ui.busyLabel = "";
        continue;
      }

      // ── 自定义斜杠命令 ─
      if (inp.startsWith("/")) {
        const hit = resolveCustomCommand(inp, customCommands);
        if (hit) {
          if (hit.command.agent && ctx.agentMap.has(hit.command.agent)) {
            const a = ctx.agentMap.get(hit.command.agent);
            await a.memory.initDb();
            a._baseSystemPrompt = '';
            a.reinitLanguage();
            agent.planMode = false;
            agent = a;
            applyMode();
            ui.agentName = a.name;
          }
          dim(`⌘ /${hit.command.name}` + (hit.command.agent ? ` → ${hit.command.agent}` : ""));
          const expanded = expandFileRefs(hit.prompt);
          ui.blank();
          ui.text(cutVisual(hit.prompt, 400), (s) => chalk.hex(PALETTE.inkLight)(s), chalk.hex(PALETTE.inkLight)("❯ "));
          await loomStream(ui, agent, expanded.text);
          continue;
        }
      }

      if (inp.startsWith("/")) { dim(`未知命令 ${inp.split(" ")[0]} · 输入 / 看全部命令`); continue; }

      // ── input macros: # quick memory · ! shell · @file attach ──
      if (isHashMemory(inp)) {
        try {
          const file = appendQuickMemory(hashNote(inp));
          agent.reloadProjectMemory();
          say(" " + chalk.hex(OK_HEX)("✦ 已记入 ") + chalk.dim(file));
        } catch (e: any) { dim(`记忆写入失败: ${e?.message || e}`); }
        continue;
      }
      if (isBangCommand(inp)) {
        const cmd = bangCommand(inp);
        ui.blank();
        say(" " + chalk.hex(PALETTE.inkLight)(`$ ${cmd}`));
        const r = runBang(cmd);
        ui.text(r.output, (s) => (r.ok ? chalk.dim(s) : chalk.hex(ERR_HEX)(s)), "  ");
        // The output joins the conversation context without an LLM turn.
        agent.memory.addMessage("system", `[用户执行 shell] $ ${cmd}\n${r.output.slice(0, 4000)}`);
        ui.blank();
        continue;
      }
      const expanded = expandFileRefs(inp);
      if (expanded.attached.length) dim(`已附加 ${expanded.attached.map((f) => "@" + f).join(" ")}`);

      // ── a normal chat turn ──
      ui.blank();
      ui.text(inp, (s) => chalk.hex(PALETTE.inkLight)(s), chalk.hex(PALETTE.inkLight)("❯ "));
      await loomStream(ui, agent, expanded.text);
    }
  } finally {
    ui.destroy();
  }

  process.stdout.write(chalk.dim("\n  挂轴收起 · Session ended\n"));
  await ctx.closeAll();
  process.exit(0);
}
