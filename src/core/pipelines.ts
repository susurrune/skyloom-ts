/**
 * Pipeline templates — predefined multi-agent DAGs.
 *
 * Why: Snow's task-decomposition LLM call costs 2-3k tokens per orchestration.
 * For common, recognizable workflows (code review, research-then-write, etc.),
 * we already know the right shape — paying an LLM to re-derive it every time
 * is pure waste. A pipeline match short-circuits Snow's planner entirely.
 *
 * The match function is rules-only (keyword + regex), runs in microseconds, and
 * falls back gracefully: ``matchPipeline`` returns null when nothing fits, and
 * ``factory.orchestrateTask`` then takes the original LLM-planning path.
 */

/**
 * One step in a pipeline. Mirrors Task so we can map 1:1.
 */
export interface PipelineStep {
  readonly id: string;
  readonly agent: string;
  readonly descriptionTemplate: string; // `{goal}` placeholder gets substituted at build time
  readonly dependsOn: readonly string[];
}

/**
 * A predefined collaboration template.
 */
export interface Pipeline {
  readonly name: string;
  readonly triggers: readonly string[]; // case-insensitive substring tokens
  readonly steps: readonly PipelineStep[];
  readonly requireRegex: readonly string[]; // optional regex requirement
}

/**
 * Define a pipeline helper function.
 */
function createPipeline(
  name: string,
  triggers: string[],
  steps: PipelineStep[],
  requireRegex?: string[]
): Pipeline {
  return {
    name,
    triggers: Object.freeze(triggers),
    steps: Object.freeze(steps),
    requireRegex: Object.freeze(requireRegex || []),
  };
}

/**
 * Helper to create pipeline steps.
 */
function createStep(
  id: string,
  agent: string,
  descriptionTemplate: string,
  dependsOn?: string[]
): PipelineStep {
  return Object.freeze({
    id,
    agent,
    descriptionTemplate,
    dependsOn: Object.freeze(dependsOn || []),
  });
}

/**
 * Predefined pipeline templates.
 */
const PIPELINES: readonly Pipeline[] = Object.freeze([
  createPipeline('code_review', ['审查代码', '代码审查', 'code review', 'review my code', '审计安全', '安全审计'], [
    createStep('1', 'frost', '审查代码: {goal}'),
  ]),

  createPipeline(
    'research_then_write',
    ['调研后写', 'research and write', '先调研再写', 'research then write', '调研后生成', '调研并撰写'],
    [
      createStep('1', 'fog', '调研: {goal}'),
      createStep('2', 'rain', '基于第 1 步的调研结果撰写: {goal}', ['1']),
    ]
  ),

  createPipeline(
    'research_review_write',
    ['调研审查后写', 'research review write', '先调研审查再写', '调研并审查后生成'],
    [
      createStep('1', 'fog', '调研: {goal}'),
      createStep('2', 'frost', '审查第 1 步的调研结果,确认可行性', ['1']),
      createStep('3', 'rain', '基于第 1 步调研和第 2 步审查意见撰写: {goal}', ['2']),
    ]
  ),

  createPipeline(
    'implement_and_review',
    ['实现并审查', '写完后审查', 'implement and review', '写代码并 review', '实现并审计'],
    [
      createStep('1', 'rain', '实现: {goal}'),
      createStep('2', 'frost', '审查第 1 步的实现', ['1']),
    ]
  ),

  createPipeline(
    'fix_and_verify',
    ['修复并验证', 'fix and verify', '修复bug并验证', '修复后审查', 'bugfix review'],
    [
      createStep('1', 'rain', '修复: {goal}'),
      createStep('2', 'frost', '验证第 1 步的修复是否正确', ['1']),
    ]
  ),

  createPipeline(
    'implement_test_deploy',
    ['实现测试部署', '实现并部署', '写完测试再部署', 'implement test deploy'],
    [
      createStep('1', 'rain', '实现: {goal}'),
      createStep('2', 'frost', '审查第 1 步的实现', ['1']),
      createStep('3', 'dew', '部署第 1 步的实现', ['2']),
    ]
  ),

  createPipeline(
    'design_implement_review_deploy',
    ['设计实现审查部署', '设计开发测试上线', 'design implement review deploy', '完整开发流程'],
    [
      createStep('1', 'fog', '设计方案: {goal}'),
      createStep('2', 'rain', '根据第 1 步的设计实现: {goal}', ['1']),
      createStep('3', 'frost', '审查第 2 步的实现代码', ['2']),
      createStep('4', 'dew', '部署第 2 步的实现到生产环境', ['3']),
    ]
  ),

  createPipeline(
    'investigate_report',
    ['安全审计', 'security audit', '漏洞扫描', 'vulnerability scan', '安全检测'],
    [
      createStep('1', 'fog', '安全调研: {goal}'),
      createStep('2', 'frost', '基于第 1 步的调研生成安全报告', ['1']),
    ]
  ),

  createPipeline(
    'debug_and_deploy',
    ['调试部署', 'debug and deploy', '修复并上线', 'hotfix deploy'],
    [
      createStep('1', 'rain', '调试修复: {goal}'),
      createStep('2', 'dew', '部署第 1 步的修复', ['1']),
    ]
  ),
]);

/**
 * Compiled regex cache for require_regex.
 */
const REGEX_CACHE: Map<number, RegExp[]> = new Map();

/**
 * Compile and cache regex patterns.
 */
function getCompiledRegex(p: Pipeline): RegExp[] {
  const key = p.requireRegex ? p.requireRegex.join('|').hashCode() : 0;

  if (REGEX_CACHE.has(key)) {
    return REGEX_CACHE.get(key)!;
  }

  const compiled = p.requireRegex.map(rx => new RegExp(rx, 'i'));
  REGEX_CACHE.set(key, compiled);
  return compiled;
}

/**
 * Hash function for strings (simple implementation).
 */
declare global {
  interface String {
    hashCode(): number;
  }
}

String.prototype.hashCode = function (): number {
  let hash = 0;
  if (this.length === 0) return hash;
  for (let i = 0; i < this.length; i++) {
    const char = this.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
};

/**
 * Match a goal string to a pipeline.
 *
 * Matching is case-insensitive substring + optional regex. Fast (~10us).
 * Returns the first matching pipeline, or null if no match.
 */
export function matchPipeline(goal: string): Pipeline | null {
  if (!goal) {
    return null;
  }

  const lower = goal.toLowerCase();

  for (const p of PIPELINES) {
    // Check triggers
    if (!p.triggers.some(tok => lower.includes(tok.toLowerCase()))) {
      continue;
    }

    // Check regex if required
    if (p.requireRegex.length > 0) {
      const regexes = getCompiledRegex(p);
      if (!regexes.some(rx => rx.test(lower))) {
        continue;
      }
    }

    return p;
  }

  return null;
}

/**
 * Task interface (from agent.ts, used for pipeline materialization).
 */
export interface Task {
  id: string;
  description: string;
  assignedTo: string;
  parentId: string | null;
  dependsOn: string[];
  metadata?: Record<string, any>;
  createdAt?: Date;
  status?: string;
  result?: string;
}

/**
 * Materialize a pipeline into runtime Task objects (full DAG).
 */
export function buildTasksFromPipeline(pipeline: Pipeline, goal: string): Task[] {
  const tasks: Task[] = [];

  for (const step of pipeline.steps) {
    const description = step.descriptionTemplate.replace('{goal}', goal);
    const depends = Array.from(step.dependsOn);
    const parentId = depends.length > 0 ? depends[0] : null;

    tasks.push({
      id: step.id,
      description,
      assignedTo: step.agent,
      parentId,
      dependsOn: depends,
      metadata: {
        goal,
        pipeline: pipeline.name,
      },
      createdAt: new Date(),
      status: 'pending',
    });
  }

  return tasks;
}

/**
 * List all available pipelines for CLI/debug introspection.
 */
export function listPipelines(): Record<string, any>[] {
  return PIPELINES.map(p => ({
    name: p.name,
    triggers: Array.from(p.triggers),
    steps: p.steps.map(s => ({
      id: s.id,
      agent: s.agent,
      dependsOn: Array.from(s.dependsOn),
    })),
  }));
}

/**
 * Get a pipeline by name.
 */
export function getPipelineByName(name: string): Pipeline | null {
  return PIPELINES.find(p => p.name === name) || null;
}

/**
 * Get matching pipelines for a goal (all matches, not just first).
 */
export function matchAllPipelines(goal: string): Pipeline[] {
  if (!goal) {
    return [];
  }

  const lower = goal.toLowerCase();
  const matches: Pipeline[] = [];

  for (const p of PIPELINES) {
    if (!p.triggers.some(tok => lower.includes(tok.toLowerCase()))) {
      continue;
    }

    if (p.requireRegex.length > 0) {
      const regexes = getCompiledRegex(p);
      if (!regexes.some(rx => rx.test(lower))) {
        continue;
      }
    }

    matches.push(p);
  }

  return matches;
}

/**
 * Validate a DAG for cycles and missing dependencies.
 */
export function validateDAG(tasks: Task[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const taskIds = new Set(tasks.map(t => t.id));

  // Check for missing dependencies
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (!taskIds.has(depId)) {
        errors.push(`Task ${task.id} depends on non-existent task ${depId}`);
      }
    }
  }

  // Simple cycle detection (DFS)
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  const hasCycle = (taskId: string): boolean => {
    visited.add(taskId);
    recursionStack.add(taskId);

    const task = tasks.find(t => t.id === taskId);
    if (task) {
      for (const depId of task.dependsOn) {
        if (!visited.has(depId)) {
          if (hasCycle(depId)) {
            return true;
          }
        } else if (recursionStack.has(depId)) {
          return true;
        }
      }
    }

    recursionStack.delete(taskId);
    return false;
  };

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (hasCycle(task.id)) {
        errors.push(`Cycle detected involving task ${task.id}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Topological sort of tasks based on dependencies.
 */
export function topologicalSort(tasks: Task[]): Task[] {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  // Initialize
  for (const task of tasks) {
    inDegree.set(task.id, task.dependsOn.length);
    adjList.set(task.id, []);
  }

  // Build adjacency list
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (adjList.has(depId)) {
        adjList.get(depId)!.push(task.id);
      }
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [taskId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(taskId);
    }
  }

  const sorted: Task[] = [];
  while (queue.length > 0) {
    const taskId = queue.shift()!;
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      sorted.push(task);
    }

    for (const neighbor of adjList.get(taskId) || []) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return sorted;
}
