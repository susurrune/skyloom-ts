import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getLogger, setLogSink, setLogFile, silenceLogs } from "../src/core/logger";

afterEach(() => { silenceLogs(); }); // never leak to the terminal between tests

describe("logger · sink routing", () => {
  it("routes log lines to a custom sink instead of stderr", () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    getLogger("test-sink").warn("hello_world", { a: 1 });
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.msg).toBe("hello_world");
    expect(entry.level).toBe("warn");
    expect(entry.a).toBe(1);
  });

  it("silenceLogs discards output (keeps a TUI clean)", () => {
    let count = 0;
    setLogSink(() => { count++; });
    silenceLogs();
    getLogger("test-silence").error("should_be_dropped");
    expect(count).toBe(0);
  });

  it("setLogFile appends log lines to a file, not the terminal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-log-"));
    const file = path.join(dir, "sky.log");
    try {
      const resolved = setLogFile(file);
      expect(resolved).toBe(file);
      getLogger("test-file").warn("to_file", { n: 7 });
      const content = fs.readFileSync(file, "utf8");
      expect(content).toContain("to_file");
      expect(content).toContain('"n":7');
    } finally {
      silenceLogs();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
