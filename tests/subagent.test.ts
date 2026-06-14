import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MessageBus } from "../src/core/bus";
import { ToolRegistry } from "../src/core/tool";
import { SkillRegistry } from "../src/core/skill";
import {
  loadSubagentDefinitions,
  parseSubagentFile,
  runSubagent,
  READ_ONLY_TOOLS,
} from "../src/core/subagent";
import { createSpawnAgentTool } from "../src/tools/spawn";

/**
 * Subagent system: definition loading/parsing + isolated-context execution,
 * driven by a scripted mock LLM (no network), mirroring tests/agent.test.ts.
 */

interface Turn { content?: string; toolCalls?: { name: string; args?: any }[] }

class MockLLM {
  calls = 0;
  constructor(private turns: Turn[]) {}
  private turn(): Turn { const t = this.turns[Math.min(this.calls, this.turns.length - 1)]; this.calls++; return t || {}; }
  private toolCallObjs(t: Turn) {
    return (t.toolCalls || []).map((tc, i) => ({
      id: `call_${this.calls}_${i}`, type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
    }));
  }
  async *streamWithTools(): AsyncGenerator<any> {
    const t = this.turn();
    if (t.content) yield { type: "content", text: t.content };
    for (const tc of this.toolCallObjs(t)) yield { type: "tool_call", toolCall: tc };
    yield { type: "done", usage: { promptTokens: 1, completionTokens: 1 } };
  }
  async complete(): Promise<any> {
    const t = this.turn();
    return { content: t.content || "", toolCalls: this.toolCallObjs(t), model: "mock", usage: { promptTokens: 1, completionTokens: 1 }, cost: 0, truncated: false };
  }
  getTotalCost() { return 0; }
  getModel() { return "mock"; }
  setLogger() { /* noop */ }
}

function baseConfig() {
  return { agents: {}, llm: { language: "zh" }, memory: { shortTermLimit: 100, dbPath: path.join(os.tmpdir(), "sky-sub-test") } };
}

describe("subagent · definitions", () => {
  it("ships built-in general-purpose and explore agents", () => {
    const defs = loadSubagentDefinitions(os.tmpdir());
    expect(defs.has("general-purpose")).toBe(true);
    expect(defs.has("explore")).toBe(true);
  });

  it("explore is read-only: includes read_file, excludes write_file", () => {
    const defs = loadSubagentDefinitions(os.tmpdir());
    const explore = defs.get("explore")!;
    expect(explore.tools).not.toBeNull();
    expect(explore.tools).toContain("read_file");
    expect(explore.tools).not.toContain("write_file");
    expect(READ_ONLY_TOOLS).toContain("grep");
  });

  it("general-purpose inherits the full tool set (tools = null)", () => {
    const defs = loadSubagentDefinitions(os.tmpdir());
    expect(defs.get("general-purpose")!.tools).toBeNull();
  });
});

describe("subagent · file parsing", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-agentdefs-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("parses frontmatter, body, and normalizes Claude tool names", () => {
    const file = path.join(dir, "reviewer.md");
    fs.writeFileSync(file,
      "---\nname: reviewer\ndescription: 审查代码\ntools: Read, Grep, Bash\nmodel: gpt-4o\n---\n你是一个代码审查子智能体。\n");
    const def = parseSubagentFile(file)!;
    expect(def.name).toBe("reviewer");
    expect(def.description).toBe("审查代码");
    expect(def.model).toBe("gpt-4o");
    expect(def.systemPrompt).toContain("代码审查");
    // Read -> read_file, Bash -> run_bash, Grep -> grep
    expect(def.tools).toEqual(["read_file", "grep", "run_bash"]);
  });

  it("omitted tools means inherit all (null)", () => {
    const file = path.join(dir, "helper.md");
    fs.writeFileSync(file, "---\ndescription: 万能\n---\nbody\n");
    const def = parseSubagentFile(file)!;
    expect(def.name).toBe("helper");      // falls back to filename
    expect(def.tools).toBeNull();
  });

  it("project .sky/agents definitions are discovered and override built-ins", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sky-cwd-"));
    try {
      const agentsDir = path.join(cwd, ".sky", "agents");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, "custom.md"), "---\ndescription: 自定义\n---\nhi\n");
      const defs = loadSubagentDefinitions(cwd);
      expect(defs.has("custom")).toBe(true);
      expect(defs.get("custom")!.description).toBe("自定义");
    } finally {
      try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("subagent · isolated execution (mock LLM)", () => {
  it("runs to completion and returns the final report", async () => {
    const defs = loadSubagentDefinitions(os.tmpdir());
    const report = await runSubagent({
      def: defs.get("general-purpose")!,
      task: "say hi",
      config: baseConfig(),
      llm: new MockLLM([{ content: "REPORT: 完成了任务。" }]) as any,
      bus: new MessageBus(),
      baseToolRegistry: new ToolRegistry(),
      baseSkillRegistry: new SkillRegistry(),
    });
    expect(report).toContain("REPORT: 完成了任务。");
  });

  it("executes inherited tools inside the isolated loop", async () => {
    let ran = false;
    const reg = new ToolRegistry();
    reg.register({ name: "echo", description: "echo", handler: async (a: any) => { ran = true; return `echo:${a.text}`; } });
    const defs = loadSubagentDefinitions(os.tmpdir());
    const report = await runSubagent({
      def: defs.get("general-purpose")!,
      task: "use echo",
      config: baseConfig(),
      llm: new MockLLM([
        { toolCalls: [{ name: "echo", args: { text: "hi" } }] },
        { content: "用过 echo 了。" },
      ]) as any,
      bus: new MessageBus(),
      baseToolRegistry: reg,
      baseSkillRegistry: new SkillRegistry(),
    });
    expect(ran).toBe(true);
    expect(report).toContain("echo");
  });

  it("never carries spawn_agent into the subagent (no recursion)", async () => {
    // A registry that includes spawn_agent — the subagent must not see it.
    const reg = new ToolRegistry();
    reg.register({ name: "spawn_agent", description: "spawn", handler: async () => "should-not-run" });
    reg.register({ name: "noop", description: "noop", handler: async () => "ok" });
    const defs = loadSubagentDefinitions(os.tmpdir());
    // Script the model to TRY spawn_agent; it should be reported as nonexistent.
    const report = await runSubagent({
      def: defs.get("general-purpose")!,
      task: "try to spawn",
      config: baseConfig(),
      llm: new MockLLM([
        { toolCalls: [{ name: "spawn_agent", args: { agent_type: "x", task: "y" } }] },
        { content: "无法再派生。" },
      ]) as any,
      bus: new MessageBus(),
      baseToolRegistry: reg,
      baseSkillRegistry: new SkillRegistry(),
    });
    expect(report).toContain("无法再派生");
  });
});

describe("spawn_agent tool", () => {
  function makeTool(reg = new ToolRegistry(), llm = new MockLLM([{ content: "done" }])) {
    return createSpawnAgentTool({
      config: baseConfig(),
      llm: llm as any,
      bus: new MessageBus(),
      baseToolRegistry: reg,
      baseSkillRegistry: new SkillRegistry(),
      cwd: os.tmpdir(),
    });
  }

  it("lists available agent types in its description", () => {
    const tool = makeTool();
    expect(tool.description).toContain("general-purpose");
    expect(tool.description).toContain("explore");
  });

  it("errors on missing args", async () => {
    const tool = makeTool();
    expect(await tool.handler!({ agent_type: "general-purpose" })).toContain("task is required");
    expect(await tool.handler!({ task: "do" })).toContain("agent_type is required");
  });

  it("errors on unknown agent_type", async () => {
    const tool = makeTool();
    const out = await tool.handler!({ agent_type: "nope", task: "do" });
    expect(out).toContain("unknown agent_type");
    expect(out).toContain("general-purpose");
  });

  it("runs a subagent and returns its report with a header", async () => {
    const tool = makeTool(new ToolRegistry(), new MockLLM([{ content: "子任务结果。" }]));
    const out = await tool.handler!({ agent_type: "general-purpose", task: "做点事" });
    expect(out).toContain("subagent general-purpose 完成");
    expect(out).toContain("子任务结果。");
  });
});
