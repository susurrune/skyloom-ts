/**
 * Tests for the event bus.
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageBus, Event, EventType } from '../src/core/bus';

describe('MessageBus', () => {
  it('subscribe and publish broadcasts to subscribers', async () => {
    const bus = new MessageBus();
    const received: Event[] = [];

    async function handler(event: Event) {
      received.push(event);
    }

    bus.subscribe('test_agent', handler);
    const event = new Event(EventType.SYSTEM_EVENT, 'system', null, { msg: 'hello' });
    await bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(EventType.SYSTEM_EVENT);
    expect(received[0].data).toEqual({ msg: 'hello' });
  });

  it('direct message goes to target agent only', async () => {
    const bus = new MessageBus();
    const received: Event[] = [];

    async function handler(event: Event) {
      received.push(event);
    }

    bus.subscribe('target_agent', handler);
    const event = new Event(EventType.TASK_ASSIGNED, 'snow', 'target_agent', { task: 'test' });
    await bus.publish(event);

    expect(received).toHaveLength(1);
  });

  it('unsubscribe removes handler', async () => {
    const bus = new MessageBus();
    const received: Event[] = [];

    async function handler(event: Event) {
      received.push(event);
    }

    bus.subscribe('agent', handler);
    bus.unsubscribe('agent');
    await bus.publish(new Event(EventType.SYSTEM_EVENT, 'system'));
    expect(received).toHaveLength(0);
  });

  it('state listener receives state change events', async () => {
    const bus = new MessageBus();
    const received: Event[] = [];

    async function listener(event: Event) {
      received.push(event);
    }

    bus.onStateChange(listener);
    await bus.notifyStateChange(
      new Event(EventType.STATE_CHANGE, 'fog', null, { old_state: 'idle', new_state: 'thinking' })
    );

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe(EventType.STATE_CHANGE);
    expect(received[0].source).toBe('fog');
  });

  it('state listener ignores non-state events', async () => {
    const bus = new MessageBus();
    const received: Event[] = [];

    async function listener(event: Event) {
      received.push(event);
    }

    bus.onStateChange(listener);
    await bus.notifyStateChange(new Event(EventType.TASK_ASSIGNED, 'snow'));
    expect(received).toHaveLength(0);
  });

  it('history tracks published events', async () => {
    const bus = new MessageBus();
    for (let i = 0; i < 5; i++) {
      await bus.publish(new Event(EventType.SYSTEM_EVENT, 'system'));
    }
    expect(bus.getHistory()).toHaveLength(5);
    expect(bus.getHistory(undefined, undefined, 2)).toHaveLength(2);
  });

  it('broadcast skips source agent', async () => {
    const bus = new MessageBus();
    const called: string[] = [];

    async function fogHandler(_event: Event) { called.push('fog'); }
    async function rainHandler(_event: Event) { called.push('rain'); }

    bus.subscribe('fog', fogHandler);
    bus.subscribe('rain', rainHandler);
    await bus.publish(new Event(EventType.SYSTEM_EVENT, 'fog'));

    expect(called).not.toContain('fog');
    expect(called).toContain('rain');
  });

  it('handler exception does not block other handlers', async () => {
    const bus = new MessageBus();
    const good: Event[] = [];

    async function failing(_event: Event) { throw new Error('failed'); }
    async function ok(event: Event) { good.push(event); }

    bus.subscribe('rain', failing);
    bus.subscribe('dew', ok);
    await bus.publish(new Event(EventType.SYSTEM_EVENT, 'fog'));
    expect(good).toHaveLength(1);
  });
});
