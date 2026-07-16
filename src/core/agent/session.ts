import type { Message } from '../memory';
import type { Tracer } from '../trace';

type StreamEvent = Record<string, unknown>;
type StreamFactory = (autoActivated?: string[]) => AsyncGenerator<StreamEvent>;

export interface AgentSessionControllerDeps {
  agentName: () => string;
  tracer: Tracer;
  getShortTerm: () => readonly Message[];
  autoActivateSkills: (message: string) => string[];
  popLastUserMessage: () => void;
}

/** Serializes turns and owns session selection plus per-turn trace lifetime. */
export class AgentSessionController {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AgentSessionControllerDeps) {}

  async withTurn<T>(run: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await run();
    } finally {
      release();
    }
  }

  async *runStream(
    message: string,
    stream: StreamFactory,
    selectSession?: () => Promise<void>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const release = await this.acquire();
    let turnStarted = false;

    try {
      if (signal?.aborted) {
        yield { type: 'interrupted' };
        yield { type: 'done' };
        return;
      }
      if (selectSession) await selectSession();
      if (signal?.aborted) {
        yield { type: 'interrupted' };
        yield { type: 'done' };
        return;
      }
      const activated = this.deps.autoActivateSkills(message);
      this.deps.tracer.startTrace(message.replace(/\s+/g, ' ').slice(0, 80), this.deps.agentName());
      turnStarted = true;
      yield* stream(activated.length > 0 ? activated : undefined);
    } catch (error) {
      if (turnStarted) {
        const shortTerm = this.deps.getShortTerm();
        if (shortTerm.length > 0 && shortTerm[shortTerm.length - 1].role === 'user') {
          this.deps.popLastUserMessage();
        }
      }
      throw error;
    } finally {
      if (turnStarted) this.deps.tracer.endTrace();
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    const previous = this.queue;
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    this.queue = previous.then(() => gate);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      unlock();
    };
  }
}
