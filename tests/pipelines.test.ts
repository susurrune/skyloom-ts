import { describe, it, expect } from "vitest";
import {
  matchPipeline,
  matchAllPipelines,
  buildTasksFromPipeline,
  listPipelines,
  getPipelineByName,
  validateDAG,
  topologicalSort,
  type Task,
} from "../src/core/pipelines";

function task(id: string, dependsOn: string[] = []): Task {
  return { id, description: id, assignedTo: "fog", parentId: dependsOn[0] ?? null, dependsOn };
}

describe("pipelines · matching", () => {
  it("matches a code-review goal to the code_review pipeline", () => {
    const p = matchPipeline("帮我审查代码");
    expect(p?.name).toBe("code_review");
  });

  it("matches an English review goal", () => {
    expect(matchPipeline("please review my code")?.name).toBe("code_review");
  });

  it("returns null for an unmatched / empty goal", () => {
    expect(matchPipeline("今天天气怎么样")).toBeNull();
    expect(matchPipeline("")).toBeNull();
  });

  it("matchAllPipelines returns an array (possibly empty)", () => {
    expect(Array.isArray(matchAllPipelines("审查代码"))).toBe(true);
    expect(matchAllPipelines("xyzzy nonsense")).toEqual([]);
  });
});

describe("pipelines · introspection", () => {
  it("lists pipelines with names, triggers and steps", () => {
    const list = listPipelines();
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(typeof p.name).toBe("string");
      expect(Array.isArray(p.triggers)).toBe(true);
      expect(Array.isArray(p.steps)).toBe(true);
    }
  });

  it("getPipelineByName round-trips a listed name; unknown → null", () => {
    const name = listPipelines()[0].name as string;
    expect(getPipelineByName(name)?.name).toBe(name);
    expect(getPipelineByName("___nope___")).toBeNull();
  });
});

describe("pipelines · materialization", () => {
  it("builds tasks from a pipeline, substituting {goal}", () => {
    const p = getPipelineByName("code_review")!;
    const tasks = buildTasksFromPipeline(p, "登录模块");
    expect(tasks.length).toBe(p.steps.length);
    expect(tasks[0].description).toContain("登录模块");
    expect(tasks[0].metadata?.goal).toBe("登录模块");
    expect(tasks[0].metadata?.pipeline).toBe("code_review");
  });

  it("a materialized pipeline is a valid DAG", () => {
    for (const meta of listPipelines()) {
      const p = getPipelineByName(meta.name as string)!;
      const tasks = buildTasksFromPipeline(p, "x");
      const v = validateDAG(tasks);
      expect(v.valid, `${meta.name}: ${v.errors.join("; ")}`).toBe(true);
    }
  });
});

describe("pipelines · validateDAG", () => {
  it("accepts a linear chain", () => {
    const v = validateDAG([task("1"), task("2", ["1"]), task("3", ["2"])]);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("flags a missing dependency", () => {
    const v = validateDAG([task("2", ["1"])]); // 1 doesn't exist
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/non-existent/);
  });

  it("detects a cycle", () => {
    const v = validateDAG([task("a", ["b"]), task("b", ["a"])]);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toMatch(/[Cc]ycle/);
  });
});

describe("pipelines · topologicalSort", () => {
  it("orders dependencies before dependents", () => {
    const sorted = topologicalSort([task("3", ["2"]), task("1"), task("2", ["1"])]);
    const order = sorted.map((t) => t.id);
    expect(order.indexOf("1")).toBeLessThan(order.indexOf("2"));
    expect(order.indexOf("2")).toBeLessThan(order.indexOf("3"));
  });

  it("handles independent tasks (all in-degree 0)", () => {
    const sorted = topologicalSort([task("a"), task("b"), task("c")]);
    expect(sorted.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("a diamond DAG keeps the root first and the join last", () => {
    // a → b, a → c, b → d, c → d
    const sorted = topologicalSort([
      task("d", ["b", "c"]), task("b", ["a"]), task("c", ["a"]), task("a"),
    ]);
    const order = sorted.map((t) => t.id);
    expect(order[0]).toBe("a");
    expect(order[order.length - 1]).toBe("d");
  });
});
