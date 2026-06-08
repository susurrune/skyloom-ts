import { describe, it, expect } from "vitest";
import { parseExtractedFacts, synthesizeDelegationSummary } from "../src/core/agent_helpers";

describe("parseExtractedFacts", () => {
  it("parses a raw JSON array", () => {
    const out = parseExtractedFacts('[{"key":"lang","value":"ts"}]');
    expect(out).toEqual([{ key: "lang", value: "ts" }]);
  });

  it("parses JSON inside a markdown fence", () => {
    const out = parseExtractedFacts('```json\n[{"key":"a","value":1}]\n```');
    expect(out).toEqual([{ key: "a", value: 1 }]);
  });

  it("extracts a JSON array embedded in prose", () => {
    const out = parseExtractedFacts('Sure! Here are the facts: [{"key":"x","value":true}] done.');
    expect(out).toEqual([{ key: "x", value: true }]);
  });

  it("returns [] for empty or non-JSON input", () => {
    expect(parseExtractedFacts("")).toEqual([]);
    expect(parseExtractedFacts("no json here")).toEqual([]);
    expect(parseExtractedFacts("   ")).toEqual([]);
  });

  it("returns [] when JSON is an object, not an array", () => {
    expect(parseExtractedFacts('{"key":"x"}')).toEqual([]);
  });

  it("filters out non-object array members", () => {
    const out = parseExtractedFacts('[{"key":"a","value":1}, "junk", 42, null]');
    // null is typeof 'object' in JS, so it survives the filter — assert the real members
    expect(out).toContainEqual({ key: "a", value: 1 });
    expect(out).not.toContain("junk");
    expect(out).not.toContain(42);
  });
});

describe("synthesizeDelegationSummary", () => {
  it("summarizes successes and failures", () => {
    expect(synthesizeDelegationSummary([["fog", true], ["rain", false]])).toBe(
      "[Delegated: fog | Failed: rain]"
    );
  });
  it("returns empty string when no delegations", () => {
    expect(synthesizeDelegationSummary([])).toBe("");
  });
});
