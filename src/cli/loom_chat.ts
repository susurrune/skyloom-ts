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
import { LoomUI, OrchTask, circled, cutVisual } from "./loom";

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
  ui.line(chalk.dim(" 输入 / 看命令 · /task <目标> 多灵织造 · 左栏为六灵动态"));
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

  // Tool approval becomes a loom-native modal instead of a raw readline prompt.
  try {
    const { getSecurity } = require("../core/security");
    getSecurity().setApprovalCallback(async (tool: string, args: Record<string, any>, level: number) => {
      const summary = `${tool} (危险等级 ${level}) ${JSON.stringify(args).slice(0, 48)}`;
      return ui.confirm(summary);
    });
  } catch { /* security module optional */ }

  ui.start();
  welcome(ui, deps.version);

  const say = (s: string) => { ui.line(s); };
  const dim = (s: string) => { ui.line(chalk.dim(" " + s)); };

  try {
    while (true) {
      const inp = await ui.readInput();
      if (!inp) continue;
      const cmdL = inp.toLowerCase();

      if (cmdL === "/quit" || cmdL === "/exit") break;

      // agent switch — stamp a seal
      let switched = false;
      for (const n of AGENT_NAMES) {
        if (cmdL === "/" + n) {
          const a = ctx.agentMap.get(n);
          if (a) {
            await a.init();
            agent = a;
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
      if (cmdL === "/" || cmdL === "/help") { dim("输入 / 后键入字母筛选命令，Tab 补全，↑↓ 选择。"); continue; }
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
      if (cmdL === "/model") { dim("运行 /setup 重新选择模型"); continue; }
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
      if (inp.startsWith("/")) { dim(`未知命令 ${inp.split(" ")[0]} · 输入 / 看全部命令`); continue; }

      // ── a normal chat turn ──
      ui.blank();
      ui.text(inp, (s) => chalk.hex(PALETTE.inkLight)(s), chalk.hex(PALETTE.inkLight)("❯ "));
      await loomStream(ui, agent, inp);
    }
  } finally {
    ui.destroy();
  }

  process.stdout.write(chalk.dim("\n  挂轴收起 · Session ended\n"));
  await ctx.closeAll();
  process.exit(0);
}
