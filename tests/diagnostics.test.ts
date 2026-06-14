import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getDiagnostics,
  getTypeScriptDiagnostics,
  parseDiagnosticOutput,
  formatDiagnostics,
} from "../src/core/diagnostics";

describe("diagnostics · TypeScript compiler API", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-diag-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  function write(name: string, content: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  }

  it("reports a type error with line:col and TS code", () => {
    const p = write("bad.ts", "const x: number = 'hello';\n");
    const res = getTypeScriptDiagnostics(p);
    expect(Array.isArray(res)).toBe(true);
    const diags = res as any[];
    expect(diags.length).toBeGreaterThan(0);
    const err = diags[0];
    expect(err.severity).toBe("error");
    expect(err.line).toBe(1);
    expect(err.code).toMatch(/^TS\d+/);
    expect(err.source).toBe("ts");
  });

  it("returns an empty array for a clean file", () => {
    const p = write("ok.ts", "export const y: number = 5;\n");
    const res = getTypeScriptDiagnostics(p);
    expect(Array.isArray(res)).toBe(true);
    expect((res as any[]).length).toBe(0);
  });

  it("getDiagnostics dispatches TS files to the compiler API", () => {
    const p = write("d.ts", "let n: string = 42;\n");
    const res = getDiagnostics(p, {});
    expect(Array.isArray(res)).toBe(true);
    expect((res as any[]).length).toBeGreaterThan(0);
  });

  it("returns unavailable for an unconfigured non-TS extension", () => {
    const p = write("script.rb", "puts 'hi'\n");
    const res = getDiagnostics(p, {});
    expect(Array.isArray(res)).toBe(false);
    expect((res as any).unavailable).toContain("no diagnostics provider");
  });

  it("returns unavailable for a missing file", () => {
    const res = getDiagnostics(path.join(dir, "nope.ts"), {});
    expect((res as any).unavailable).toContain("not found");
  });
});

describe("diagnostics · external output parsing", () => {
  it("parses path:line:col: severity message lines", () => {
    const out = "src/a.py:3:5: error: undefined name 'x'\nsrc/a.py:7:1: warning: unused import";
    const diags = parseDiagnosticOutput(out, "ruff");
    expect(diags.length).toBe(2);
    expect(diags[0]).toMatchObject({ line: 3, column: 5, severity: "error" });
    expect(diags[1].severity).toBe("warning");
    expect(diags[0].source).toBe("ruff");
  });
});

describe("diagnostics · formatting", () => {
  it("formats a clean result", () => {
    expect(formatDiagnostics("a.ts", [])).toContain("no diagnostics");
  });
  it("formats errors with counts", () => {
    const s = formatDiagnostics("a.ts", [
      { line: 2, column: 3, severity: "error", message: "boom", code: "TS1", source: "ts" },
    ]);
    expect(s).toContain("1 error");
    expect(s).toContain("2:3");
    expect(s).toContain("boom");
  });
});
