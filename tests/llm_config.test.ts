import { describe, expect, it, vi } from "vitest";
import { LLMClient } from "../src/core/llm";
import { ToolRegistry } from "../src/core/tool";

describe("LLM request settings", () => {
  it("uses runtime credentials and provider endpoint overrides", () => {
    const client = new LLMClient({
      default_model: "gpt-4o",
      api_keys: { openai: "runtime-only-key" },
      providers: {
        openai: { base_url: "http://127.0.0.1:8787/v1" },
        deepseek: { base_url: "http://127.0.0.1:8788/v1" },
      },
      agents: {},
    }, new ToolRegistry());

    expect((client as any).getApiKey("gpt-4o")).toBe("runtime-only-key");
    expect((client as any).getBaseUrl("gpt-4o")).toBe("http://127.0.0.1:8787/v1");
    expect((client as any).getBaseUrl("deepseek-chat")).toBe("http://127.0.0.1:8788/v1");
  });

  it("uses per-agent YAML settings and lets explicit overrides win", async () => {
    const client = new LLMClient({
      default_model: "gpt-4o",
      llm: { temperature: 0.8, max_tokens: 8192, max_retries: 0 },
      agents: { fog: { temperature: 0.25, max_tokens: 2048 } },
    }, new ToolRegistry());
    const response = { content: "ok", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } };
    const call = vi.spyOn(client as any, "callOpenAI").mockResolvedValue(response);
    const messages = [{ role: "user", content: "hello" }];

    await client.complete(messages, "fog");
    expect(call).toHaveBeenLastCalledWith("gpt-4o", messages, undefined, 0.25, 2048, "fog");

    await client.complete(messages, "fog", undefined, false, { temperature: 1.1, maxTokens: 4096 });
    expect(call).toHaveBeenLastCalledWith("gpt-4o", messages, undefined, 1.1, 4096, "fog");
  });

  it("honors snake_case max_retries from YAML", async () => {
    const client = new LLMClient({
      default_model: "gpt-4o",
      llm: { max_retries: 1 },
      agents: {},
    }, new ToolRegistry());
    const call = vi.spyOn(client as any, "callOpenAI").mockRejectedValue(new Error("offline"));

    await expect((client as any).completeWithRetry(
      "gpt-4o",
      [{ role: "user", content: "hello" }],
    )).rejects.toThrow("offline");
    expect(call).toHaveBeenCalledTimes(2);
  });
});
