import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../src/core/bus";
import { ToolCallExecutor } from "../src/core/agent/tools";
import { ToolRegistry } from "../src/core/tool";
import { Tracer } from "../src/core/trace";

describe("agent tool execution · approval boundary", () => {
  it("checks approval for a registered tool even without a dangerous hint", async () => {
    const handler = vi.fn(async () => "should not run");
    const approve = vi.fn(async () => false);
    const registry = new ToolRegistry();
    registry.register({
      name: "download_file",
      description: "download",
      handler,
    });

    const executor = new ToolCallExecutor({
      agentName: "fog",
      config: {},
      bus: new MessageBus(),
      registry,
      tracer: new Tracer({ enabled: false }),
      approve,
      setActing: vi.fn(async () => undefined),
      getHooks: () => ({ sessionStart: [], preTool: [], postTool: [] }),
      markFilesWritten: vi.fn(),
      addToolMessage: vi.fn(),
    });

    const [result] = await executor.execute([
      {
        id: "call-1",
        type: "function",
        function: {
          name: "download_file",
          arguments: '{"url":"https://example.com/a"}',
        },
      },
    ]);

    expect(approve).toHaveBeenCalledWith("download_file", {
      url: "https://example.com/a",
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, toolName: "download_file" });
    expect(result.result).toContain("[denied]");
  });
});
