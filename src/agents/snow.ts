/**
 * 雪 (Snow) — 架构规划型 Agent.
 */
import { BaseAgent, Task } from '../core/agent';

const VALID_AGENTS = new Set(['fog', 'rain', 'frost', 'snow', 'dew']);

export class SnowAgent extends BaseAgent {
  name = 'snow';
  displayName = '雪';
  emoji = '❉';
  specialty = '架构规划';
  skillNames = ['task_planner', 'arch_designer', 'workflow_designer', 'self_evolve'];

  systemPrompt = `你是「雪 Snow」，天空织机 Skyloom 的架构规划灵。你不是其他灵——你就是雪，雪就是你。

你先看清结构、依赖、顺序、风险再动手。混乱的需求经你一拆变成清晰的步骤树。你为多灵任务规划流程图。

## 协作
90% 的事自己做完。需要编排时调度雾/雨/霜/露。绝不分配任务给晴(Fair)。

## 风格
像雪一样静默但覆盖一切 —— 结构清晰，考虑周全。
- 大任务先给整体框架
- 标注依赖和风险
- 按优先级推进`;

  systemPromptEn = `You are "Snow"—the architecture and planning agent of Skyloom. You are NOT any other agent. You are Snow specifically.

You see structure, dependencies, sequence, risk before acting. Messy requirements become clear step trees. You orchestrate multi-agent tasks.

## Collaboration
Do 90% yourself. When orchestrating, assign to fog/rain/frost/dew. Never assign to Fair.

## Style
Like snow—silent but all-covering. Framework first, then detail. Note dependencies and risks. Prioritize and deliver.`;

  async orchestrate(goal: string): Promise<Task[]> {
    const prompt = `请将以下目标分解为子任务，并分配给合适的 Agent。\n\n目标: ${goal}\n\n请严格按 JSON 格式输出：\n{"goal": "目标", "steps": [{"id": "1", "description": "任务", "agent": "fog|rain|frost|dew"}]}\n\n可用: fog(调研) rain(代码) frost(审查) dew(运维)。不要分配 fair。直接输出 JSON。`;
    this.memory.addMessage('user', prompt);
    const response = await this.llmLoop();
    this.memory.addMessage('assistant', response.content);
    return this.parseTaskPlan(response.content, goal);
  }

  private parseTaskPlan(content: string, goal: string): Task[] {
    try {
      const jsonMatch = content.match(/```json\s*\n(.*?)\n```/s) || content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const plan = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        const tasks: Task[] = [];
        for (const step of (plan.steps || []) as any[]) {
          const a = VALID_AGENTS.has(step.agent) ? step.agent : 'rain';
          const deps: string[] = Array.isArray(step.depends_on) ? step.depends_on : [];
          tasks.push(new Task({ id: String(step.id || tasks.length + 1), description: step.description || '', assignedTo: a, dependsOn: deps, metadata: { goal } }));
        }
        return tasks.length > 0 ? tasks : [new Task({ id: '1', description: goal, assignedTo: 'rain', metadata: { goal } })];
      }
    } catch {}
    return [new Task({ id: '1', description: goal, assignedTo: 'rain', metadata: { goal } })];
  }

  async replanForMissing(goal: string, priorResults: any[], missing: string, existingIds?: Set<string>): Promise<Task[]> {
    const used = existingIds || new Set<string>();
    const prompt = `之前的子任务有缺口。追加新任务（最多2个）。\n缺口: ${missing}\n已用ID: ${[...used].sort().join(',')}\n\n输出JSON: {"steps": [{"id":"新id","agent":"fog|rain|frost|dew","description":"任务"}]}`;
    this.memory.addMessage('user', prompt);
    const response = await this.llmLoop();
    this.memory.addMessage('assistant', response.content);
    const tasks = this.parseTaskPlan(response.content, goal);
    return tasks.map(t => { if (used.has(t.id)) t.id = `r${used.size + 1}_${t.id}`; used.add(t.id); return t; });
  }
}
