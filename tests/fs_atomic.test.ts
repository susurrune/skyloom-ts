import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { atomicWriteFileSync } from "../src/core/fs_atomic";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("atomic file persistence", () => {
  it("replaces existing content without leaving temporary files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sky-atomic-"));
    roots.push(root);
    const target = path.join(root, "config.yaml");
    fs.writeFileSync(target, "old");

    atomicWriteFileSync(target, "new", 0o600);

    expect(fs.readFileSync(target, "utf8")).toBe("new");
    expect(fs.readdirSync(root)).toEqual(["config.yaml"]);
  });
});
