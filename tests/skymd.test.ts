import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadProjectMemory, appendQuickMemory, parseVerifyCommands, projectMemoryFile } from "../src/core/skymd";
import { resolveVerifyConfig, runVerify } from "../src/core/verify";
import { loadHooks, matches, runPreToolHooks } from "../src/core/hooks";
import { expandFileRefs, isBangCommand, bangCommand, runBang, isHashMemory, hashNote } from "../src/cli/input_macros";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skymd-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("项目记忆 SKY.md", () => {
  it("loads the project layer and reports contributing files", () => {
    fs.writeFileSync(path.join(tmp, "SKY.md"), "构建: npm run build");
    const mem = loadProjectMemory(tmp);
    expect(mem.text).toContain("构建: npm run build");
    expect(mem.files.some(f => f.endsWith("SKY.md"))).toBe(true);
  });

  it("falls back to CLAUDE.md / AGENTS.md for compatibility", () => {
    fs.writeFileSync(path.join(tmp, "AGENTS.md"), "agents 约定");
    expect(projectMemoryFile(tmp)).toContain("AGENTS.md");
    expect(loadProjectMemory(tmp).text).toContain("agents 约定");
    // SKY.md wins over AGENTS.md when both exist
    fs.writeFileSync(path.join(tmp, "SKY.md"), "sky 约定");
    expect(projectMemoryFile(tmp)).toContain("SKY.md");
  });

  it("layers SKY.local.md after the project file", () => {
    fs.writeFileSync(path.join(tmp, "SKY.md"), "shared");
    fs.writeFileSync(path.join(tmp, "SKY.local.md"), "personal");
    const text = loadProjectMemory(tmp).text;
    expect(text.indexOf("shared")).toBeLessThan(text.indexOf("personal"));
  });

  it("clamps oversized files", () => {
    fs.writeFileSync(path.join(tmp, "SKY.md"), "x".repeat(50000));
    expect(loadProjectMemory(tmp).text.length).toBeLessThan(15000);
  });

  it("appendQuickMemory creates SKY.md with a header, then appends", () => {
    const f1 = appendQuickMemory("测试必须用 vitest", tmp);
    expect(fs.readFileSync(f1, "utf-8")).toContain("- 测试必须用 vitest");
    appendQuickMemory("禁止 any", tmp);
    const content = fs.readFileSync(f1, "utf-8");
    expect(content).toContain("- 禁止 any");
    expect(content.indexOf("vitest")).toBeLessThan(content.indexOf("禁止 any"));
  });

  it("appendQuickMemory targets an existing CLAUDE.md", () => {
    fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "# rules\n");
    const f = appendQuickMemory("note", tmp);
    expect(f).toContain("CLAUDE.md");
  });

  it("parseVerifyCommands extracts the fenced block under ## Verify", () => {
    const text = "# SKY\n\n## Verify\n```bash\nnpm test\n# comment\nnpm run lint\n```\n\n## Other\n";
    expect(parseVerifyCommands(text)).toEqual(["npm test", "npm run lint"]);
    expect(parseVerifyCommands("no section")).toEqual([]);
  });
});

describe("验证闭环", () => {
  it("passes when every command exits 0", () => {
    const r = runVerify({ commands: ["node -e \"process.exit(0)\""], maxFixRounds: 2, timeoutS: 30 }, tmp);
    expect(r.ok).toBe(true);
    expect(r.report).toContain("✓");
  });

  it("stops at the first failure and captures output", () => {
    const r = runVerify({
      commands: ["node -e \"console.error('boom'); process.exit(3)\"", "node -e \"process.exit(0)\""],
      maxFixRounds: 2, timeoutS: 30,
    }, tmp);
    expect(r.ok).toBe(false);
    expect(r.report).toContain("boom");
    expect(r.report).toContain("exit 3");
    expect(r.report).not.toContain("✓ node -e \"process.exit(0)\"");
  });

  it("resolveVerifyConfig prefers config over SKY.md", () => {
    const cfg = resolveVerifyConfig({ verify: { commands: ["a"], max_fix_rounds: 5 } }, tmp);
    expect(cfg.commands).toEqual(["a"]);
    expect(cfg.maxFixRounds).toBe(5);
  });
});

describe("hooks", () => {
  it("loads and normalizes config shapes", () => {
    const h = loadHooks({ hooks: { session_start: ["echo hi"], pre_tool: [{ matcher: "run_bash", command: "true" }], post_tool: ["echo done"] } });
    expect(h.sessionStart).toEqual(["echo hi"]);
    expect(h.preTool[0].matcher).toBe("run_bash");
    expect(h.postTool[0].command).toBe("echo done");
  });

  it("matcher is a regex on the tool name (missing matcher = all)", () => {
    expect(matches({ matcher: "write_|edit_", command: "x" }, "write_file")).toBe(true);
    expect(matches({ matcher: "write_|edit_", command: "x" }, "read_file")).toBe(false);
    expect(matches({ command: "x" }, "anything")).toBe(true);
  });

  it("pre_tool hook blocks on non-zero exit", () => {
    const h = loadHooks({ hooks: { pre_tool: [{ matcher: "danger", command: "node -e \"console.log('nope'); process.exit(1)\"" }] } });
    const blocked = runPreToolHooks(h, "danger_tool", {}, "fog");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("nope");
    const allowed = runPreToolHooks(h, "read_file", {}, "fog");
    expect(allowed.allowed).toBe(true);
  });
});

describe("输入宏", () => {
  it("# quick memory detection", () => {
    expect(isHashMemory("# 用 pnpm")).toBe(true);
    expect(isHashMemory("#用 pnpm")).toBe(true);
    expect(isHashMemory("## markdown heading")).toBe(false);
    expect(isHashMemory("正文 # 不算")).toBe(false);
    expect(hashNote("#  用 pnpm ")).toBe("用 pnpm");
  });

  it("! shell detection and execution", () => {
    expect(isBangCommand("!git status")).toBe(true);
    expect(isBangCommand("hello!")).toBe(false);
    expect(bangCommand("! echo hi")).toBe("echo hi");
    const r = runBang("node -e \"console.log('out')\"", tmp);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("out");
    expect(runBang("node -e \"process.exit(2)\"", tmp).ok).toBe(false);
  });

  it("@file expands existing files into fenced attachments", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "file content here");
    const r = expandFileRefs("看一下 @a.txt 的内容", tmp);
    expect(r.attached).toEqual(["a.txt"]);
    expect(r.text).toContain("file content here");
    expect(r.text).toContain("看一下 @a.txt 的内容"); // original preserved
  });

  it("@file leaves missing files untouched", () => {
    const r = expandFileRefs("ping @nonexistent.ts", tmp);
    expect(r.attached).toEqual([]);
    expect(r.text).toBe("ping @nonexistent.ts");
  });
});
