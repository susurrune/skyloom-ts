import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const childMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  unref: vi.fn(),
  once: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: childMocks.execSync,
  execFileSync: childMocks.execFileSync,
  spawn: childMocks.spawn,
}));

import { ToolRegistry } from "../src/core/tool";
import { registerComputerTools } from "../src/tools/computer";

function setup() {
  const registry = new ToolRegistry();
  registerComputerTools(registry);
  return (name: string, params: Record<string, unknown>) => registry.get(name)!.handler!(params);
}

describe("computer tools · shell boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    childMocks.once.mockImplementation((event: string, callback: () => void) => {
      if (event === "spawn") callback();
    });
    childMocks.spawn.mockReturnValue({ unref: childMocks.unref, once: childMocks.once });
    childMocks.execFileSync.mockReturnValue("");
  });

  it("rejects non-http browser URLs before launching an OS handler", async () => {
    const call = setup();
    expect(await call("browser_open", { url: "file:///etc/passwd" })).toMatch(/http|scheme|blocked/i);
    expect(childMocks.execSync).not.toHaveBeenCalled();
    expect(childMocks.execFileSync).not.toHaveBeenCalled();
  });

  it("opens paths as one argv value without invoking a shell", async () => {
    const call = setup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-open-"));
    const target = path.join(dir, "ampersand & command.txt");
    fs.writeFileSync(target, "x");
    try {
      expect(await call("open_path", { target })).toMatch(/Opened/);
      expect(childMocks.execSync).not.toHaveBeenCalled();
      expect(childMocks.execFileSync).toHaveBeenCalledWith(
        process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open",
        [path.resolve(target)],
        expect.any(Object),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("launches an application without shell interpretation", async () => {
    const call = setup();
    const name = 'app" & command';
    expect(await call("launch_app", { name })).toMatch(/Launched/);
    expect(childMocks.execSync).not.toHaveBeenCalled();
    expect(childMocks.spawn).toHaveBeenCalledWith(name, [], expect.objectContaining({ shell: false }));
    expect(childMocks.unref).toHaveBeenCalled();
  });
});
