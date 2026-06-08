import { describe, it, expect } from "vitest";
import { charWidth, visualWidth, padVisual, StreamRenderer } from "../src/cli/tui";

describe("CJK-aware width", () => {
  it("counts ascii as 1, CJK as 2", () => {
    expect(charWidth("a".codePointAt(0)!)).toBe(1);
    expect(charWidth("雾".codePointAt(0)!)).toBe(2);
    expect(charWidth("，".codePointAt(0)!)).toBe(2); // fullwidth comma
  });

  it("treats control chars as width 0", () => {
    expect(charWidth("\r".codePointAt(0)!)).toBe(0);
    expect(charWidth("\n".codePointAt(0)!)).toBe(0);
  });

  it("visualWidth sums correctly and ignores ANSI", () => {
    expect(visualWidth("abc")).toBe(3);
    expect(visualWidth("雾雨")).toBe(4);
    expect(visualWidth("a雾b")).toBe(4);
    expect(visualWidth("\x1b[36m雾\x1b[39m")).toBe(2); // color codes don't count
  });

  it("padVisual pads to a visual column count", () => {
    expect(visualWidth(padVisual("雾", 6))).toBe(6);
    expect(padVisual("abc", 2)).toBe("abc"); // never truncates
  });
});

/** Capture writes from a StreamRenderer into a string. */
function render(text: string, columns = 40, chunk = 3): string {
  let buf = "";
  const fakeOut = { columns, write: (s: string) => { buf += s; return true; } } as any;
  const r = new StreamRenderer(fakeOut, { gutter: "  " });
  for (let i = 0; i < text.length; i += chunk) r.write(text.slice(i, i + chunk));
  r.flush();
  return buf;
}

describe("StreamRenderer", () => {
  it("prefixes every line with the gutter", () => {
    const out = render("hello world", 80);
    expect(out.startsWith("  ")).toBe(true);
  });

  it("never exceeds the content width per visual line", () => {
    const out = render("天空织机是一个本地优先的多智能体终端框架用于验证换行宽度限制是否生效啊", 40);
    const maxContent = Math.min(40 - 2 - 1, 96);
    for (const line of out.split("\n")) {
      expect(visualWidth(line)).toBeLessThanOrEqual(2 + maxContent); // gutter + content
    }
  });

  it("strips stray carriage returns (CRLF from providers)", () => {
    const out = render("line one\r\nline two", 80);
    expect(out.includes("\r")).toBe(false);
    expect(out).toContain("line one");
    expect(out).toContain("line two");
  });

  it("wraps English on word boundaries without splitting short words", () => {
    // maxCols floors at 32, so use text long enough to exceed it.
    const out = render("alpha beta gamma delta epsilon zeta eta theta iota kappa", 40);
    expect(out.split("\n").length).toBeGreaterThan(1);
    // no whole word should be broken across a wrap (each appears intact)
    for (const w of ["alpha", "epsilon", "kappa"]) expect(out).toContain(w);
  });
});
