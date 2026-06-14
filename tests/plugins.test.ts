import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "../src/core/tool";
import { PluginLoader, type PluginContext } from "../src/plugins/loader";

describe("PluginLoader · hook lifecycle", () => {
  let reg: ToolRegistry;
  let loader: PluginLoader;
  beforeEach(() => {
    reg = new ToolRegistry();
    loader = new PluginLoader(reg, { foo: 1 });
  });

  it("activate-style plugin registers a scoped tool and an init hook", async () => {
    let initFired = false;
    loader.activatePlugin("p1", {
      activate(ctx: PluginContext) {
        expect(ctx.config).toEqual({ foo: 1 });
        ctx.registerTool({ name: "p1_tool", description: "t", handler: async () => "ok" });
        ctx.on("init", () => { initFired = true; });
      },
    });
    expect(reg.has("p1_tool")).toBe(true);
    expect(loader.list()).toContain("p1");
    expect(loader.hookCount("init")).toBe(1);

    await loader.emit("init");
    expect(initFired).toBe(true);
  });

  it("unload removes the plugin's tools and hook handlers", async () => {
    let fired = 0;
    loader.activatePlugin("p", {
      activate(ctx: PluginContext) {
        ctx.registerTool({ name: "tmp_tool", description: "t", handler: async () => "ok" });
        ctx.on("init", () => { fired++; });
      },
    });
    expect(reg.has("tmp_tool")).toBe(true);

    expect(loader.unload("p")).toBe(true);
    expect(reg.has("tmp_tool")).toBe(false);
    expect(loader.hookCount("init")).toBe(0);
    expect(loader.list()).not.toContain("p");

    await loader.emit("init");
    expect(fired).toBe(0); // handler gone
  });

  it("fires hook handlers in registration order across plugins", async () => {
    const order: string[] = [];
    loader.activatePlugin("a", { activate: (c) => c.on("init", () => { order.push("a"); }) });
    loader.activatePlugin("b", { activate: (c) => c.on("init", () => { order.push("b"); }) });
    await loader.emit("init");
    expect(order).toEqual(["a", "b"]);
  });

  it("reactivating a name unloads the previous instance (no duplicate tools)", () => {
    loader.activatePlugin("dup", { activate: (c) => c.registerTool({ name: "x", description: "v1", handler: async () => "1" }) });
    loader.activatePlugin("dup", { activate: (c) => c.registerTool({ name: "x", description: "v2", handler: async () => "2" }) });
    expect(loader.list().filter((n) => n === "dup")).toHaveLength(1);
    expect(reg.get("x")?.description).toBe("v2");
  });

  it("supports legacy register(registry) and tracks its tools for unload", () => {
    loader.activatePlugin("legacy", {
      register(r) { r.register({ name: "legacy_tool", description: "t", handler: async () => "ok" }); },
    });
    expect(reg.has("legacy_tool")).toBe(true);
    loader.unload("legacy");
    expect(reg.has("legacy_tool")).toBe(false);
  });

  it("isolates a throwing hook handler from the rest", async () => {
    const ran: string[] = [];
    loader.activatePlugin("a", { activate: (c) => c.on("evt", () => { throw new Error("boom"); }) });
    loader.activatePlugin("b", { activate: (c) => c.on("evt", () => { ran.push("b"); }) });
    await loader.emit("evt");
    expect(ran).toEqual(["b"]); // b still ran despite a throwing
  });

  it("unload returns false for an unknown plugin", () => {
    expect(loader.unload("nope")).toBe(false);
  });
});
