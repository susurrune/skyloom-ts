import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { searchCode, formatSearchResult } from "../src/core/search";

describe("search · searchCode (pure JS)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sky-search-"));
    fs.writeFileSync(path.join(root, "a.ts"), "const Foo = 1;\nexport function useFoo() { return Foo; }\n");
    fs.writeFileSync(path.join(root, "b.js"), "// foo lower\nconst x = 2;\n");
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "c.ts"), "import { useFoo } from '../a';\n");
    // should be ignored by default
    fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "dep", "x.ts"), "const Foo = 999;\n");
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

  it("finds matches with file:line", () => {
    const res = searchCode({ pattern: "useFoo", root });
    const files = res.matches.map((m) => m.file).sort();
    expect(files).toContain("a.ts");
    expect(files).toContain("sub/c.ts");
    const a = res.matches.find((m) => m.file === "a.ts")!;
    expect(a.line).toBe(2);
    expect(a.text).toContain("useFoo");
  });

  it("skips node_modules by default", () => {
    const res = searchCode({ pattern: "Foo", root });
    expect(res.matches.some((m) => m.file.includes("node_modules"))).toBe(false);
  });

  it("restricts by glob", () => {
    const res = searchCode({ pattern: "foo", root, glob: "**/*.ts", ignoreCase: true });
    expect(res.matches.some((m) => m.file === "b.js")).toBe(false);
    expect(res.matches.some((m) => m.file === "a.ts")).toBe(true);
  });

  it("honors ignoreCase", () => {
    // b.js contains lowercase "foo"; capital "Foo" only matches case-insensitively.
    expect(searchCode({ pattern: "Foo", root, glob: "b.js" }).matches.length).toBe(0);
    expect(searchCode({ pattern: "Foo", root, glob: "b.js", ignoreCase: true }).matches.length).toBe(1);
  });

  it("returns context lines", () => {
    const res = searchCode({ pattern: "useFoo", root, glob: "a.ts", context: 1 });
    const m = res.matches[0];
    expect(m.before).toEqual(["const Foo = 1;"]);
  });

  it("treats pattern as literal when regex=false", () => {
    fs.writeFileSync(path.join(root, "d.ts"), "a.b.c\n");
    const asRegex = searchCode({ pattern: "a.b", root, glob: "d.ts" });          // '.' = any char
    const literal = searchCode({ pattern: "a.b", root, glob: "d.ts", regex: false });
    expect(asRegex.matches.length).toBe(1);
    expect(literal.matches.length).toBe(1);
    const noLit = searchCode({ pattern: "axb", root, glob: "d.ts", regex: false });
    expect(noLit.matches.length).toBe(0);
  });

  it("caps results and flags truncation", () => {
    fs.writeFileSync(path.join(root, "many.ts"), Array.from({ length: 50 }, () => "hit").join("\n"));
    const res = searchCode({ pattern: "hit", root, glob: "many.ts", maxResults: 10 });
    expect(res.matches.length).toBe(10);
    expect(res.truncated).toBe(true);
  });

  it("reports an invalid regex instead of throwing", () => {
    const res = searchCode({ pattern: "(", root });
    expect(res.error).toContain("invalid regex");
  });
});

describe("search · formatSearchResult", () => {
  it("renders file:line and a no-match message", () => {
    expect(formatSearchResult({ matches: [], filesScanned: 3, truncated: false })).toBe("No matches found.");
    const s = formatSearchResult({
      matches: [{ file: "a.ts", line: 2, text: "  return Foo;" }],
      filesScanned: 1, truncated: false,
    });
    expect(s).toContain("a.ts:2:");
    expect(s).toContain("return Foo");
  });
});
