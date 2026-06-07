/**
 * Async event-driven message bus for inter-agent communication.
 */

import { EventEmitter } from 'events';

/**
 * Event types for the message bus.
 */
export enum EventType {
  TASK_ASSIGNED = 'task_assigned',
  TASK_COMPLETED = 'task_completed',
  TASK_FEEDBACK = 'task_feedback',
  AGENT_REQUEST = 'agent_request',
  AGENT_RESPONSE = 'agent_response',
  SYSTEM_EVENT = 'system_event',
  STATE_CHANGE = 'state_change', // agent state changes
  LLM_CALL = 'llm_call', // LLM request made
  TOOL_CALL = 'tool_call', // tool was called
}

/**
 * Event object for message bus.
 */
export class Event {
  type: EventType;
  source: string; // agent name or "system"
  target: string | null; // null = broadcast
  data: Record<string, any>;
  timestamp: Date;

  constructor(
    type: EventType,
    source: string,
    target?: string | null,
    data?: Record<string, any>
  ) {
    this.type = type;
    this.source = source;
    this.target = target || null;
    this.data = data || {};
    this.timestamp = new Date();
  }

  /**
   * Convert event to JSON-serializable format.
   */
  toJSON(): Record<string, any> {
    return {
      type: this.type,
      source: this.source,
      target: this.target,
      data: this.data,
      timestamp: this.timestamp.toISOString(),
    };
  }
}

/**
 * Handler function for events.
 */
export type Handler = (event: Event) => Promise<void>;

/**
 * Pub/sub message bus for agent communication.
 */
export class MessageBus {
  private subscribers: Map<string, Handler[]> = new Map();
  private stateListeners: Handler[] = [];
  private history: Event[] = [];
  private maxHistory: number = 2000;

  /**
   * Subscribe an agent to events.
   */
  subscribe(agentName: string, handler: Handler): void {
    if (!this.subscribers.has(agentName)) {
      this.subscribers.set(agentName, []);
    }
    this.subscribers.get(agentName)!.push(handler);
  }

  /**
   * Unsubscribe an agent.
   */
  unsubscribe(agentName: string): void {
    this.subscribers.delete(agentName);
  }

  /**
   * Register a global handler for state change events.
   */
  onStateChange(handler: Handler): void {
    this.stateListeners.push(handler);
  }

  /**
   * Remove a state change listener.
   */
  removeStateListener(handler: Handler): void {
    const idx = this.stateListeners.indexOf(handler);
    if (idx >= 0) {
      this.stateListeners.splice(idx, 1);
    }
  }

  /**
   * Trim history to max size.
   */
  private trimHistory(): void {
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(this.history.length - this.maxHistory);
    }
  }

  /**
   * Record event without routing (for state changes / local observation).
   */
  addEvent(event: Event): void {
    this.history.push(event);
    this.trimHistory();
  }

  /**
   * Notify state change listeners.
   */
  async notifyStateChange(event: Event): Promise<void> {
    if (event.type !== EventType.STATE_CHANGE) {
      return;
    }

    for (const handler of this.stateListeners) {
      try {
        await handler(event);
      } catch (err) {
        console.error('state_change handler failed:', err);
      }
    }
  }

  /**
   * Publish an event to subscribers.
   */
  async publish(event: Event): Promise<void> {
    this.history.push(event);
    this.trimHistory();

    if (event.target) {
      // Direct message
      const handlers = this.subscribers.get(event.target) || [];
      for (const handler of handlers) {
        try {
          await handler(event);
        } catch (err) {
          console.error(`bus handler failed for target=${event.target}:`, err);
        }
      }
    } else {
      // Broadcast to all except source
      for (const [name, handlers] of this.subscribers.entries()) {
        if (name === event.source) {
          continue;
        }
        for (const handler of handlers) {
          try {
            await handler(event);
          } catch (err) {
            console.error(`bus handler failed for subscriber=${name}:`, err);
          }
        }
      }
    }
  }

  /**
   * Get event history.
   */
  getHistory(
    agentName?: string | null,
    eventType?: EventType | null,
    limit: number = 50
  ): Event[] {
    let events = this.history;

    if (agentName) {
      events = events.filter(e => e.source === agentName || e.target === agentName);
    }

    if (eventType) {
      events = events.filter(e => e.type === eventType);
    }

    return events.slice(Math.max(0, events.length - limit));
  }

  /**
   * Clear all history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Get event count.
   */
  getEventCount(): number {
    return this.history.length;
  }

  /**
   * Get active subscriber count.
   */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }
}

/**
 * Global event emitter (optional, for direct event emission).
 */
export const eventEmitter = new EventEmitter();
