/**
 * 项目记忆 (SKY.md) — Skyloom's equivalent of Claude Code's CLAUDE.md.
 *
 * A layered, auto-loaded instruction file that gives every agent durable
 * knowledge of the project: build commands, conventions, constraints.
 *
 * Load order (all layers concatenate, later = more specific):
 *   1. ~/.skyloom/SKY.md          — user level, applies to every project
 *   2. ./SKY.md | ./CLAUDE.md | ./AGENTS.md — project level (first match;
 *      CLAUDE.md/AGENTS.md compatibility means existing repos work as-is)
 *   3. ./SKY.local.md             — project level, personal (gitignored)
 *
 * The merged text is injected into every agent's system prompt at init.
 * `#<note>` in chat appends to the project file via appendQuickMemory().
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Total budget for injected memory — it lives in every prompt, keep it lean. */
const MAX_MEMORY_CHARS = 12000;
/** Per-file budget so one bloated layer can't crowd out the others. */
const MAX_FILE_CHARS = 6000;

export interface ProjectMemory {
  /** Merged, truncated text ready for prompt injection ('' if no files). */
  text: string;
  /** Absolute paths of the files that contributed. */
  files: string[];
}

const PROJECT_FILE_CANDIDATES = ['SKY.md', 'CLAUDE.md', 'AGENTS.md'];

function readClamped(p: string): string | null {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8').trim();
    if (!raw) return null;
    return raw.length > MAX_FILE_CHARS
      ? raw.slice(0, MAX_FILE_CHARS) + '\n…[truncated]'
      : raw;
  } catch {
    return null;
  }
}

/** Resolve the project-level memory file (existing first candidate, or null). */
export function projectMemoryFile(cwd: string = process.cwd()): string | null {
  for (const name of PROJECT_FILE_CANDIDATES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Load and merge all memory layers for prompt injection. */
export function loadProjectMemory(cwd: string = process.cwd()): ProjectMemory {
  const layers: Array<{ label: string; file: string }> = [];

  const userFile = path.join(os.homedir(), '.skyloom', 'SKY.md');
  layers.push({ label: '用户级', file: userFile });

  const projFile = projectMemoryFile(cwd);
  if (projFile) layers.push({ label: '项目级', file: projFile });

  const localFile = path.join(cwd, 'SKY.local.md');
  layers.push({ label: '本地', file: localFile });

  const parts: string[] = [];
  const files: string[] = [];
  for (const { label, file } of layers) {
    const content = readClamped(file);
    if (content === null) continue;
    parts.push(`<!-- ${label}: ${path.basename(file)} -->\n${content}`);
    files.push(file);
  }

  let text = parts.join('\n\n');
  if (text.length > MAX_MEMORY_CHARS) text = text.slice(0, MAX_MEMORY_CHARS) + '\n…[truncated]';
  return { text, files };
}

const SKY_MD_HEADER = `# SKY.md — 项目记忆

> Skyloom agents 启动时自动加载本文件。写团队约定、构建/测试命令、代码风格。
> 对话中输入 \`#内容\` 可快速追加一条。

`;

/**
 * Append a one-line note (the \`#\` quick-memory flow).
 * Writes to the existing project memory file, or creates ./SKY.md.
 * Returns the file path written.
 */
export function appendQuickMemory(note: string, cwd: string = process.cwd()): string {
  const target = projectMemoryFile(cwd) ?? path.join(cwd, 'SKY.md');
  const line = `- ${note.trim()}\n`;
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, SKY_MD_HEADER + line, 'utf-8');
  } else {
    const existing = fs.readFileSync(target, 'utf-8');
    fs.appendFileSync(target, (existing.endsWith('\n') ? '' : '\n') + line, 'utf-8');
  }
  return target;
}

/**
 * Extract verify commands from a "## Verify" / "## 验证" section of the
 * merged memory text: each non-comment line of its fenced code block.
 */
export function parseVerifyCommands(memoryText: string): string[] {
  const cmds: string[] = [];
  let inSection = false;
  let inFence = false;
  for (const line of memoryText.split('\n')) {
    if (/^##\s*(verify|验证)/i.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    if (/^##\s/.test(line)) break; // next section
    if (line.trim().startsWith('```')) {
      if (inFence) break; // closing fence — done
      inFence = true;
      continue;
    }
    if (inFence) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('//')) cmds.push(t);
    }
  }
  return cmds;
}

/** The prompt behind /init — asks the agent to study the repo and write SKY.md. */
export const INIT_PROMPT = `请为当前项目生成一份 SKY.md 项目记忆文件（如已存在则改进它）：

1. 用工具调研项目：读 README、package.json/pyproject.toml/Cargo.toml 等清单文件，list_directory 看结构，必要时读关键入口源码
2. 写出一份**短而精**的 SKY.md（每一行都占用所有 agent 的上下文，宁缺毋滥），包含：
   - 项目一句话定位与技术栈
   - 构建/测试/lint 命令（放在 "## Verify" 小节的代码块里，agents 会用它自动验证）
   - 目录结构要点（只列关键目录）
   - 代码风格与硬性约束（如「禁止 any」「提交信息格式」）
3. 用 write_file 写到项目根目录 SKY.md
4. 最后简要汇报你写了什么`;
