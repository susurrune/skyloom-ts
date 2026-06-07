/**
 * Tests for structured output schema validation.
 */
import { describe, it, expect } from 'vitest';
import { validateTaskPlan, TaskPlanSchema, parseSchema, SchemaValidationError } from '../src/core/schemas';

describe('validateTaskPlan', () => {
  it('parses valid JSON plan', () => {
    const data = JSON.parse('{"goal": "build app", "steps": [{"id": "1", "description": "design", "agent": "fog"}]}');
    const plan = validateTaskPlan(data);
    expect(plan.goal).toBe('build app');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].agent).toBe('fog');
  });

  it('passes through agent name', () => {
    const data = JSON.parse('{"goal": "x", "steps": [{"id": "1", "description": "a", "agent": "unknown"}]}');
    const plan = validateTaskPlan(data);
    // Schema-level validation just passes through; agent fallback is in SnowAgent
    expect(plan.steps[0].agent).toBe('unknown');
  });

  it('empty steps', () => {
    const data = JSON.parse('{"goal": "x", "steps": []}');
    const plan = validateTaskPlan(data);
    expect(plan.steps).toHaveLength(0);
  });

  it('parses depends_on', () => {
    const data = JSON.parse('{"goal": "x", "steps": [{"id": "1", "description": "a", "depends_on": ["0"]}]}');
    const plan = validateTaskPlan(data);
    expect(plan.steps[0].depends_on).toEqual(['0']);
  });

  it('default fields', () => {
    const data = JSON.parse('{"goal": "x", "steps": [{"id": "1", "description": "a"}]}');
    const plan = validateTaskPlan(data);
    expect(plan.steps[0].agent).toBe('rain');
    expect(plan.steps[0].depends_on).toEqual([]);
  });
});

describe('SchemaValidationError', () => {
  it('raises on empty', () => {
    expect(() => parseSchema('', TaskPlanSchema)).toThrow(SchemaValidationError);
  });

  it('raises on garbage', () => {
    expect(() => parseSchema('<html>garbage</html>', TaskPlanSchema)).toThrow(SchemaValidationError);
  });
});
