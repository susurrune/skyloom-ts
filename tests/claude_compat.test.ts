import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SkillRegistry } from "../src/core/skill";
import { dynamicSkillDirs } from "../src/skills/loader";
import { loadProjectMcpJson, expandEnvRefs } from "../src/core/mcp";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skycompat-")); });
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.SKY_TEST_TOKEN;
});

/** Write a Claude Code-style skill folder. */
function writeSkill(root: string, name: string, frontmatter: string, body: string, extras: Record<string, string> = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
  for (const [rel, content] of Object.entries(extras)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

describe("Claude Code skills 零迁移兼容", () => {
  it("loads folder-style skills (<root>/<name>/SKILL.md), ignoring sibling reference files", () => {
    writeSkill(tmp, "thesis-chart", "name: thesis-chart\ndescription: 学术图表绘制", "## 工作流程\n按学术配色出图", {
      "reference.md": "# 详细参考（不是独立技能）",
      "scripts/plot.py": "print('hi')",
    });
    const reg = new SkillRegistry();
    const loaded = reg.loadSkillFolders(tmp);
    expect(loaded.map(s => s.name)).toEqual(["thesis-chart"]); // reference.md 没被误注册
    const skill = reg.get("thesis-chart")!;
    expect(skill.description).toBe("学术图表绘制");
    expect(skill.systemPrompt).toContain("学术配色");
    expect(skill.resourceDir).toBe(path.join(tmp, "thesis-chart")); // 相对资源可解析
  });

  it("maps Claude Code allowed-tools names to sky tools", () => {
    writeSkill(tmp, "deploy", "name: deploy\ndescription: 部署\nallowed-tools: Bash, Read, WebFetch", "做部署");
    const reg = new SkillRegistry();
    reg.loadSkillFolders(tmp);
    const skill = reg.get("deploy")!;
    expect(skill.allowedTools).toContain("run_bash");
    expect(skill.allowedTools).toContain("read_file");
  });

  it("re-scan picks up live edits (Claude Code live change detection)", () => {
    writeSkill(tmp, "x", "name: x\ndescription: v1", "body1");
    const reg = new SkillRegistry();
    reg.loadSkillFolders(tmp);
    expect(reg.get("x")!.description).toBe("v1");
    writeSkill(tmp, "x", "name: x\ndescription: v2", "body2");
    reg.loadSkillFolders(tmp); // same call list_skills makes
    expect(reg.get("x")!.description).toBe("v2");
  });

  it("dynamic skill dirs include both .claude (compat) and .sky (native) locations", () => {
    const dirs = dynamicSkillDirs("/proj");
    expect(dirs).toContain(path.join(os.homedir(), ".claude", "skills"));
    expect(dirs).toContain(path.join("/proj", ".claude", "skills"));
    expect(dirs).toContain(path.join("/proj", ".sky", "skills"));
    // project dirs come after user dirs → later registration wins
    expect(dirs.indexOf(path.join("/proj", ".sky", "skills"))).toBeGreaterThan(
      dirs.indexOf(path.join(os.homedir(), ".claude", "skills")));
  });
});

describe("Claude Code .mcp.json 兼容", () => {
  it("parses the standard mcpServers schema (stdio + http)", () => {
    fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({
      mcpServers: {
        github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        db: { command: "npx", args: ["-y", "@bytebase/dbhub"], env: { DB_URL: "postgres://x" } },
      },
    }));
    const servers = loadProjectMcpJson(tmp);
    expect(servers).toHaveLength(2);
    const gh = servers.find(s => s.name === "github")!;
    expect(gh.url).toBe("https://api.githubcopilot.com/mcp/");
    const db = servers.find(s => s.name === "db")!;
    expect(db.command).toBe("npx");
    expect(db.args).toEqual(["-y", "@bytebase/dbhub"]);
    expect(db.env).toEqual({ DB_URL: "postgres://x" });
  });

  it("expands ${ENV_VAR} references so secrets stay out of the file", () => {
    process.env.SKY_TEST_TOKEN = "sk-secret";
    expect(expandEnvRefs("Bearer ${SKY_TEST_TOKEN}")).toBe("Bearer sk-secret");
    expect(expandEnvRefs("${MISSING_VAR_XYZ}")).toBe("");
    fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({
      mcpServers: { api: { command: "run", env: { TOKEN: "${SKY_TEST_TOKEN}" } } },
    }));
    expect(loadProjectMcpJson(tmp)[0].env).toEqual({ TOKEN: "sk-secret" });
  });

  it("tolerates missing/invalid files and unsupported entries", () => {
    expect(loadProjectMcpJson(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, ".mcp.json"), "not json{");
    expect(loadProjectMcpJson(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, ".mcp.json"), JSON.stringify({
      mcpServers: { weird: { type: "carrier-pigeon" } },
    }));
    expect(loadProjectMcpJson(tmp)).toEqual([]); // 无 command/url 的条目跳过
  });
});
