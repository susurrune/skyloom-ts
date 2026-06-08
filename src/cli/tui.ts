/**
 * 天空织机 TUI — Full-screen terminal interface
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │ ≋ 雾 Fog · deepseek-chat · $0.02 · ⏻   │ ← header bar
 *   ├──────────┬──────────────────────────────┤
 *   │ ☼ 晴 Fair│  ✦ 你好！有什么可以帮你的？  │
 *   │ ✱ 霜     │                              │ ← messages
 *   │ ≋ 雾 ▸   │  用户消息右对齐               │
 *   │ ❉ 雪     │                              │
 *   │ ∘ 露     │                              │
 *   │ ⸽ 雨     │                              │
 *   ├──────────┴──────────────────────────────┤
 *   │ ┌─ /fog  /rain  /frost  /snow  ───────┐│ ← command palette (popup)
 *   │ ▶ /fog    Switch to Fog                ││
 *   │   /rain   Switch to Rain               ││
 *   │ └──────────────────────────────────────┘│
 *   │ > hello world                    [send] │ ← input bar
 *   └─────────────────────────────────────────┘
 */

import * as readline from "readline";
import chalk from "chalk";

export interface TUIContext {
  agent: any;
  agents: Map<string, any>;
  model: string;
  cost: string;
  width: number;
  height: number;
}

/* ── Slash commands with icons ── */
const AGENT_CMDS: [string, string, string][] = [
  ["≋", "/fog", "雾 Fog · 松烟墨"],
  ["⸽", "/rain", "雨 Rain · 石青"],
  ["✱", "/frost", "霜 Frost · 石绿"],
  ["❉", "/snow", "雪 Snow · 铅白"],
  ["∘", "/dew", "露 Dew · 赭石"],
  ["☼", "/fair", "晴 Fair · 朱砂"],
];

const ACTION_CMDS: [string, string][] = [
  ["/help", "所有命令"],
  ["/clear", "清屏"],
  ["/status", "状态总览"],
  ["/cost", "费用统计"],
  ["/cost reset", "费用归零"],
  ["/compact", "压缩上下文"],
  ["/retry", "重发上条"],
  ["/apikey set <p> <k>", "保存API Key"],
  ["/apikey", "查看API Key"],
  ["/model", "模型管理"],
  ["/task <goal>", "多Agent编排"],
  ["/memory", "记忆状态"],
  ["/memory clear", "清除记忆"],
  ["/sessions", "会话列表"],
  ["/workspace", "工作空间"],
  ["/mcp", "MCP服务器"],
  ["/version", "版本信息"],
  ["/quit", "退出"],
];

/* ── Box drawing characters ── */
const B = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", l: "├", r: "┤", cross: "┼", t: "┬", b: "┴", L: "░", o: "●" };

function bar(start: string, fill: string, end: string, width: number): string {
  return start + fill.repeat(Math.max(0, width)) + end;
}

/* ── Render sidebar ── */
function renderSidebar(agent: any, agents: Map<string, any>, h: number): string[] {
  const lines: string[] = [];
  const W = 14; // sidebar width in chars

  // Header
  lines.push(chalk.cyan(bar(B.L + " 天空织机 ".padEnd(W - 2, B.L) + B.r, "", "", 0)));
  lines.push(chalk.dim(B.v + " Skyloom    " + B.v));

  for (const n of ["fog", "rain", "frost", "snow", "dew", "fair"]) {
    const isActive = agent.name === n;
    const display: Record<string, string> = { fog: "≋ 雾 Fog", rain: "⸽ 雨 Rain", frost: "✱ 霜 Frost", snow: "❉ 雪 Snow", dew: "∘ 露 Dew", fair: "☼ 晴 Fair" };
    const line = isActive
      ? chalk.cyan(B.v + " " + B.o + " " + display[n].padEnd(W - 5) + B.v)
      : chalk.dim(B.v + "   " + display[n].padEnd(W - 5) + B.v);
    lines.push(line);
  }

  // Fill remaining space
  for (let i = lines.length; i < h; i++) {
    lines.push(chalk.dim(B.v + " ".repeat(W - 2) + B.v));
  }

  // Footer
  try {
    const cu = agent.contextUsage();
    const pct = cu.pct || 0;
    lines.push(chalk.dim(B.v + " ctx " + String(pct).padStart(3) + "%" + " ".repeat(W - 10) + B.v));
  } catch { lines.push(chalk.dim(B.v + " ".repeat(W - 2) + B.v)); }

  lines.push(chalk.dim(bar(B.bl, B.h, B.br, W - 2)));
  return lines;
}

/* ── Render command palette ── */
function renderPalette(filter: string, selIdx: number, width: number): string[] {
  const lines: string[] = [];
  const W = Math.min(width - 4, 56);

  // Agent section first
  const agentMatches = AGENT_CMDS.filter(([, cmd]) => cmd.includes(filter) || filter === "/");
  const actionMatches = ACTION_CMDS.filter(([cmd]) => cmd.includes(filter));

  const allItems: string[] = [];
  for (const [icon, cmd, desc] of agentMatches) allItems.push(`${icon} ${cmd.padEnd(16)} ${desc}`);
  for (const [cmd, desc] of actionMatches) allItems.push(`  ${cmd.padEnd(18)} ${desc}`);

  if (allItems.length === 0 && filter.length > 1) {
    // No matches — show message
    lines.push(chalk.dim(bar(B.tl, B.h, B.tr, W)));
    lines.push(chalk.dim(B.v + "  未找到匹配命令 (esc 关闭)".padEnd(W) + B.v));
    lines.push(chalk.dim(bar(B.bl, B.h, B.br, W)));
    return lines;
  }

  if (allItems.length === 0) return lines;

  const start = Math.max(0, Math.min(selIdx - 5, allItems.length - 10));
  const end = Math.min(allItems.length, start + 10);

  lines.push(chalk.dim(bar(B.tl, B.h, B.tr, W - 5)) + "  ".padEnd(5));

  for (let i = start; i < end; i++) {
    const item = allItems[i];
    const isSelected = i === selIdx;
    const pad = W - item.replace(/\x1b\[[0-9;]*m/g, "").length + 2; // account for ANSI codes
    lines.push(isSelected
      ? chalk.cyan(B.v + " ▶ " + item).padEnd(W + 10) + chalk.cyan(B.v)
      : chalk.dim(B.v + "   " + item).padEnd(W + 10) + chalk.dim(B.v));
  }

  lines.push(chalk.dim(bar(B.bl, B.h, B.br, W - 5)) + "  ".padEnd(5));
  return lines;
}

/* ── Render message ── */
function renderMessage(role: string, text: string, width: number): string[] {
  const lines: string[] = [];
  const maxW = Math.min(width - 24, 60);
  const prefix = role === "user" ? "  " : "  ";
  const suffix = role === "user" ? "" : "";

  for (const para of text.split("\n")) {
    let remaining = para;
    while (remaining.length > 0) {
      const cut = remaining.length > maxW ? remaining.lastIndexOf(" ", maxW) : remaining.length;
      const idx = cut > 0 ? cut : maxW;
      const line = remaining.slice(0, idx).trimEnd();
      if (role === "user") {
        lines.push(chalk.dim(" ".repeat(Math.max(0, width - line.length - 4))) + chalk.cyan(line) + "  ");
      } else if (role === "assistant") {
        lines.push(prefix + line + suffix);
      } else {
        lines.push(chalk.dim("  " + line));
      }
      remaining = remaining.slice(idx).trimStart();
    }
  }
  return lines;
}

/* ── Read input with command palette ── */
export function readInput(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, ctx: TUIContext): Promise<string> {
  return new Promise(resolve => {
    let buf = "";
    let cursor = 0;
    let palette = false;
    let selIdx = 0;

    function render() {
      // Clear screen and render full TUI
      readline.cursorTo(stdout, 0, 0);
      readline.clearScreenDown(stdout);

      const w = stdout.columns || 80;
      const h = stdout.rows || 24;
      const sidebarW = 16;

      // Header
      stdout.write(chalk.bgBlack.cyan(" 天空织机 Skyloom v1.10 ".padEnd(w - 20, " ")) + chalk.bgBlack.dim(" deepseek".padEnd(10)) + chalk.bgBlack("\n"));
      stdout.write(chalk.dim(bar("", B.h, "", w)) + "\n");

      // Sidebar
      const sidebar = renderSidebar(ctx.agent, ctx.agents, h - 5);
      for (let i = 0; i < sidebar.length && i < h - 5; i++) {
        stdout.write(sidebar[i] + "\n");
      }

      // Command palette (overlaid)
      if (palette) {
        const paletteLines = renderPalette(buf, selIdx, w);
        // Move cursor up to position palette below header
        const paletteY = 2;
        for (let i = 0; i < paletteLines.length; i++) {
          stdout.write(`\x1b[${paletteY + i};${sidebarW}H`); // position cursor
          stdout.write(paletteLines[i]);
        }
      }

      // Input bar at bottom
      readline.cursorTo(stdout, sidebarW, h - 1);
      stdout.write(chalk.dim(B.l + B.h.repeat(w - sidebarW - 2) + B.r));
      readline.cursorTo(stdout, sidebarW, h);
      stdout.write(chalk.cyan(" > ") + buf.slice(0, cursor) + chalk.inverse(buf[cursor] || " ") + buf.slice(cursor + 1));
    }

    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin });
      rl.on("line", (line) => { rl.close(); resolve(line.trim()); });
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    render();

    let escBuf = "";
    stdin.on("data", (data: Buffer) => {
      const str = data.toString();
      escBuf += str;

      if (escBuf.startsWith("\x1b[") && escBuf.length >= 3) {
        const code = escBuf[2]; escBuf = "";
        if (code === "A") { if (palette) selIdx = Math.max(0, selIdx - 1); render(); return; }
        if (code === "B") { if (palette) { const all = [...AGENT_CMDS.map(c => c[1]), ...ACTION_CMDS.map(c => c[0])]; selIdx = Math.min(all.filter(a => a.includes(buf)).length - 1, selIdx + 1); } render(); return; }
        if (code === "C") { if (cursor < buf.length) cursor++; render(); return; }
        if (code === "D") { if (cursor > 0) cursor--; render(); return; }
      }

      for (const ch of escBuf) {
        escBuf = "";
        if (ch === "\x1b") { palette = false; render(); return; }
        if (ch === "\r" || ch === "\n") {
          if (palette) {
            const all = [...AGENT_CMDS.map(c => c[1]), ...ACTION_CMDS.map(c => c[0])];
            const filtered = all.filter(a => a.includes(buf));
            if (filtered[selIdx]) buf = filtered[selIdx];
            palette = false;
            render();
            stdin.setRawMode(false); stdin.pause(); resolve(buf.trim()); return;
          }
          stdin.setRawMode(false); stdin.pause(); resolve(buf.trim()); return;
        }
        if (ch === "\t") { /* ignore */ return; }
        if (ch === "\x7f" || ch === "\b") { if (cursor > 0) { buf = buf.slice(0, cursor - 1) + buf.slice(cursor); cursor--; } if (!buf) palette = false; render(); return; }
        if (ch === "\x03") { stdin.setRawMode(false); stdin.pause(); resolve("/quit"); return; }
        if (ch >= " ") {
          buf = buf.slice(0, cursor) + ch + buf.slice(cursor); cursor++;
          if (ch === "/") { palette = true; selIdx = 0; }
          else if (palette) selIdx = 0;
          render(); return;
        }
      }
    });
  });
}
