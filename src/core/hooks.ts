/**
 * Hooks — user-configured shell commands at tool-execution lifecycle points.
 *
 * Unlike prompts or memory, hooks are *enforced*: they run regardless of what
 * the model decides. A pre_tool hook exiting non-zero blocks the call.
 *
 * config.yaml:
 *   hooks:
 *     session_start:
 *       - "echo session up"
 *     pre_tool:
 *       - matcher: "run_bash|delete_file"     # regex on tool name
 *         command: "./scripts/guard.sh"        # non-zero exit blocks the tool
 *     post_tool:
 *       - matcher: "write_file|edit_file"
 *         command: "npx prettier --write \"$SKY_FILE\""
 *
 * Hook env: SKY_TOOL (tool name), SKY_ARGS (args JSON), SKY_FILE (path arg
 * if present), SKY_AGENT (agent name).
 */

import { spawnSync } from 'child_process';
import { getLogger } from './logger';

const log = getLogger('hooks');

export interface HookSpec {
  matcher?: string;
  command: string;
}

export interface Hooks {
  sessionStart: string[];
  preTool: HookSpec[];
  postTool: HookSpec[];
}

const HOOK_TIMEOUT_MS = 30_000;

function normalizeSpecs(raw: any): HookSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: HookSpec[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) out.push({ command: item });
    else if (item && typeof item.command === 'string' && item.command.trim()) {
      out.push({ matcher: typeof item.matcher === 'string' ? item.matcher : undefined, command: item.command });
    }
  }
  return out;
}

export function loadHooks(config: any): Hooks {
  const h: any = config?.hooks || {};
  return {
    sessionStart: normalizeSpecs(h.session_start).map(s => s.command),
    preTool: normalizeSpecs(h.pre_tool),
    postTool: normalizeSpecs(h.post_tool),
  };
}

export function matches(spec: HookSpec, toolName: string): boolean {
  if (!spec.matcher) return true;
  try {
    return new RegExp(spec.matcher).test(toolName);
  } catch {
    return spec.matcher === toolName;
  }
}

function hookEnv(toolName: string, args: Record<string, any>, agent: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SKY_TOOL: toolName,
    SKY_ARGS: JSON.stringify(args ?? {}).slice(0, 8000),
    SKY_FILE: String(args?.path ?? args?.file ?? args?.file_path ?? ''),
    SKY_AGENT: agent,
  };
}

function runHook(command: string, env: NodeJS.ProcessEnv): { code: number; output: string } {
  const r = spawnSync(command, { shell: true, encoding: 'utf-8', timeout: HOOK_TIMEOUT_MS, env });
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 1000);
  return { code: r.error ? 1 : (r.status ?? 1), output };
}

/**
 * Run matching pre_tool hooks. The first non-zero exit blocks the call.
 */
export function runPreToolHooks(
  hooks: Hooks,
  toolName: string,
  args: Record<string, any>,
  agent: string
): { allowed: boolean; reason: string } {
  for (const spec of hooks.preTool) {
    if (!matches(spec, toolName)) continue;
    const { code, output } = runHook(spec.command, hookEnv(toolName, args, agent));
    if (code !== 0) {
      log.warn('pre_tool_hook_blocked', { tool: toolName, hook: spec.command, code });
      return { allowed: false, reason: output || `hook exited ${code}` };
    }
  }
  return { allowed: true, reason: '' };
}

/** Run matching post_tool hooks (best-effort; failures only logged). */
export function runPostToolHooks(
  hooks: Hooks,
  toolName: string,
  args: Record<string, any>,
  agent: string
): void {
  for (const spec of hooks.postTool) {
    if (!matches(spec, toolName)) continue;
    const { code, output } = runHook(spec.command, hookEnv(toolName, args, agent));
    if (code !== 0) log.warn('post_tool_hook_failed', { tool: toolName, hook: spec.command, code, output });
  }
}

/** Run session_start hooks once at system construction. */
export function runSessionStartHooks(hooks: Hooks): void {
  for (const command of hooks.sessionStart) {
    const { code, output } = runHook(command, process.env);
    if (code !== 0) log.warn('session_start_hook_failed', { hook: command, code, output });
  }
}
