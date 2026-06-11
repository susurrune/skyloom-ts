import { describe, it, expect, afterEach } from "vitest";
import * as path from "path";
import * as os from "os";
import { fenceCheck, fenceRoot } from "../src/tools/builtin";
import { isSafePluginPath } from "../src/plugins/loader";

describe("workspace fence (opt-in)", () => {
  afterEach(() => {
    delete process.env.SKYLOOM_WORKSPACE_FENCE;
    delete process.env.SKYLOOM_WORKSPACE_ROOT;
  });

  it("is disabled by default (no env)", () => {
    expect(fenceRoot()).toBeNull();
    expect(fenceCheck("/etc/passwd")).toBeNull();
  });

  it("confines paths to the root when enabled", () => {
    const root = path.join(os.tmpdir(), "sky-fence-root");
    process.env.SKYLOOM_WORKSPACE_FENCE = "1";
    process.env.SKYLOOM_WORKSPACE_ROOT = root;
    expect(fenceCheck(path.join(root, "a", "b.txt"))).toBeNull();
    expect(fenceCheck(root)).toBeNull();
    expect(fenceCheck("/etc/passwd")).toMatch(/路径越界/);
    // sibling prefix must not slip past (root vs root-evil)
    expect(fenceCheck(root + "-evil/x")).toMatch(/路径越界/);
    // traversal out
    expect(fenceCheck(path.join(root, "..", "secret"))).toMatch(/路径越界/);
  });
});

describe("plugin path safety", () => {
  it("allows owner-only paths, rejects world/group-writable (POSIX)", () => {
    if (process.platform === "win32") return; // bits not meaningful on Windows
    const fs = require("fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-plugin-"));
    const safe = path.join(dir, "safe.js"); fs.writeFileSync(safe, "", { mode: 0o644 }); fs.chmodSync(safe, 0o644);
    const unsafe = path.join(dir, "unsafe.js"); fs.writeFileSync(unsafe, ""); fs.chmodSync(unsafe, 0o666);
    expect(isSafePluginPath(safe)).toBe(true);
    expect(isSafePluginPath(unsafe)).toBe(false);
  });

  it("honors the unsafe opt-out", () => {
    if (process.platform === "win32") return;
    const fs = require("fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-plugin2-"));
    const unsafe = path.join(dir, "x.js"); fs.writeFileSync(unsafe, ""); fs.chmodSync(unsafe, 0o666);
    process.env.SKYLOOM_ALLOW_UNSAFE_PLUGINS = "1";
    try { expect(isSafePluginPath(unsafe)).toBe(true); }
    finally { delete process.env.SKYLOOM_ALLOW_UNSAFE_PLUGINS; }
  });
});
