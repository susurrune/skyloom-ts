import { describe, it, expect } from "vitest";
import { engineeringProtocol } from "../src/core/protocol";

describe("protocol · engineeringProtocol", () => {
  it("zh protocol covers the senior-engineer discipline and names real tools", () => {
    const p = engineeringProtocol("zh");
    expect(p).toContain("工程标准");
    expect(p).toContain("根因");          // root-cause, not symptom
    expect(p).toContain("最小");          // minimal diffs
    expect(p).toContain("先理解");        // understand before changing
    expect(p).toContain("get_diagnostics"); // verify loop wired to real tool
    expect(p).toContain("code_search");
  });

  it("en protocol mirrors the zh one", () => {
    const p = engineeringProtocol("en");
    expect(p).toContain("Engineering Standard");
    expect(p).toContain("Root cause");
    expect(p).toContain("Minimal");
    expect(p).toContain("get_diagnostics");
    expect(p).toContain("code_search");
  });

  it("defaults to zh", () => {
    expect(engineeringProtocol()).toBe(engineeringProtocol("zh"));
  });
});
