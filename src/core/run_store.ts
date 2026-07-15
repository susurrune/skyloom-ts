import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { USER_CONFIG_DIR } from './config';

export type RunStatus = 'planned' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type RunTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'interrupted';

export interface RunTaskRecord {
  id: string;
  description: string;
  agent: string;
  dependsOn: string[];
  status: RunTaskStatus;
  attempts: number;
  result: string | null;
  lastError: string | null;
  startedAt: string | null;
  endedAt: string | null;
  metadata: Record<string, unknown>;
  traceIds: string[];
}

export interface OrchestrationRun {
  schemaVersion: 1;
  runId: string;
  goal: string;
  status: RunStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  summary: string | null;
  tasks: RunTaskRecord[];
}

export interface AuditEvent {
  schemaVersion: 1;
  seq: number;
  eventId: string;
  runId: string;
  timestamp: string;
  type: string;
  taskId: string | null;
  payload: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

interface TaskLike {
  id: string;
  description: string;
  assignedTo?: string | null;
  assigned_to?: string | null;
  allDeps?: string[];
  dependsOn?: string[];
  depends_on?: string[];
  metadata?: Record<string, unknown>;
}

export class RunStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RunStoreError';
  }
}

export class OrchestrationRunStore {
  constructor(
    readonly rootDir = path.join(USER_CONFIG_DIR, 'runs'),
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(goal: string, tasks: TaskLike[], requestedId?: string): OrchestrationRun {
    const ids = tasks.map(task => String(task.id));
    if (new Set(ids).size !== ids.length) throw new RunStoreError('run.duplicate_task', 'Task ids must be unique');
    const runId = requestedId || randomUUID();
    if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new RunStoreError('run.invalid_id', 'Invalid run id');
    if (fs.existsSync(this.snapshotPath(runId))) throw new RunStoreError('run.exists', `Run '${runId}' already exists`);
    const timestamp = this.now().toISOString();
    const run: OrchestrationRun = {
      schemaVersion: 1,
      runId,
      goal,
      status: 'planned',
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      endedAt: null,
      summary: null,
      tasks: tasks.map(task => ({
        id: String(task.id),
        description: String(task.description || ''),
        agent: String(task.assignedTo ?? task.assigned_to ?? ''),
        dependsOn: Array.from(task.allDeps ?? task.dependsOn ?? task.depends_on ?? []),
        status: 'pending',
        attempts: 0,
        result: null,
        lastError: null,
        startedAt: null,
        endedAt: null,
        metadata: { ...(task.metadata || {}) },
        traceIds: [],
      })),
    };
    this.commit(run, 'run.created', null, { run: this.clone(run) });
    return run;
  }

  load(runId: string): OrchestrationRun {
    const file = this.snapshotPath(runId);
    const events = this.events(runId);
    this.verifyEvents(runId, events);
    let run: OrchestrationRun | null = null;
    let snapshotRevision = -1;
    try {
      run = this.validate(JSON.parse(fs.readFileSync(file, 'utf8')), runId);
      snapshotRevision = run.revision;
    } catch (error) {
      if (fs.existsSync(file)) {
        throw new RunStoreError('run.unreadable', `Unable to read run '${runId}': ${String(error)}`);
      }
    }
    if (!run) {
      const created = events[0]?.payload.run;
      if (!created) throw new RunStoreError('run.unreadable', `Unable to reconstruct run '${runId}'`);
      run = this.validate(created, runId);
    }
    if (run.revision > events.length) {
      throw new RunStoreError('run.audit_corrupt', `Snapshot for run '${runId}' is ahead of its audit chain`);
    }
    for (const event of events) {
      if (event.seq > run.revision) this.replay(run, event);
    }
    if (run.revision !== events.length) {
      throw new RunStoreError('run.audit_corrupt', `Audit chain for run '${runId}' is incomplete`);
    }
    if (snapshotRevision < run.revision) {
      this.writeSnapshot(run);
    }
    return run;
  }

  latestRecoverable(goal?: string): OrchestrationRun | null {
    const runs = this.list().filter(run => run.status !== 'completed' && (!goal || run.goal === goal));
    return runs[0] || null;
  }

  list(limit = 50): OrchestrationRun[] {
    if (!fs.existsSync(this.rootDir)) return [];
    const runs: OrchestrationRun[] = [];
    for (const entry of fs.readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const run = this.load(entry.name);
        runs.push(run);
      } catch { /* corrupted runs remain inspectable on disk but are never resumed */ }
    }
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.max(0, limit));
  }

  start(run: OrchestrationRun): void {
    const interruptedTaskIds: string[] = [];
    for (const task of run.tasks) {
      if (task.status === 'running') {
        task.status = 'interrupted';
        interruptedTaskIds.push(task.id);
      }
    }
    run.status = 'running';
    this.commit(run, 'run.started', null, { status: run.status, interruptedTaskIds });
  }

  taskStarted(run: OrchestrationRun, taskId: string): void {
    const task = this.task(run, taskId);
    task.status = 'running';
    task.attempts++;
    task.startedAt = this.now().toISOString();
    task.endedAt = null;
    task.lastError = null;
    this.commit(run, 'task.started', taskId, { task: this.clone(task) });
  }

  appendTasks(run: OrchestrationRun, tasks: TaskLike[]): void {
    const existing = new Set(run.tasks.map(task => task.id));
    const addedTasks: RunTaskRecord[] = [];
    for (const task of tasks) {
      const id = String(task.id);
      if (existing.has(id)) throw new RunStoreError('run.duplicate_task', `Task '${id}' already exists`);
      existing.add(id);
      const record: RunTaskRecord = {
        id,
        description: String(task.description || ''),
        agent: String(task.assignedTo ?? task.assigned_to ?? ''),
        dependsOn: Array.from(task.allDeps ?? task.dependsOn ?? task.depends_on ?? []),
        status: 'pending', attempts: 0, result: null, lastError: null,
        startedAt: null, endedAt: null, metadata: { ...(task.metadata || {}) }, traceIds: [],
      };
      run.tasks.push(record);
      addedTasks.push(record);
    }
    this.commit(run, 'run.replanned', null, { tasks: this.clone(addedTasks) });
  }

  taskFinished(run: OrchestrationRun, taskId: string, success: boolean, content: string, traceId?: string | null): void {
    const task = this.task(run, taskId);
    task.status = success ? 'completed' : content.startsWith('[dependency missing]') ? 'blocked' : 'failed';
    task.result = content;
    task.lastError = success ? null : content.slice(0, 1000);
    task.endedAt = this.now().toISOString();
    if (traceId && !task.traceIds.includes(traceId)) task.traceIds.push(traceId);
    this.commit(run, success ? 'task.completed' : task.status === 'blocked' ? 'task.blocked' : 'task.failed', taskId, {
      task: this.clone(task),
    });
  }

  finish(run: OrchestrationRun, summary: string): void {
    run.summary = summary;
    run.status = run.tasks.every(task => task.status === 'completed') ? 'completed' : 'failed';
    run.endedAt = this.now().toISOString();
    this.commit(run, run.status === 'completed' ? 'run.completed' : 'run.failed', null, {
      status: run.status,
      summary: run.summary,
      endedAt: run.endedAt,
    });
  }

  cancel(run: OrchestrationRun, summary: string): void {
    run.summary = summary;
    run.status = 'cancelled';
    run.endedAt = this.now().toISOString();
    this.commit(run, 'run.cancelled', null, { status: run.status, summary: run.summary, endedAt: run.endedAt });
  }

  events(runId: string): AuditEvent[] {
    const file = this.eventsPath(runId);
    if (!fs.existsSync(file)) return [];
    try {
      const content = fs.readFileSync(file, 'utf8');
      const hasTerminatedTail = /\r?\n$/.test(content);
      const lines = content.split(/\r?\n/);
      const events: AuditEvent[] = [];
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as AuditEvent);
        } catch (error) {
          const isCrashTruncatedTail = index === lines.length - 1 && !hasTerminatedTail;
          if (!isCrashTruncatedTail) throw error;
        }
      }
      return events;
    } catch (error) {
      throw new RunStoreError('run.audit_unreadable', `Unable to read audit chain for run '${runId}': ${String(error)}`);
    }
  }

  acquireLease(runId: string): () => void {
    const dir = this.runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const lease = path.join(dir, 'lease');
    let fd!: number;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fd = fs.openSync(lease, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: this.now().toISOString() }), 'utf8');
        break;
      } catch (error) {
        const occupied = (error as NodeJS.ErrnoException).code === 'EEXIST';
        if (attempt === 0 && occupied && this.isStaleLease(lease)) {
          try { fs.unlinkSync(lease); } catch { /* another process won recovery */ }
          continue;
        }
        throw new RunStoreError('run.locked', `Run '${runId}' is already active: ${String(error)}`);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lease); } catch { /* best effort */ }
    };
  }

  private isStaleLease(lease: string): boolean {
    try {
      const payload = JSON.parse(fs.readFileSync(lease, 'utf8')) as { pid?: unknown };
      const pid = Number(payload.pid);
      if (!Number.isInteger(pid) || pid <= 0) return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } catch {
      return true;
    }
  }

  private commit(run: OrchestrationRun, type: string, taskId: string | null = null, payload: Record<string, unknown> = {}): void {
    fs.mkdirSync(this.runDir(run.runId), { recursive: true });
    run.revision++;
    run.updatedAt = this.now().toISOString();
    const previous = this.events(run.runId).at(-1);
    const eventBase = {
      schemaVersion: 1 as const,
      seq: (previous?.seq || 0) + 1,
      eventId: randomUUID(),
      runId: run.runId,
      timestamp: run.updatedAt,
      type,
      taskId,
      payload,
      previousHash: previous?.hash || '',
    };
    const hash = createHash('sha256').update(JSON.stringify(eventBase)).digest('hex');
    const event: AuditEvent = { ...eventBase, hash };
    const eventsFile = this.eventsPath(run.runId);
    const eventFd = fs.openSync(eventsFile, 'a', 0o600);
    try {
      fs.writeFileSync(eventFd, `${JSON.stringify(event)}\n`, 'utf8');
      fs.fsyncSync(eventFd);
    } finally {
      fs.closeSync(eventFd);
    }
    this.writeSnapshot(run);
    const target = this.snapshotPath(run.runId);
    try {
      fs.chmodSync(this.runDir(run.runId), 0o700);
      fs.chmodSync(this.eventsPath(run.runId), 0o600);
      fs.chmodSync(target, 0o600);
    } catch { /* Windows and restricted filesystems may not expose POSIX modes */ }
  }

  private verifyEvents(runId: string, events = this.events(runId)): void {
    let previousHash = '';
    let expectedSeq = 1;
    for (const event of events) {
      const { hash, ...base } = event;
      const expectedHash = createHash('sha256').update(JSON.stringify(base)).digest('hex');
      if (event.seq !== expectedSeq || event.previousHash !== previousHash || hash !== expectedHash) {
        throw new RunStoreError('run.audit_corrupt', `Audit chain for run '${runId}' is invalid`);
      }
      expectedSeq++;
      previousHash = hash;
    }
  }

  private replay(run: OrchestrationRun, event: AuditEvent): void {
    if (event.type === 'run.created') {
      const created = this.validate(event.payload.run, run.runId);
      Object.assign(run, this.clone(created));
    } else if (event.type === 'run.started') {
      run.status = 'running';
      const interrupted = new Set((event.payload.interruptedTaskIds as string[] | undefined) || []);
      for (const task of run.tasks) if (interrupted.has(task.id)) task.status = 'interrupted';
    } else if (event.type === 'run.replanned') {
      const tasks = (event.payload.tasks as RunTaskRecord[] | undefined) || [];
      run.tasks.push(...this.clone(tasks));
    } else if (event.taskId && event.payload.task) {
      const index = run.tasks.findIndex(task => task.id === event.taskId);
      if (index < 0) throw new RunStoreError('run.task_missing', `Task '${event.taskId}' is missing from run '${run.runId}'`);
      run.tasks[index] = this.clone(event.payload.task as RunTaskRecord);
    } else if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      run.status = event.payload.status as RunStatus;
      run.summary = (event.payload.summary as string | null) ?? null;
      run.endedAt = (event.payload.endedAt as string | null) ?? null;
    }
    run.revision = event.seq;
    run.updatedAt = event.timestamp;
  }

  private writeSnapshot(run: OrchestrationRun): void {
    const target = this.snapshotPath(run.runId);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(run, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, target);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private validate(value: unknown, runId: string): OrchestrationRun {
    if (!value || typeof value !== 'object') throw new RunStoreError('run.invalid', `Run '${runId}' is invalid`);
    const run = value as OrchestrationRun;
    if (run.schemaVersion !== 1 || run.runId !== runId || !Array.isArray(run.tasks)) {
      throw new RunStoreError('run.schema', `Run '${runId}' has an unsupported schema`);
    }
    return run;
  }

  private task(run: OrchestrationRun, taskId: string): RunTaskRecord {
    const task = run.tasks.find(item => item.id === taskId);
    if (!task) throw new RunStoreError('run.task_missing', `Task '${taskId}' is missing from run '${run.runId}'`);
    return task;
  }

  private runDir(runId: string): string { return path.join(this.rootDir, runId); }
  private snapshotPath(runId: string): string { return path.join(this.runDir(runId), 'run.json'); }
  private eventsPath(runId: string): string { return path.join(this.runDir(runId), 'events.jsonl'); }
}
