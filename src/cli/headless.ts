import chalk from "chalk";
import { createSystemContext, orchestrateTask } from "../core/factory";

export async function runHeadless(
  prompt: string,
  options: { agent?: string; json?: boolean; streamJson?: boolean },
): Promise<void> {
  process.env.WA_NO_RESUME = "1";
  const startedAt = Date.now();
  const context = createSystemContext();
  const agentName = options.agent || "fog";
  const agent = context.agentMap.get(agentName);
  if (!agent) {
    process.stderr.write(`Unknown agent: ${agentName}\n`);
    process.exit(1);
  }
  await agent.init();

  try {
    const { getSecurity } = require("../core/security");
    getSecurity().setApprovalCallback(async () => process.env.SKYLOOM_ALLOW_DANGEROUS === "1");
  } catch { /* optional */ }

  const emit = (value: Record<string, any>) => process.stdout.write(JSON.stringify(value) + "\n");
  let content = "";
  let success = true;
  try {
    for await (const event of agent.chatStream(prompt)) {
      if (options.streamJson) {
        emit(event);
        if (event.type === "content") content += event.text;
        continue;
      }
      switch (event.type) {
        case "content":
          content += event.text;
          if (!options.json) process.stdout.write(String(event.text));
          break;
        case "tool_status":
          if (!options.json) process.stderr.write(`[tool] ${event.tool_name} ${event.label || ""}\n`);
          break;
        case "truncated":
          success = false;
          process.stderr.write(`[truncated] ${event.reason}\n`);
          break;
      }
    }
  } catch (error: any) {
    success = false;
    process.stderr.write(`Error: ${error?.message || error}\n`);
  }

  if (options.json || options.streamJson) {
    emit({
      type: "result",
      success,
      agent: agentName,
      model: (() => { try { return agent.contextUsage().model; } catch { return undefined; } })(),
      content,
      cost_usd: (() => { try { return context.llm.getTotalCost(); } catch { return 0; } })(),
      duration_ms: Date.now() - startedAt,
    });
  } else if (content && !content.endsWith("\n")) {
    process.stdout.write("\n");
  }
  await context.closeAll();
  process.exit(success ? 0 : 1);
}

export async function runTask(goal: string): Promise<void> {
  const context = createSystemContext();
  await context.initAll();
  const [, results, summary] = await orchestrateTask(goal, context.agentMap);
  for (const result of results) {
    process.stdout.write(`  ${result.success ? chalk.green("✓") : chalk.red("✗")} ${chalk.cyan(result.agent)}: ${result.description.slice(0, 60)}\n`);
  }
  process.stdout.write(chalk.bold("\n  " + summary.slice(0, 800) + "\n\n"));
  await context.closeAll();
}
