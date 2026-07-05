import chalk from "chalk";
import { agentTheme } from "../core/theme";
import type { CommandLine } from "./command_handlers";
import { TurnInterrupt } from "./runtime";
import { StreamRenderer } from "./tui";

const AGENT_NAMES = ["fog", "rain", "frost", "snow", "dew", "fair"] as const;

export function renderClassicCommandLine(output: CommandLine): string {
  const text = `  ${output.text}\n`;
  if (output.tone === "success") return chalk.green(text);
  if (output.tone === "warning") return chalk.yellow(text);
  if (output.tone === "error") return chalk.red(text);
  if (output.tone === "dim") return chalk.dim(text);
  return text;
}

export function welcome(agent: any): void {
  const width = process.stdout.columns || 80;
  const active = agentTheme(agent.name);
  const seal = chalk.hex(active.hex);
  const padding = " ".repeat(Math.max(0, Math.floor((width - 34) / 2)));
  process.stdout.write("\n" + padding + seal("✦    天 空 织 机    ✦\n"));
  process.stdout.write(padding + chalk.dim("S K Y L O O M\n\n"));
  const parts = AGENT_NAMES.map((name) => {
    const theme = agentTheme(name);
    const label = `${theme.symbol} ${theme.kanji}`;
    return name === agent.name
      ? chalk.bold.hex(theme.hex)(`▣ ${label}`)
      : chalk.hex(theme.hex).dim(label);
  });
  process.stdout.write("  " + parts.join(chalk.dim("  ·  ")) + "\n");
  process.stdout.write("  " + chalk.dim.italic(active.poem) + "\n\n");
  process.stdout.write(chalk.dim("  /help for commands  ·  /quit to exit\n\n"));
}

export function formatCost(cost: number): string {
  if (cost >= 1) return chalk.yellow(`$${cost.toFixed(2)}`);
  if (cost >= 0.01) return chalk.yellow(`$${cost.toFixed(4)}`);
  if (cost > 0) return chalk.green(`${(cost * 100).toFixed(2)}¢`);
  return "$0";
}

export async function streamResponse(agent: any, input: string): Promise<void> {
  const theme = agentTheme(agent.name);
  const pigment = chalk.hex(theme.hex);
  const out = process.stdout;
  const isTTY = !!out.isTTY;
  const frames = ["·  ", "·· ", " ··", "  ·"];
  let frameIndex = 0;
  let spinning = true;
  const draw = () => {
    if (spinning && isTTY) out.write(`\r  ${pigment(theme.symbol)} ${chalk.dim("思忖 " + frames[frameIndex++ % frames.length])}`);
  };
  const timer = isTTY ? setInterval(draw, 140) : null;
  draw();
  const stopSpinner = () => {
    if (!spinning) return;
    spinning = false;
    if (timer) clearInterval(timer);
    if (isTTY) out.write("\r" + " ".repeat(20) + "\r");
  };

  let headerShown = false;
  let mode: "none" | "reasoning" | "content" = "none";
  let renderer: StreamRenderer | null = null;
  const header = () => {
    if (headerShown) return;
    out.write("\n  " + chalk.bold.hex(theme.hex)(`${theme.symbol} ${theme.kanji}`) + chalk.hex(theme.hex)(` ${theme.name}`) + "\n\n");
    headerShown = true;
  };
  const endBlock = () => {
    if (!renderer) return;
    renderer.flush();
    renderer = null;
    out.write("\n");
  };

  const turnInterrupt = new TurnInterrupt();
  const onSigint = () => {
    if (turnInterrupt.handle() === "exit") {
      out.write(chalk.dim("\n  再会。\n"));
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  try {
    for await (const event of agent.chatStream(input, turnInterrupt.signal)) {
      if (event.type === "interrupted") {
        turnInterrupt.markInterrupted();
        continue;
      }
      switch (event.type) {
        case "reasoning":
          stopSpinner();
          if (mode !== "reasoning") {
            out.write(chalk.dim("  ◦ 思考  "));
            mode = "reasoning";
          }
          out.write(chalk.dim.italic(String(event.text).replace(/\s+/g, " ")));
          break;
        case "content":
          stopSpinner();
          if (mode === "reasoning") out.write("\n");
          if (mode !== "content") {
            header();
            renderer = new StreamRenderer(out, { gutter: "  " });
            mode = "content";
          }
          renderer!.write(String(event.text));
          break;
        case "tool_status":
          stopSpinner();
          endBlock();
          out.write("\n  " + pigment(`${theme.symbol} ${event.tool_name}`) + (event.label ? chalk.dim(`  ${event.label}`) : "") + chalk.dim(" …") + "\n");
          mode = "none";
          break;
        case "tool_done":
          out.write("  " + (event.success ? chalk.hex("#3a7a6e")("✓") : chalk.hex("#b3342d")("✗")) + " " + chalk.dim(String(event.tool_name)) + "\n");
          if (event.tool_name === "todo_write" && event.success) {
            try {
              const items = agent.memory.getWorking("todos") || [];
              if (items.length) {
                const { renderTodoList } = require("../tools/todo");
                out.write(chalk.dim("  ☰ " + renderTodoList(items).split("\n").join("\n    ")) + "\n");
              }
            } catch { /* best-effort */ }
          }
          mode = "none";
          break;
        case "truncated":
          endBlock();
          out.write(chalk.yellow(`\n  ⚠ ${event.reason}\n`));
          break;
        case "done":
          break;
      }
    }
  } catch (error: any) {
    if (!turnInterrupt.wasInterrupted && error?.name !== "AbortError") throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    stopSpinner();
    endBlock();
  }
  if (turnInterrupt.wasInterrupted) out.write(chalk.dim("\n  ⊘ 已中断（保留以上内容）\n"));
  out.write("\n");
}
