import { describe, it, expect } from "vitest";
import { Task, TaskState, TaskResult, VALID_TRANSITIONS } from "../src/core/agent/task";
// Also assert the re-export path stays stable for external importers.
import { Task as TaskViaAgent, TaskState as TaskStateViaAgent } from "../src/core/agent";

describe("Task domain model", () => {
  it("applies sensible defaults", () => {
    const t = new Task({ id: "1", description: "do a thing" });
    expect(t.status).toBe(TaskState.PENDING);
    expect(t.assignedTo).toBeNull();
    expect(t.dependsOn).toEqual([]);
    expect(t.priority).toBe(0);
  });

  it("allows PENDING -> RUNNING -> COMPLETED", () => {
    const t = new Task({ id: "1", description: "x" });
    t.transitionTo(TaskState.RUNNING);
    expect(t.status).toBe(TaskState.RUNNING);
    t.transitionTo(TaskState.COMPLETED);
    expect(t.status).toBe(TaskState.COMPLETED);
  });

  it("rejects illegal transitions", () => {
    const t = new Task({ id: "1", description: "x" });
    // PENDING -> COMPLETED is not allowed (must go through RUNNING)
    expect(() => t.transitionTo(TaskState.COMPLETED)).toThrow(/Invalid task state transition/);
  });

  it("treats COMPLETED as terminal", () => {
    expect(VALID_TRANSITIONS[TaskState.COMPLETED].size).toBe(0);
    expect(VALID_TRANSITIONS[TaskState.SKIPPED].size).toBe(0);
  });

  it("allows FAILED -> RUNNING (retry) and FAILED -> SKIPPED", () => {
    const t = new Task({ id: "1", description: "x", status: TaskState.FAILED });
    expect(() => t.transitionTo(TaskState.RUNNING)).not.toThrow();
    const t2 = new Task({ id: "2", description: "y", status: TaskState.FAILED });
    expect(() => t2.transitionTo(TaskState.SKIPPED)).not.toThrow();
  });

  it("allDeps merges parentId with dependsOn without duplicates", () => {
    const t = new Task({ id: "3", description: "z", parentId: "1", dependsOn: ["1", "2"] });
    expect(t.allDeps.sort()).toEqual(["1", "2"]);
    const t2 = new Task({ id: "4", description: "z", parentId: "9", dependsOn: ["2"] });
    expect(t2.allDeps.sort()).toEqual(["2", "9"]);
  });

  it("TaskResult carries success/content/data", () => {
    const ok = new TaskResult(true, "done", { x: 1 });
    expect(ok.success).toBe(true);
    expect(ok.content).toBe("done");
    expect(ok.data).toEqual({ x: 1 });
    expect(new TaskResult(false, "oops").data).toEqual({});
  });

  it("re-export from ../core/agent stays identical", () => {
    expect(TaskViaAgent).toBe(Task);
    expect(TaskStateViaAgent).toBe(TaskState);
  });
});
