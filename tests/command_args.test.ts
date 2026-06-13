import { describe, it, expect } from "vitest";
import {
  hasWizard, nextWizardStep, buildCommandLine, filterChoices,
  type WizardContext, type ArgChoice,
} from "../src/cli/command_args";

const CTX: WizardContext = {
  providers: [
    { id: "openai", label: "OpenAI", configured: true, envVar: "OPENAI_API_KEY" },
    { id: "deepseek", label: "DeepSeek", configured: false, envVar: "DEEPSEEK_API_KEY" },
    { id: "ollama", label: "Ollama", configured: true },
  ],
  models: [
    { id: "gpt-4o", provider: "openai", label: "gpt-4o", hint: "$2.5/$10" },
    { id: "deepseek-chat", provider: "deepseek", label: "deepseek-chat", hint: "$0.3/$1.1" },
  ],
  sessions: [
    { id: "abcdef123456", label: "重构搜索模块" },
    { id: "ff00aa221133", label: "写测试" },
  ],
};

describe("hasWizard", () => {
  it("recognizes wizard commands with or without slash", () => {
    for (const c of ["model", "/model", "apikey", "/apikey", "connect", "resume"]) {
      expect(hasWizard(c), c).toBe(true);
    }
  });
  it("rejects non-wizard commands", () => {
    for (const c of ["help", "/status", "fog", "/clear", "verify"]) {
      expect(hasWizard(c), c).toBe(false);
    }
  });
});

describe("nextWizardStep · /apikey (the key-config flow)", () => {
  it("step 0 lists providers with configured badges", () => {
    const step = nextWizardStep("/apikey", [], CTX)!;
    expect(step.kind).toBe("choice");
    expect(step.choices.map((c) => c.value)).toEqual(["openai", "deepseek", "ollama"]);
    expect(step.choices[0].hint).toContain("已配置");      // openai configured
    expect(step.choices[1].hint).toContain("DEEPSEEK_API_KEY"); // deepseek not configured
    expect(step.allowFreeform).toBe(true);
  });
  it("step 1 prompts for the key, masked", () => {
    const step = nextWizardStep("/apikey", ["deepseek"], CTX)!;
    expect(step.kind).toBe("freeform");
    expect(step.secret).toBe(true);
    expect(step.title).toContain("deepseek");
  });
  it("is complete after provider + key", () => {
    expect(nextWizardStep("/apikey", ["deepseek", "sk-xxx"], CTX)).toBeNull();
  });
  it("builds the correct command line", () => {
    expect(buildCommandLine("/apikey", ["deepseek", "sk-xxx"])).toBe("/apikey set deepseek sk-xxx");
  });
});

describe("nextWizardStep · /model", () => {
  it("offers reset + every model, completes after one pick", () => {
    const step = nextWizardStep("/model", [], CTX)!;
    expect(step.choices[0].value).toBe("reset");
    expect(step.choices.map((c) => c.value)).toContain("gpt-4o");
    expect(step.choices.find((c) => c.value === "gpt-4o")!.group).toBe("openai");
    expect(nextWizardStep("/model", ["gpt-4o"], CTX)).toBeNull();
  });
  it("builds /model <id> and /model reset", () => {
    expect(buildCommandLine("/model", ["gpt-4o"])).toBe("/model gpt-4o");
    expect(buildCommandLine("/model", ["reset"])).toBe("/model reset");
  });
});

describe("nextWizardStep · /connect and /resume", () => {
  it("connect picks a provider", () => {
    const step = nextWizardStep("/connect", [], CTX)!;
    expect(step.choices.map((c) => c.value)).toEqual(["openai", "deepseek", "ollama"]);
    expect(nextWizardStep("/connect", ["openai"], CTX)).toBeNull();
    expect(buildCommandLine("/connect", ["openai"])).toBe("/connect openai");
  });
  it("resume lists sessions by index, builds /resume <n>", () => {
    const step = nextWizardStep("/resume", [], CTX)!;
    expect(step.choices.map((c) => c.value)).toEqual(["1", "2"]);
    expect(step.choices[0].label).toContain("重构搜索模块");
    expect(buildCommandLine("/resume", ["1"])).toBe("/resume 1");
  });
  it("resume with no sessions still returns a (empty) step, not a crash", () => {
    const step = nextWizardStep("/resume", [], { ...CTX, sessions: [] })!;
    expect(step.choices).toHaveLength(0);
    expect(step.allowFreeform).toBe(true);
  });
});

describe("filterChoices", () => {
  const choices: ArgChoice[] = [
    { value: "gpt-4o", label: "gpt-4o", group: "openai" },
    { value: "deepseek-chat", label: "deepseek-chat", group: "deepseek" },
    { value: "gpt-4o-mini", label: "gpt-4o-mini", group: "openai" },
  ];
  it("returns all on empty query", () => {
    expect(filterChoices(choices, "")).toHaveLength(3);
  });
  it("matches on value substring", () => {
    expect(filterChoices(choices, "deepseek").map((c) => c.value)).toEqual(["deepseek-chat"]);
  });
  it("matches on group", () => {
    expect(filterChoices(choices, "openai").map((c) => c.value).sort()).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });
  it("ranks exact/prefix matches before substring matches", () => {
    const ranked = filterChoices(choices, "gpt-4o");
    expect(ranked[0].value).toBe("gpt-4o"); // exact first
  });
  it("returns empty when nothing matches", () => {
    expect(filterChoices(choices, "zzz")).toHaveLength(0);
  });
});
