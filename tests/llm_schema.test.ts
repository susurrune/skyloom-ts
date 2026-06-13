import { describe, it, expect } from "vitest";
import { LLMClient } from "../src/core/llm";
import { ToolRegistry } from "../src/core/tool";

/**
 * Tool param schemas are rebuilt on every LLM call. paramsToSchema memoizes by
 * the (stable) parameters-array reference so a multi-round tool loop doesn't
 * re-derive identical schemas each round. These lock in both the memoization
 * and the unchanged schema shape.
 */
function makeClient(): any {
  return new LLMClient({} as any, new ToolRegistry());
}

describe("LLMClient.paramsToSchema", () => {
  it("maps parameter types and required list correctly", () => {
    const c = makeClient();
    const schema = c.paramsToSchema([
      { name: "path", type: "string", description: "file path", required: true },
      { name: "n", type: "number", description: "count" },
      { name: "deep", type: "boolean", description: "recurse" },
    ]);
    expect(schema).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        n: { type: "number", description: "count" },
        deep: { type: "boolean", description: "recurse" },
      },
      required: ["path"],
    });
  });

  it("returns the same cached object for the same params reference", () => {
    const c = makeClient();
    const params = [{ name: "q", type: "string", description: "query", required: true }];
    const first = c.paramsToSchema(params);
    const second = c.paramsToSchema(params);
    expect(second).toBe(first); // memoized — identical reference, not just deep-equal
  });

  it("treats undefined and empty params as a no-property object schema", () => {
    const c = makeClient();
    const a = c.paramsToSchema(undefined);
    const b = c.paramsToSchema([]);
    expect(a).toEqual({ type: "object", properties: {} });
    expect(a.required).toBeUndefined();
    expect(b).toBe(a); // shared empty schema
  });
});
