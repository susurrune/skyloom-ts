/**
 * Agent domain model — states and the Task DAG node.
 *
 * Extracted from the monolithic agent.ts (Phase 3). Pure, dependency-free,
 * and unit-testable in isolation. `agent.ts` re-exports these so external
 * importers of `../core/agent` are unaffected.
 */

/** Lifecycle state of a running agent. */
export enum AgentState {
  IDLE = 'idle',
  THINKING = 'thinking',
  ACTING = 'acting',
  WAITING = 'waiting',
  ERROR = 'error',
}

/** Lifecycle state of an orchestrated task. */
export enum TaskState {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/** Allowed task state transitions. A terminal state has no outgoing edges. */
export const VALID_TRANSITIONS: Record<TaskState, Set<TaskState>> = {
  [TaskState.PENDING]: new Set([TaskState.RUNNING, TaskState.SKIPPED, TaskState.FAILED]),
  [TaskState.RUNNING]: new Set([TaskState.RUNNING, TaskState.COMPLETED, TaskState.FAILED]),
  [TaskState.FAILED]: new Set([TaskState.RUNNING, TaskState.SKIPPED]),
  [TaskState.COMPLETED]: new Set(),
  [TaskState.SKIPPED]: new Set(),
};

/** A node in the orchestration DAG. */
export class Task {
  id: string;
  description: string;
  assignedTo: string | null = null;
  parentId: string | null = null;
  dependsOn: string[] = [];
  status: TaskState = TaskState.PENDING;
  priority: number = 0;
  result: string | null = null;
  metadata: Record<string, any> = {};

  constructor(config: {
    id: string;
    description: string;
    assignedTo?: string | null;
    parentId?: string | null;
    dependsOn?: string[];
    status?: TaskState;
    priority?: number;
    result?: string | null;
    metadata?: Record<string, any>;
  }) {
    this.id = config.id;
    this.description = config.description;
    this.assignedTo = config.assignedTo ?? null;
    this.parentId = config.parentId ?? null;
    this.dependsOn = config.dependsOn || [];
    this.status = config.status ?? TaskState.PENDING;
    this.priority = config.priority ?? 0;
    this.result = config.result ?? null;
    this.metadata = config.metadata || {};
  }

  transitionTo(newState: TaskState): void {
    const allowed = VALID_TRANSITIONS[this.status] || new Set();
    if (!allowed.has(newState)) {
      throw new Error(
        `Invalid task state transition: ${this.status} -> ${newState}`
      );
    }
    this.status = newState;
  }

  get allDeps(): string[] {
    const deps = [...this.dependsOn];
    if (this.parentId && !deps.includes(this.parentId)) {
      deps.push(this.parentId);
    }
    return deps;
  }
}

/** Result of executing a single task. */
export class TaskResult {
  success: boolean;
  content: string;
  data: Record<string, any> = {};
  /** True when the underlying LLM loop hit its round cap before finishing.
   *  The orchestrator retries on this (see factory.executeWithRetry). */
  truncated: boolean;

  constructor(success: boolean, content: string, data?: Record<string, any>, truncated: boolean = false) {
    this.success = success;
    this.content = content;
    this.data = data || {};
    this.truncated = truncated;
  }
}
