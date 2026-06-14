import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { unifiedDiff, countOccurrences } from "../src/core/diff";
import { ToolRegistry } from "../src/core/tool";
import { registerBuiltinTools } from "../src/tools/builtin";

describe("diff · unifiedDiff", () => {
  it("returns empty for identical input", () => {
    const d = unifiedDiff("a\nb\nc", "a\nb\nc");
    expect(d.text).toBe("");
    expect(d.stat).toEqual({ added: 0, removed: 0 });
  });

  it("shows a single changed line with context and a +/- stat", () => {
    const d = unifiedDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
    expect(d.stat).toEqual({ added: 1, removed: 1 });
    expect(d.text).toContain("-c");
    expect(d.text).toContain("+X");
    expect(d.text).toContain(" b"); // context line
    expect(d.text).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it("counts added and removed lines for multi-line changes", () => {
    const d = unifiedDiff("x\n1\n2\ny", "x\n1\n2\n3\ny");
    expect(d.stat.added).toBe(1);
    expect(d.stat.removed).toBe(0);
  });
});

describe("diff · countOccurrences", () => {
  it("counts non-overlapping occurrences", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abcabc", "abc")).toBe(2);
    expect(countOccurrences("abc", "z")).toBe(0);
    expect(countOccurrences("abc", "")).toBe(0);
  });
});

describe("edit_file · Claude Code-style semantics", () => {
  let dir: string;
  let edit: any;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-edit-"));
    const reg = new ToolRegistry();
    registerBuiltinTools(reg);
    edit = reg.get("edit_file")!.handler!;
  });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function write(name: string, content: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("replaces a unique match and returns a diff", async () => {
    const p = write("a.txt", "line1\nfoo\nline3\n");
    const out = await edit({ path: p, old_text: "foo", new_text: "bar" });
    expect(out).toContain("Successfully edited");
    expect(out).toContain("-foo");
    expect(out).toContain("+bar");
    expect(fs.readFileSync(p, "utf8")).toBe("line1\nbar\nline3\n");
  });

  it("refuses an ambiguous edit when old_text is not unique", async () => {
    const p = write("b.txt", "x\nx\n");
    const out = await edit({ path: p, old_text: "x", new_text: "y" });
    expect(out).toContain("appears 2 times");
    expect(out).toContain("replace_all");
    // file unchanged
    expect(fs.readFileSync(p, "utf8")).toBe("x\nx\n");
  });

  it("replace_all changes every occurrence", async () => {
    const p = write("c.txt", "x\nx\nx\n");
    const out = await edit({ path: p, old_text: "x", new_text: "y", replace_all: true });
    expect(out).toContain("3 occurrences");
    expect(fs.readFileSync(p, "utf8")).toBe("y\ny\ny\n");
  });

  it("errors when old_text is missing from the file", async () => {
    const p = write("d.txt", "hello\n");
    const out = await edit({ path: p, old_text: "nope", new_text: "x" });
    expect(out).toContain("not found");
    expect(fs.readFileSync(p, "utf8")).toBe("hello\n");
  });

  it("rejects a no-op edit (old_text === new_text)", async () => {
    const p = write("e.txt", "same\n");
    const out = await edit({ path: p, old_text: "same", new_text: "same" });
    expect(out).toContain("identical");
  });

  it("treats $-patterns in new_text literally (no String.replace interpretation)", async () => {
    const p = write("f.txt", "value = OLD\n");
    const out = await edit({ path: p, old_text: "OLD", new_text: "$1$&dollar" });
    expect(out).toContain("Successfully edited");
    expect(fs.readFileSync(p, "utf8")).toBe("value = $1$&dollar\n");
  });
});
