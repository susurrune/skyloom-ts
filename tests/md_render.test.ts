import { describe, it, expect } from "vitest";
import { styleLine, newRenderState, styleBlock, styleInline } from "../src/cli/md_render";

describe("md_render · styleInline", () => {
  it("renders bold", () => {
    const out = styleInline("hello **world** ok");
    expect(out).not.toContain("**");
    expect(out).toContain("world");
  });
  it("renders inline code", () => {
    const out = styleInline("use `foo.bar()` here");
    // inline code should preserve content, not contain backticks
    expect(out).not.toContain("`");
    expect(out).toContain("foo.bar()");
  });
  it("does not re-style content inside backticks", () => {
    const out = styleInline("` **not bold** `");
    expect(out).not.toContain("**");
    expect(out).toContain("not bold");
  });
});

describe("md_render · styleLine (block+inline)", () => {
  it("renders H2 heading", () => {
    const s = newRenderState();
    const out = styleLine("## 设计概要", s);
    expect(out).not.toContain("##");
    expect(out).toContain("设计概要");
  });
  it("renders HR", () => {
    const s = newRenderState();
    const out = styleLine("---", s);
    expect(out).not.toContain("---");
    expect(out.length).toBeGreaterThan(2);
  });
  it("renders unordered list bullets", () => {
    const s = newRenderState();
    const out = styleLine("- 性能 · 每秒", s);
    expect(out).not.toStrictEqual(expect.stringContaining("- ")); // raw hyphen gone
    expect(out).toContain("性能");
  });
  it("renders bold+italic in content lines", () => {
    const s = newRenderState();
    const out = styleLine("**粗体** 和 *斜体* 文字", s);
    expect(out).not.toContain("**");
    expect(out).not.toContain("*");
    expect(out).toContain("粗体");
    expect(out).toContain("斜体");
  });
});

describe("md_render · code fences", () => {
  it("tracks fence state and renders code blocks raw", () => {
    const s = newRenderState();
    expect(styleLine("```ts", s)).toContain("```");
    expect(s.inCodeFence).toBe(true);
    expect(styleLine("const x = 1;", s)).toContain("const x = 1;");
    expect(styleLine("```", s)).toContain("```");
    expect(s.inCodeFence).toBe(false);
  });
  it("does not style bold inside a code fence", () => {
    const s = newRenderState();
    styleLine("```", s);
    const out = styleLine("**not bold**", s);
    expect(out).toContain("**not bold**");
  });
});

describe("md_render · styleBlock", () => {
  it("renders a multi-line markdown block", () => {
    const out = styleBlock("## H2\n- bullet **bold**\n\n```\ncode\n```\nnormal.");
    expect(out).not.toMatch(/^\s*##/);
    expect(out).toContain("H2");
    expect(out).toContain("bold");
    expect(out).toContain("code");
    expect(out).not.toContain("**bold**");
  });
});
