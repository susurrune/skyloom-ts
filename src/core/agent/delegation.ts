import { Event, EventType, type MessageBus } from '../bus';
import { Task, type TaskResult } from './task';

interface PendingRequest {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export interface DelegationCoordinatorDeps {
  agentName: () => string;
  bus: MessageBus;
  executeTask: (task: Task) => Promise<TaskResult>;
}

/** Owns cross-agent request correlation, timeout cleanup, and inbound task lifetime. */
export class DelegationCoordinator {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly backgroundTasks = new Set<Promise<void>>();

  constructor(private readonly deps: DelegationCoordinatorDeps) {}

  async requestHelp(targetAgent: string, description: string, timeoutSeconds = 60): Promise<string> {
    const correlationId = Math.random().toString(36).slice(2, 14);
    const response = new Promise<string>((resolve, reject) => {
      this.pendingRequests.set(correlationId, { resolve, reject });
    });
    const timeoutHandle = setTimeout(() => {
      const pending = this.pendingRequests.get(correlationId);
      this.pendingRequests.delete(correlationId);
      pending?.reject(new Error(`Timeout after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    try {
      await this.deps.bus.publish(new Event(
        EventType.AGENT_REQUEST,
        this.deps.agentName(),
        targetAgent,
        { correlation_id: correlationId, description, source: this.deps.agentName() },
      ));
      return await response;
    } catch {
      return `[${targetAgent} did not respond within ${timeoutSeconds}s]`;
    } finally {
      clearTimeout(timeoutHandle);
      this.pendingRequests.delete(correlationId);
    }
  }

  handleEvent(event: Event): boolean {
    const agentName = this.deps.agentName();
    if (event.type === EventType.AGENT_REQUEST && event.target === agentName) {
      this.track(this.handleRequest(event));
      return true;
    }
    if (event.type === EventType.AGENT_RESPONSE && event.target === agentName) {
      this.handleResponse(event);
      return true;
    }
    return false;
  }

  async drain(): Promise<void> {
    if (this.backgroundTasks.size > 0) {
      await Promise.allSettled([...this.backgroundTasks]);
    }
  }

  private track(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    task.finally(() => this.backgroundTasks.delete(task)).catch(() => undefined);
  }

  private async handleRequest(event: Event): Promise<void> {
    const description = String(event.data?.description || '');
    const correlationId = String(event.data?.correlation_id || '');
    const source = String(event.data?.source || event.source || '');
    if (!correlationId) return;

    const task = new Task({
      id: `req-${correlationId.slice(0, 8)}`,
      description,
      assignedTo: this.deps.agentName(),
    });

    try {
      const result = await this.deps.executeTask(task);
      await this.publishResponse(source, correlationId, result.content, result.success);
    } catch (error) {
      await this.publishResponse(source, correlationId, `[error] ${error}`, false);
    }
  }

  private handleResponse(event: Event): void {
    const correlationId = String(event.data?.correlation_id || '');
    if (!correlationId) return;
    const pending = this.pendingRequests.get(correlationId);
    if (!pending) return;
    this.pendingRequests.delete(correlationId);
    pending.resolve(String(event.data?.content || ''));
  }

  private async publishResponse(target: string, correlationId: string, content: string, success: boolean): Promise<void> {
    await this.deps.bus.publish(new Event(
      EventType.AGENT_RESPONSE,
      this.deps.agentName(),
      target,
      { correlation_id: correlationId, content, success },
    ));
  }
}
