import { describe, it, expect } from "vitest";
import { registry, CommandRegistry, BUILTIN_COMMANDS } from "../src/core/commands";
import { SLASH_COMMANDS } from "../src/cli/tui";

/** The commands the loom TUI shipped before the registry was wired in. None
 *  of these may silently disappear from the palette. */
const SHIPPED = [
  "/fog", "/rain", "/frost", "/snow", "/dew", "/fair",
  "/help", "/setup", "/init", "/plan", "/verify", "/context",
  "/rewind", "/tools", "/trace", "/model", "/cost", "/status",
  "/memory", "/sessions", "/resume", "/new", "/workspace",
  "/compact", "/clear", "/task", "/mcp", "/version", "/quit",
];

describe("command registry", () => {
  it("includes /trace (previously missing from the registry catalog)", () => {
    const trace = registry.get("trace");
    expect(trace).toBeTruthy();
    expect(trace!.category).toBe("context");
    expect(registry.slashItems("zh").some(([t]) => t.trim() === "/trace")).toBe(true);
  });

  it("treats /clear and /new as distinct commands, not aliases", () => {
    const clear = registry.get("clear");
    const neu = registry.get("new");
    expect(clear?.name).toBe("clear");
    expect(neu?.name).toBe("new");
    expect(neu!.aliases).not.toContain("clear");
  });

  it("resolves real aliases to their canonical command", () => {
    expect(registry.get("summarize")?.label).toBe(registry.get("compact")?.label);
    expect(registry.get("undo")?.label).toBe(registry.get("rewind")?.label);
    expect(registry.get("exit")?.label).toBe(registry.get("quit")?.label);
  });

  it("omits hidden (unwired) commands from the palette but keeps them in the catalog", () => {
    for (const name of ["share", "unshare", "retry"]) {
      expect(registry.get(name)).toBeTruthy(); // catalogued
      expect(registry.slashItems("zh").some(([t]) => t.trim() === "/" + name)).toBe(false); // not advertised
    }
  });

  it("marks argument-required commands with a trailing space, others without", () => {
    const items = new Map(registry.slashItems("zh").map(([t, l]) => [t.trim(), t]));
    expect(items.get("/resume")).toBe("/resume "); // fill-and-wait
    expect(items.get("/task")).toBe("/task ");
    expect(items.get("/status")).toBe("/status"); // executes on Enter
    expect(items.get("/trace")).toBe("/trace");
  });

  it("gives every advertised command a non-empty zh label", () => {
    for (const [token, label] of registry.slashItems("zh")) {
      expect(label.trim().length, `empty label for ${token}`).toBeGreaterThan(0);
    }
  });

  it("uses English descriptions when asked for the en surface", () => {
    const en = new Map(registry.slashItems("en").map(([t, l]) => [t.trim(), l]));
    expect(en.get("/trace")).toMatch(/trace/i);
    expect(en.get("/fog")).toMatch(/fog/i);
  });

  it("produces no duplicate tokens", () => {
    const tokens = registry.slashItems("zh").map(([t]) => t.trim());
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("registry ↔ TUI wiring", () => {
  it("the loom palette is derived from the registry", () => {
    expect(SLASH_COMMANDS).toEqual(registry.slashItems("zh"));
  });

  it("every command the loom TUI shipped is still in the palette (no regression)", () => {
    const tokens = new Set(SLASH_COMMANDS.map(([t]) => t.trim()));
    for (const cmd of SHIPPED) {
      expect(tokens.has(cmd), `missing ${cmd}`).toBe(true);
    }
  });

  it("surfaces the catalog commands that the old hand-list had dropped", () => {
    const tokens = new Set(SLASH_COMMANDS.map(([t]) => t.trim()));
    // These existed in dispatch but never in the old palette array.
    for (const cmd of ["/export", "/models", "/connect", "/redo", "/thinking", "/details", "/skills", "/warp", "/move", "/auto", "/default", "/review"]) {
      expect(tokens.has(cmd), `missing ${cmd}`).toBe(true);
    }
  });
});

describe("registry renderHelp", () => {
  const lines = registry.renderHelp("zh");
  const text = lines.join("\n");

  it("groups commands under category section headers", () => {
    expect(lines.some((l) => l.startsWith("§"))).toBe(true);
    expect(text).toContain("§ Agent 切换");
    expect(text).toContain("§ 系统");
  });

  it("lists real commands with their zh labels and omits hidden ones", () => {
    expect(text).toContain("/trace");
    expect(text).toContain("/apikey");
    expect(text).not.toContain("/share");   // hidden
    expect(text).not.toContain("/unshare");
  });

  it("marks argument-required commands", () => {
    expect(lines.some((l) => l.includes("/resume …"))).toBe(true);
    expect(lines.some((l) => l.includes("/task …"))).toBe(true);
  });
});

describe("registry search / listing", () => {
  it("search matches on name, label, and alias", () => {
    expect(registry.search("trace").some(c => c.name === "trace")).toBe(true);
    expect(registry.search("追踪").some(c => c.name === "trace")).toBe(true); // zh label
    expect(registry.search("summarize").some(c => c.name === "compact")).toBe(true); // alias
  });

  it("list() dedupes and a fresh registry matches the singleton surface", () => {
    const fresh = new CommandRegistry();
    expect(fresh.slashItems("zh")).toEqual(registry.slashItems("zh"));
    expect(registry.list().length).toBe(new Set(BUILTIN_COMMANDS.map(c => c.name)).size);
  });
});
