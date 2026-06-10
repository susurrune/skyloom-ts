/**
 * todo_write — agents externalize multi-step task state (Claude Code 式).
 *
 * The agent maintains a checklist in working memory: plan it up front, mark
 * items active/done as it works. The list survives compaction (working
 * memory, not chat history), the CLI renders it live, and the tool's return
 * value keeps the current state visible to the model itself.
 *
 * Whole-list replace semantics: every call passes the complete list. That
 * keeps the tool idempotent and trivially recoverable after a bad call.
 */

import type { ToolDefinition } from '../core/tool';

export type TodoStatus = 'pending' | 'active' | 'done';
export interface TodoItem {
  text: string;
  status: TodoStatus;
}

const MAX_ITEMS = 20;
const STATUSES = new Set<string>(['pending', 'active', 'done']);

export const TODO_WORKING_KEY = 'todos';

/** Parse + validate the items argument (JSON array). */
export function parseTodoItems(raw: any): { items: TodoItem[] | null; error: string } {
  let parsed: any = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return { items: null, error: 'items 必须是合法 JSON 数组' }; }
  }
  if (!Array.isArray(parsed)) return { items: null, error: 'items 必须是数组' };
  if (parsed.length > MAX_ITEMS) return { items: null, error: `最多 ${MAX_ITEMS} 项 — 合并粒度` };
  const items: TodoItem[] = [];
  for (const it of parsed) {
    const text = typeof it === 'string' ? it : String(it?.text ?? '').trim();
    const status = typeof it === 'object' && it !== null && STATUSES.has(String(it.status)) ? String(it.status) : 'pending';
    if (!text) return { items: null, error: '存在空的任务项' };
    items.push({ text: text.slice(0, 120), status: status as TodoStatus });
  }
  return { items, error: '' };
}

export function renderTodoList(items: TodoItem[]): string {
  const done = items.filter(i => i.status === 'done').length;
  const lines = items.map(i => {
    const mark = i.status === 'done' ? '✓' : i.status === 'active' ? '◐' : '·';
    return `${mark} ${i.text}`;
  });
  return `任务清单 ${done}/${items.length}\n${lines.join('\n')}`;
}

export function createTodoTool(agent: { memory: { setWorking(k: string, v: any): void } }): ToolDefinition {
  return {
    name: 'todo_write',
    description:
      'Maintain your task checklist for multi-step work. Call it FIRST to plan (all pending), ' +
      'then again whenever an item starts (active) or finishes (done) — pass the COMPLETE list each time. ' +
      'items is a JSON array: [{"text":"...","status":"pending|active|done"}, ...]. ' +
      'Use for any task with 3+ steps; skip for trivial one-shot answers.',
    parameters: [
      {
        name: 'items',
        type: 'string',
        description: 'The complete checklist as a JSON array of {text, status} (status: pending/active/done)',
        required: true,
      },
    ],
    handler: async (kwargs: Record<string, any>) => {
      const { items, error } = parseTodoItems(kwargs.items);
      if (!items) return `✗ ${error}`;
      agent.memory.setWorking(TODO_WORKING_KEY, items);
      return `✓ ${renderTodoList(items)}`;
    },
  };
}
