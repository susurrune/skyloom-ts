import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getFileCheckpoints } from "../src/core/file_checkpoint";
import { loadCustomCommands, substituteArgs, resolveCustomCommand } from "../src/cli/commands_md";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skycp-"));
  getFileCheckpoints().clear();
});
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe("文件级检查点 /rewind", () => {
  it("snapshots before mutation and restores on rewind", () => {
    const cp = getFileCheckpoints();
    const f = path.join(tmp, "a.txt");
    fs.writeFileSync(f, "原始内容");

    cp.beginTurn("改 a.txt");
    cp.snapshot(f);
    fs.writeFileSync(f, "agent 改坏了");

    const r = cp.rewind(1);
    expect(r.turns).toBe(1);
    expect(r.restored).toEqual([f]);
    expect(fs.readFileSync(f, "utf-8")).toBe("原始内容");
  });

  it("deletes files that did not exist before the turn", () => {
    const cp = getFileCheckpoints();
    const f = path.join(tmp, "new.txt");

    cp.beginTurn("新建文件");
    cp.snapshot(f); // 不存在 → content null
    fs.writeFileSync(f, "agent 新建的");

    const r = cp.rewind(1);
    expect(r.deleted).toEqual([f]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("first touch per turn wins; multi-turn rewind restores the oldest state", () => {
    const cp = getFileCheckpoints();
    const f = path.join(tmp, "a.txt");
    fs.writeFileSync(f, "v1");

    cp.beginTurn("第一轮");
    cp.snapshot(f);
    fs.writeFileSync(f, "v2");
    cp.snapshot(f); // 同轮第二次：忽略
    fs.writeFileSync(f, "v2b");

    cp.beginTurn("第二轮");
    cp.snapshot(f);
    fs.writeFileSync(f, "v3");

    const r = cp.rewind(2);
    expect(r.turns).toBe(2);
    expect(fs.readFileSync(f, "utf-8")).toBe("v1");
  });

  it("rewound turns are consumed; empty turns don't stack", () => {
    const cp = getFileCheckpoints();
    const f = path.join(tmp, "a.txt");
    fs.writeFileSync(f, "v1");
    cp.beginTurn("空轮");      // 无快照
    cp.beginTurn("有改动");
    cp.snapshot(f);
    fs.writeFileSync(f, "v2");
    expect(cp.list().length).toBe(1);
    cp.rewind(1);
    expect(cp.list().length).toBe(0);
    expect(cp.rewind(1).turns).toBe(0);
  });

  it("pathToSnapshot only matches mutating file tools", () => {
    const cp = getFileCheckpoints();
    expect(cp.pathToSnapshot("write_file", { path: "x.txt" })).toBe("x.txt");
    expect(cp.pathToSnapshot("edit_file", { path: "x.txt" })).toBe("x.txt");
    expect(cp.pathToSnapshot("delete_file", { path: "x.txt" })).toBe("x.txt");
    expect(cp.pathToSnapshot("read_file", { path: "x.txt" })).toBeNull();
    expect(cp.pathToSnapshot("run_bash", { command: "rm x" })).toBeNull();
    expect(cp.pathToSnapshot("write_file", {})).toBeNull();
  });
});

describe("自定义斜杠命令", () => {
  function writeCmd(rel: string, content: string) {
    const f = path.join(tmp, ".sky", "commands", rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }

  it("loads commands with frontmatter; subdirectories namespace", () => {
    writeCmd("fix-issue.md", "---\ndescription: 修复 issue\nagent: rain\n---\n修复 issue #$ARGUMENTS");
    writeCmd("git/commit.md", "规范化提交");
    const cmds = loadCustomCommands(tmp);
    const names = cmds.map(c => c.name);
    expect(names).toContain("fix-issue");
    expect(names).toContain("git:commit");
    const fix = cmds.find(c => c.name === "fix-issue")!;
    expect(fix.description).toBe("修复 issue");
    expect(fix.agent).toBe("rain");
    // 无 frontmatter：首行作描述
    expect(cmds.find(c => c.name === "git:commit")!.description).toBe("规范化提交");
  });

  it("substitutes $ARGUMENTS and positional $1..$9", () => {
    expect(substituteArgs("issue #$ARGUMENTS", "123 high")).toBe("issue #123 high");
    expect(substituteArgs("from $1 to $2 ($3)", "a b")).toBe("from a to b ()");
  });

  it("resolveCustomCommand matches name and expands args", () => {
    writeCmd("review.md", "---\ndescription: 审查\n---\n审查 $1 的改动");
    const cmds = loadCustomCommands(tmp);
    const hit = resolveCustomCommand("/review src/core", cmds);
    expect(hit).not.toBeNull();
    expect(hit!.prompt).toBe("审查 src/core 的改动");
    expect(resolveCustomCommand("/nonexistent", cmds)).toBeNull();
    expect(resolveCustomCommand("not-slash", cmds)).toBeNull();
  });
});
