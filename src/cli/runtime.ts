export type ChatSurface = 'loom' | 'classic';

const TOP_LEVEL_COMMANDS = new Set([
  'chat', 'task', 'web', 'mcp', 'gateway', 'channels', 'config',
  'init', 'apikey', 'version', 'doctor', 'help',
]);

export function isTopLevelCommand(value: string): boolean {
  return TOP_LEVEL_COMMANDS.has(value);
}

export interface TerminalCapabilities {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  rows?: number;
  columns?: number;
  classic?: boolean;
  forceClassic?: boolean;
}

export interface HeadlessInvocation {
  prompt: string;
  agent?: string;
  json: boolean;
  streamJson: boolean;
}

interface RuntimeInput extends AsyncIterable<unknown> {
  isTTY?: boolean;
}

export function selectChatSurface(capabilities: TerminalCapabilities): ChatSurface {
  const rows = capabilities.rows ?? 24;
  const columns = capabilities.columns ?? 80;
  return !capabilities.classic
    && !capabilities.forceClassic
    && capabilities.stdinTTY
    && capabilities.stdoutTTY
    && rows >= 14
    && columns >= 60
    ? 'loom'
    : 'classic';
}

export function parseHeadlessInvocation(args: string[], pipedInput: string): HeadlessInvocation | null {
  const promptIndex = args.findIndex((arg) => arg === '-p' || arg === '--print');
  if (promptIndex < 0) return null;

  const agentIndex = args.indexOf('--agent');
  if (agentIndex >= 0 && (!args[agentIndex + 1] || args[agentIndex + 1].startsWith('-'))) {
    throw new Error('Headless --agent requires a value');
  }

  const next = args[promptIndex + 1];
  const inlinePrompt = next && !next.startsWith('-') ? next : '';
  const prompt = [inlinePrompt, pipedInput.trim()].filter(Boolean).join('\n\n');
  if (!prompt) throw new Error('Headless prompt is required');

  return {
    prompt,
    agent: agentIndex >= 0 ? args[agentIndex + 1] : undefined,
    json: args.includes('--json'),
    streamJson: args.includes('--stream-json'),
  };
}

export async function readPipedInput(input: RuntimeInput): Promise<string> {
  if (input.isTTY) return '';
  let data = '';
  for await (const chunk of input) data += String(chunk);
  return data.trim();
}

export class TurnInterrupt {
  private readonly controller = new AbortController();
  private interrupted = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  handle(): 'abort' | 'exit' {
    if (this.interrupted) return 'exit';
    this.markInterrupted();
    return 'abort';
  }

  markInterrupted(): void {
    this.interrupted = true;
    if (!this.controller.signal.aborted) this.controller.abort();
  }

  get wasInterrupted(): boolean {
    return this.interrupted;
  }
}
