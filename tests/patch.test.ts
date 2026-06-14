import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parsePatch, applyPatch } from "../src/core/patch";

describe("patch · parsePatch", () => {
  it("parses update / add / delete operations", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "<<<<<<< SEARCH",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> REPLACE",
      "*** Add File: b.ts",
      "export const y = 3;",
      "*** Delete File: c.ts",
      "*** End Patch",
    ].join("\n");
    const r = parsePatch(text) as any;
    expect(r.error).toBeUndefined();
    expect(r.ops).toHaveLength(3);
    expect(r.ops[0]).toMatchObject({ op: "update", path: "a.ts" });
    expect(r.ops[0].blocks[0]).toEqual({ search: "const x = 1;", replace: "const x = 2;" });
    expect(r.ops[1]).toMatchObject({ op: "add", path: "b.ts", content: "export const y = 3;\n" });
    expect(r.ops[2]).toMatchObject({ op: "delete", path: "c.ts" });
  });

  it("errors on an unterminated SEARCH", () => {
    const text = "*** Update File: a.ts\n<<<<<<< SEARCH\nfoo\n";
    expect((parsePatch(text) as any).error).toContain("Unterminated SEARCH");
  });

  it("errors on stray content outside a file section", () => {
    expect((parsePatch("hello world") as any).error).toContain("Unexpected line");
  });
});

describe("patch · applyPatch (atomic, multi-file)", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-patch-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function write(name: string, content: string) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const read = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");

  it("applies update + add + delete in one shot", () => {
    write("a.ts", "const x = 1;\nkeep me\n");
    write("c.ts", "delete me\n");
    const patch = [
      "*** Update File: a.ts",
      "<<<<<<< SEARCH",
      "const x = 1;",
      "=======",
      "const x = 42;",
      ">>>>>>> REPLACE",
      "*** Add File: sub/b.ts",
      "export const y = 3;",
      "*** Delete File: c.ts",
    ].join("\n");
    const out = applyPatch(patch, { cwd: dir });
    expect(out).toContain("Applied patch");
    expect(read("a.ts")).toBe("const x = 42;\nkeep me\n");
    expect(read("sub/b.ts")).toBe("export const y = 3;\n");
    expect(fs.existsSync(path.join(dir, "c.ts"))).toBe(false);
  });

  it("applies multiple blocks to one file", () => {
    write("m.ts", "alpha\nbeta\ngamma\n");
    const patch = [
      "*** Update File: m.ts",
      "<<<<<<< SEARCH", "alpha", "=======", "ALPHA", ">>>>>>> REPLACE",
      "<<<<<<< SEARCH", "gamma", "=======", "GAMMA", ">>>>>>> REPLACE",
    ].join("\n");
    applyPatch(patch, { cwd: dir });
    expect(read("m.ts")).toBe("ALPHA\nbeta\nGAMMA\n");
  });

  it("is atomic: a failing block leaves ALL files untouched", () => {
    write("a.ts", "good\n");
    write("b.ts", "target\n");
    const patch = [
      "*** Update File: a.ts",
      "<<<<<<< SEARCH", "good", "=======", "changed", ">>>>>>> REPLACE",
      "*** Update File: b.ts",
      "<<<<<<< SEARCH", "NOT THERE", "=======", "x", ">>>>>>> REPLACE",
    ].join("\n");
    const out = applyPatch(patch, { cwd: dir });
    expect(out).toContain("SEARCH block not found");
    expect(read("a.ts")).toBe("good\n");   // first file NOT written
    expect(read("b.ts")).toBe("target\n");
  });

  it("rejects an ambiguous SEARCH block", () => {
    write("d.ts", "dup\ndup\n");
    const patch = ["*** Update File: d.ts", "<<<<<<< SEARCH", "dup", "=======", "x", ">>>>>>> REPLACE"].join("\n");
    expect(applyPatch(patch, { cwd: dir })).toContain("ambiguous");
  });

  it("refuses to Add over an existing file", () => {
    write("exists.ts", "already\n");
    const patch = "*** Add File: exists.ts\nnew content\n";
    const out = applyPatch(patch, { cwd: dir });
    expect(out).toContain("already exists");
    expect(read("exists.ts")).toBe("already\n");
  });

  it("treats $-patterns in replacement literally", () => {
    write("e.ts", "VAL\n");
    const patch = ["*** Update File: e.ts", "<<<<<<< SEARCH", "VAL", "=======", "$1$&x", ">>>>>>> REPLACE"].join("\n");
    applyPatch(patch, { cwd: dir });
    expect(read("e.ts")).toBe("$1$&x\n");
  });

  it("honors the fence check by aborting", () => {
    write("a.ts", "good\n");
    const patch = ["*** Update File: a.ts", "<<<<<<< SEARCH", "good", "=======", "bad", ">>>>>>> REPLACE"].join("\n");
    const out = applyPatch(patch, { cwd: dir, fenceCheck: () => "路径越界" });
    expect(out).toContain("路径越界");
    expect(read("a.ts")).toBe("good\n");
  });
});
