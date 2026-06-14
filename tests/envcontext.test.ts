import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitInfo, buildEnvBlock } from "../src/core/envcontext";

describe("envcontext · gitInfo", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-git-")); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("reads the branch from a .git directory HEAD", () => {
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feature-x\n");
    const info = gitInfo(dir);
    expect(info.repo).toBe(true);
    expect(info.branch).toBe("feature-x");
  });

  it("falls back to a short sha for a detached HEAD", () => {
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "0123456789abcdef\n");
    expect(gitInfo(dir).branch).toBe("01234567");
  });

  it("resolves a worktree .git file pointing at the real gitdir", () => {
    const real = path.join(dir, "realgit");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "HEAD"), "ref: refs/heads/wt-branch\n");
    fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${real}\n`);
    const info = gitInfo(dir);
    expect(info.repo).toBe(true);
    expect(info.branch).toBe("wt-branch");
  });

  it("reports no repo when there is no .git up the tree", () => {
    const nested = path.join(dir, "a", "b");
    fs.mkdirSync(nested, { recursive: true });
    expect(gitInfo(nested).repo).toBe(false);
  });
});

describe("envcontext · buildEnvBlock", () => {
  it("includes cwd, platform, node, git branch and an injectable date (zh)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sky-env-"));
    try {
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      const block = buildEnvBlock({ cwd: dir, lang: "zh", now: new Date("2026-06-14T08:00:00Z") });
      expect(block).toContain("运行环境");
      expect(block).toContain(dir);
      expect(block).toContain(process.version);
      expect(block).toContain(process.platform);
      expect(block).toContain("main");
      expect(block).toContain("2026-06-14");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("renders an English block", () => {
    const block = buildEnvBlock({ cwd: os.tmpdir(), lang: "en", now: new Date("2026-01-02T00:00:00Z") });
    expect(block).toContain("## Environment");
    expect(block).toContain("Working directory");
    expect(block).toContain("2026-01-02");
  });
});
