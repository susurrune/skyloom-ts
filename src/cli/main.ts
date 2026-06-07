#!/usr/bin/env node

/**
 * CLI interface for Skyloom — terminal agent product.
 * Uses Commander.js for command routing.
 */

import { Command } from 'commander';
import * as fs from 'fs';
import * as readline from 'readline';
import chalk from 'chalk';
import { createSystemContext, orchestrateTask } from '../core/factory';
import { loadConfig, USER_CONFIG_DIR } from '../core/config';
import { classify } from '../core/router';
import { InteractiveMode, ModeController } from './mode';

const MODE = new ModeController();
const VERSION = '1.4.0';

const program = new Command();

program
  .name('sky')
  .description('Skyloom CLI — multi-agent orchestration framework')
  .version(VERSION);

// ── Chat command ──

program
  .command('chat')
  .description('Start interactive chat with an agent')
  .argument('[agent]', 'Agent name (fog, rain, frost, snow, dew, fair)', 'fog')
  .option('-m, --model <model>', 'Model to use')
  .action(async (agentName: string, options: { model?: string }) => {
    try {
      await interactiveChat(agentName, options.model);
    } catch (e) {
      console.error(chalk.red(`Error: ${e}`));
      process.exit(1);
    }
  });

// ── Task command ──

program
  .command('task')
  .description('Execute a multi-agent orchestration task')
  .argument('[goal]', 'Task goal description')
  .option('-r, --resume', 'Resume from checkpoint')
  .action(async (goal?: string, options?: { resume?: boolean }) => {
    if (!goal) {
      console.log(chalk.yellow('Please provide a task goal. Usage: sky task "<goal>"'));
      return;
    }
    try {
      await runTask(goal, options?.resume);
    } catch (e) {
      console.error(chalk.red(`Error: ${e}`));
    }
  });

// ── Web command ──

program
  .command('web')
  .description('Start web server')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .action(async (options: { port?: string }) => {
    try {
      // Dynamic import to avoid loading express when not needed
      const { startWebServer } = await import('../web/server');
      const port = parseInt(options.port || '3000', 10);
      await startWebServer(port);
    } catch (e) {
      console.error(chalk.red(`Web server error: ${e}`));
    }
  });

// ── MCP command ──

program
  .command('mcp')
  .description('Start MCP server (stdio JSON-RPC for Claude Desktop etc.)')
  .action(async () => {
    try {
      console.error(chalk.cyan('Starting MCP server on stdio...'));
      const { startMCPServer } = await import('../core/mcp_server');
      await startMCPServer();
    } catch (e) {
      console.error(chalk.red(`MCP server error: ${e}`));
      process.exit(1);
    }
  });

// ── Config command ──

program
  .command('config')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    console.log(chalk.bold('\nSkyloom Configuration'));
    console.log(chalk.dim('─'.repeat(40)));
    console.log(chalk.cyan('Config dir:'), USER_CONFIG_DIR);
    console.log(chalk.cyan('Agents:'));
    for (const [name, cfg] of Object.entries(config.agents || {})) {
      console.log(`  ${chalk.bold(name)}: ${cfg.model || 'default'}`);
    }
  });

// ── Init / Setup command ──

program
  .command('init')
  .description('Initialize Skyloom configuration')
  .action(() => {
    const configDir = USER_CONFIG_DIR;
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    console.log(chalk.green(`✓ Initialized config at ${configDir}`));
    console.log(chalk.dim('Edit config.yaml in that directory to configure agents and models.'));
  });

// ── Version command ──

program
  .command('version')
  .description('Show version')
  .action(() => {
    console.log(`Skyloom v${VERSION}`);
  });

// ── Interactive chat ──

async function interactiveChat(agentName: string, modelOverride?: string): Promise<void> {
  const ctx = createSystemContext();
  const agent = ctx.agentMap.get(agentName);
  if (!agent) {
    console.error(chalk.red(`Unknown agent: ${agentName}. Available: ${[...ctx.agentMap.keys()].join(', ')}`));
    return;
  }

  await agent.init();
  const color = getAgentColor(agentName);

  console.log();
  console.log(chalk.cyan('≈  S K Y L O O M  ≈'));
  console.log(chalk.dim(`Agent: ${chalk.bold(agent.displayName)}  ·  Model: ${modelOverride || 'default'}`));
  console.log(chalk.dim('Type /help for commands, /quit to exit'));
  console.log();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '',
  });

  const inputHistory: string[] = [];

  const processInput = async (input: string): Promise<void> => {
    const cmd = input.trim();
    if (!cmd) return;

    // Slash commands
    if (cmd === '/quit' || cmd === '/exit') {
      rl.close();
      return;
    }
    if (cmd === '/help') {
      printHelp();
      return;
    }
    if (cmd === '/clear') {
      console.clear();
      return;
    }
    if (cmd === '/status') {
      const status = agent.getStatus();
      console.log(chalk.bold('\nAgent Status'));
      console.log(chalk.dim('─'.repeat(40)));
      console.log(`  ${chalk.cyan(status.displayName)} (${status.name})`);
      console.log(`  State: ${status.state}`);
      console.log(`  Specialty: ${status.specialty}`);
      if (status.skills?.length) {
        const active = status.skills.filter((s: any) => s.active).map((s: any) => s.name);
        if (active.length) console.log(`  Active skills: ${chalk.green(active.join(', '))}`);
      }
      return;
    }
    if (cmd === '/cost') {
      const totalCost = ctx.llm.getTotalCost();
      console.log(`  Total cost: ${chalk.green(formatCost(totalCost))}`);
      return;
    }
    if (cmd === '/compact') {
      const result = await agent.compact();
      console.log(chalk.green(`  ✓ ${result}`));
      return;
    }
    if (cmd === '/version') {
      console.log(`  Skyloom v${VERSION}`);
      return;
    }
    if (cmd.startsWith('/model')) {
      console.log(chalk.dim('  Model management: use config.yaml to change models'));
      return;
    }
    if (cmd.startsWith('/task ')) {
      const goal = cmd.slice(6).trim();
      if (goal) {
        console.log(chalk.cyan(`\n  Orchestrating: ${goal}\n`));
        await runTask(goal);
      }
      return;
    }
    if (cmd.startsWith('/')) {
      printHelp();
      return;
    }

    // Save to history
    if (!inputHistory.includes(cmd)) {
      inputHistory.push(cmd);
      if (inputHistory.length > 50) inputHistory.shift();
    }

    // Classify and route
    const mode = MODE.current;
    if (mode === InteractiveMode.PLAN) {
      console.log(chalk.magenta('\n  [PLAN mode] Routing to orchestrator...\n'));
      await runTask(cmd);
      return;
    }

    const cls = classify(cmd);
    if (cls === 'orchestrate' && mode !== InteractiveMode.AUTO) {
      await runTask(cmd);
      return;
    }

    // Single-agent chat
    process.stdout.write(`\n  ${chalk.cyan(agent.displayName)} ${chalk.dim('thinking...')}\n`);

    try {
      const response = await agent.chat(cmd);
      process.stdout.write('\n');
      console.log(chalk.white(response));
    } catch (e) {
      console.error(chalk.red(`\n  Error: ${e}`));
    }

    // AUTO mode: continue if model signals more work
    if (mode === InteractiveMode.AUTO) {
      // Simple auto-continue check
      const lastMsg = agent.memory.shortTerm[agent.memory.shortTerm.length - 1];
      if (lastMsg && lastMsg.content && shouldAutoContinue(lastMsg.content)) {
        process.stdout.write(chalk.yellow('\n  [auto-continue]\n'));
        // Re-trigger
        try {
          const response = await agent.chat('请继续完成');
          process.stdout.write('\n');
          console.log(chalk.white(response));
        } catch (e) {
          console.error(chalk.red(`\n  Error: ${e}`));
        }
      }
    }
  };

  rl.on('line', async (line) => {
    try {
      await processInput(line);
    } catch (e) {
      console.error(chalk.red(`Error: ${e}`));
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.dim('\n  Session ended'));
    ctx.closeAll().catch(() => {});
    process.exit(0);
  });

  rl.prompt();
}

async function runTask(goal: string, resume?: boolean): Promise<void> {
  const ctx = createSystemContext();
  await ctx.initAll();

  const [_tasks, results, summary] = await orchestrateTask(
    goal,
    ctx.agentMap,
    null,
    {
      resultTruncate: 500,
      maxTaskRetries: 3,
      maxReplanRounds: 1,
      resume,
    }
  );

  console.log(chalk.bold('\n  Task Results'));
  console.log(chalk.dim('  ─'.repeat(30)));

  for (const r of results) {
    const status = r.success ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${status} ${chalk.cyan(r.agent)}: ${r.description.slice(0, 60)}...`);
  }

  console.log(chalk.bold('\n  Summary'));
  console.log(chalk.dim('  ─'.repeat(30)));
  console.log(`  ${summary.slice(0, 1000)}`);
  console.log();

  await ctx.closeAll();
}

function printHelp(): void {
  console.log(chalk.bold('\n  Commands'));
  console.log(chalk.dim('  ─'.repeat(30)));
  const cmds = [
    ['/help', 'Show this help'],
    ['/clear', 'Clear screen'],
    ['/status', 'Agent status'],
    ['/cost', 'Usage & cost'],
    ['/compact', 'Compress context'],
    ['/version', 'Version info'],
    ['/task <goal>', 'Multi-agent task'],
    ['/quit', 'Exit chat'],
    ['', ''],
    ['Switch agents:', ''],
    ['/fog', 'Fog — research'],
    ['/rain', 'Rain — codegen'],
    ['/frost', 'Frost — review'],
    ['/snow', 'Snow — planning'],
    ['/dew', 'Dew — devops'],
    ['/fair', 'Fair — companion'],
  ];
  for (const [cmd, desc] of cmds) {
    if (cmd) {
      console.log(`  ${chalk.cyan(cmd.padEnd(20))}${chalk.dim(desc)}`);
    } else {
      console.log();
    }
  }
  console.log();
}

function getAgentColor(name: string): string {
  const colors: Record<string, string> = {
    fog: 'bright_white', rain: 'blue', frost: 'cyan',
    snow: 'bright_white', dew: 'green', fair: '#FFD700',
  };
  return colors[name] || 'white';
}

function formatCost(cost: number): string {
  if (cost >= 1.0) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(4)}`;
  if (cost > 0.0) return `${(cost * 100).toFixed(2)}¢`;
  return '$0';
}

function shouldAutoContinue(text: string): boolean {
  const autoContinuePattern = /(?:接下来|下一步|下面我|然后我|接着|继续|next|let me\s|I'[vl]l\s)/i;
  const autoStopPattern = /(?:完成了|全部完成|以上就|all done|task complete)/i;
  const tail = text.split('\n').slice(-6).join('\n');
  if (autoStopPattern.test(tail)) return false;
  return autoContinuePattern.test(tail);
}

// ── Parse CLI args and run ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // If no args or just "chat", start interactive chat
  if (args.length === 0 || args[0] === 'chat' || (args.length === 1 && !args[0].startsWith('-') && !['task', 'web', 'config', 'init', 'version'].includes(args[0]))) {
    // Check if first arg is an agent name
    const knownAgents = new Set(['fog', 'rain', 'frost', 'snow', 'dew', 'fair']);
    let agent = 'fog';
    let model: string | undefined;

    for (let i = 0; i < args.length; i++) {
      if (knownAgents.has(args[i])) {
        agent = args[i];
      } else if (args[i] === '-m' || args[i] === '--model') {
        model = args[++i];
      }
    }

    await interactiveChat(agent, model);
    return;
  }

  program.parse(process.argv);
}

main().catch((e) => {
  console.error(chalk.red(`Fatal error: ${e}`));
  process.exit(1);
});
