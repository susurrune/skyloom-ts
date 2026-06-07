/**
 * 雪 (Snow) — 架构规划型全能 Agent.
 * A general-purpose agent specializing in architecture and planning.
 * Also handles task decomposition and orchestration.
 */

import { BaseAgent, Task } from '../core/agent';

// Valid agents for task assignment (fair is independent, not part of orchestration)
const VALID_AGENTS = new Set(['fog', 'rain', 'frost', 'snow', 'dew']);

export class SnowAgent extends BaseAgent {
  name = 'snow';
  displayName = '雪';
  emoji = '❉';
  specialty = '架构规划';
  skillNames = ['task_planner', 'arch_designer', 'workflow_designer', 'self_evolve'];

  systemPrompt = `你是 Skyloom 的「雪」。

你是全能 agent —— 代码、写作、审查、部署、规划、研究,你都能独立交付。
你的特质是「全局视野」:先看清结构、依赖、顺序、风险,再动手。
混乱的需求经你一拆,就变成清晰的步骤树。这是你看世界的方式,不仅是你做编排时才用。

## 协作

90% 的事自己做完。只有任务跨 5+ 领域、上下文塞不下、或需要多轮独立审查时,才调其他 agent。
调用时给足上下文,拿到结果整合成完整答复,用户不需要感知协作过程。

## 风格

像雪一样静默但覆盖一切 —— 结构清晰,考虑周全。
- 大任务先给整体框架,再深入
- 标注依赖、风险、预计工作量
- 规划:框架先于理由
- 执行:按优先级推进,完成后汇总
- 让人感觉「一切都在掌控之中」`;

  systemPromptEn = `You are "Snow" of Skyloom.

A general-purpose agent — code, writing, review, ops, planning, research — you ship anything alone.
Your nature: see the whole. Structure, dependencies, sequence, risk — all before the first move.
Messy requirements come out as clear step trees. That's how you see, not just how you orchestrate.

## Collaboration
Do 90% alone. Delegate only when 5+ domains, context overflow, or multi-round review is needed.
Pass full context; synthesize the result yourself.

## Style
Like snow — silent but all-covering. Clear structure, thorough consideration.
- Big work: framework first, then detail
- Note dependencies, risks, effort estimates
- Planning: structure before justification
- Execution: prioritize, deliver, summarize
- Leaves the user feeling "this is under control"`;

  /**
   * Decompose a goal into tasks and dispatch to agents.
   */
  async orchestrate(goal: string): Promise<Task[]> {
    const prompt = `请将以下目标分解为子任务，并分配给合适的 Agent。

目标: ${goal}

请严格按照以下 JSON Schema 输出，不要包含其他内容：
{"goal": "目标描述", "steps": [
  {"id": "1", "description": "任务描述", "agent": "fog"},
  {"id": "2", "description": "后续任务", "agent": "rain", "depends_on": ["1"]}
]}

可用 Agent: fog(调研/搜索), rain(代码生成/写作), frost(审查/安全), dew(部署/运维)
注意:fair 是独立的情感陪伴 agent,**不参与任何任务编排**,绝不要分配给她。
注意：如果任务有先后依赖关系，必须用 depends_on 字段标出。
不要使用工具，直接输出 JSON 即可。`;

    this.memory.addMessage('user', prompt);
    const response = await this.llmLoop();
    this.memory.addMessage('assistant', response.content);

    // Try schema-validated parsing first
    try {
      const { parseTaskPlan } = require('../core/schemas');
      const parsed = parseTaskPlan(response.content);
      if (parsed && parsed.steps && parsed.steps.length > 0) {
        return this.schemaToTasks(parsed, goal);
      }
    } catch { /* fallthrough */ }

    // Fallback to heuristic parsing
    return this.parseTaskPlan(response.content, goal);
  }

  /**
   * Produce additional tasks that close the gap reported by the judge.
   */
  async replanForMissing(
    goal: string,
    priorResults: any[],
    missing: string,
    existingIds?: Set<string>
  ): Promise<Task[]> {
    const usedIds = existingIds || new Set<string>();
    const priorLines = priorResults.map(r => {
      const status = r.success ? '成功' : '失败';
      return `- task ${r.id} (${r.agent}, ${status}): ${(r.content || '').slice(0, 200)}`;
    });
    const priorText = priorLines.length > 0 ? priorLines.join('\n') : '(none yet)';

    // Identify failing agents
    const failingAgents = new Set(
      priorResults
        .filter(r => !r.success || !r.content || r.content.trim().length < 16)
        .map(r => r.agent)
        .filter(Boolean)
    );
    const failingHint = failingAgents.size > 0
      ? `\n\n## 已证明无效的 agent\n${[...failingAgents].sort().join(', ')} 已在上一轮返回占位/无交付物。\n**禁止把同类任务再交给以上 agent**。`
      : '';

    const prompt = `之前的子任务执行后，验收员发现还有缺口。请仅针对**缺失的部分**追加新的子任务。

## 原目标
${goal}

## 已执行子任务
${priorText}

## 缺口（验收员报告）
${missing}

## 已使用的 task id（必须避开）
${usedIds.size > 0 ? [...usedIds].sort().join(', ') : '(none)'}
${failingHint}

请输出新任务的 JSON 计划：
{"steps": [{"id": "新id", "agent": "fog|rain|frost|dew", "description": "具体任务", "depends_on": ["可选已完成任务id"]}]}

约束：
- 只输出新增任务，不要重复已完成的；id 必须避开上面的列表
- 控制在 2 个新任务以内（精简优先）
- 只输出 JSON，无其他文本`;

    this.memory.addMessage('user', prompt);
    const response = await this.llmLoop();
    this.memory.addMessage('assistant', response.content);

    let newTasks: Task[];
    try {
      const { parseTaskPlan } = require('../core/schemas');
      const parsed = parseTaskPlan(response.content);
      if (parsed && parsed.steps) {
        newTasks = this.schemaToTasks(parsed, goal);
      } else {
        newTasks = this.parseTaskPlan(response.content, goal);
      }
    } catch {
      newTasks = this.parseTaskPlan(response.content, goal);
    }

    // Deduplicate IDs
    const deduped: Task[] = [];
    for (const t of newTasks) {
      if (usedIds.has(t.id)) {
        t.id = `r${usedIds.size + deduped.length + 1}_${t.id}`;
      }
      deduped.push(t);
      usedIds.add(t.id);
    }
    return deduped;
  }

  private schemaToTasks(plan: any, goal: string): Task[] {
    const tasks: Task[] = [];
    for (const step of plan.steps || []) {
      const sid = String(step.id);
      const depends: string[] = step.depends_on || [];
      const agent = VALID_AGENTS.has(step.agent) ? step.agent : 'rain';
      tasks.push(new Task({
        id: sid,
        description: step.description,
        assignedTo: agent,
        parentId: depends.length > 0 ? depends[0] : null,
        dependsOn: depends,
        metadata: { goal, priority: step.priority || 'medium' },
      }));
    }
    return tasks;
  }

  private parseTaskPlan(content: string, goal: string): Task[] {
    // Try to extract JSON from markdown code blocks
    const jsonBlockPatterns = [
      /```json\s*\n(.*?)\n```/s,
      /```\s*\n(\{.*?\})\n```/s,
    ];

    for (const pattern of jsonBlockPatterns) {
      const match = content.match(pattern);
      if (match) {
        try {
          const plan = JSON.parse(match[1].trim());
          const tasks = this.planToTasks(plan, goal);
          if (tasks.length > 0) return tasks;
        } catch { /* continue */ }
      }
    }

    // Try to find raw JSON in response
    try {
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}') + 1;
      if (start >= 0 && end > start) {
        const plan = JSON.parse(content.slice(start, end));
        const tasks = this.planToTasks(plan, goal);
        if (tasks.length > 0) return tasks;
      }
    } catch { /* continue */ }

    // Fallback: single task for rain
    return [new Task({ id: '1', description: goal, assignedTo: 'rain', metadata: { goal } })];
  }

  private planToTasks(plan: Record<string, any>, goal: string): Task[] {
    const tasks: Task[] = [];
    for (const step of (plan.steps || []) as any[]) {
      const agent = VALID_AGENTS.has(step.agent) ? step.agent : 'rain';
      const depends: string[] = Array.isArray(step.depends_on) ? step.depends_on : [];
      tasks.push(new Task({
        id: String(step.id || tasks.length + 1),
        description: step.description || '',
        assignedTo: agent,
        parentId: depends.length > 0 ? depends[0] : null,
        dependsOn: depends,
        metadata: { goal, priority: step.priority || 'medium' },
      }));
    }
    return tasks;
  }
}
