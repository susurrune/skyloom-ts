import { describe, it, expect } from "vitest";
import { visualWidth } from "../src/cli/tui";
import {
  cutVisual, padAnsi, wrapPlain, Screen, mountainRow, overlay, circled,
  LoomUI, OrchState,
} from "../src/cli/loom";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("ANSI-aware helpers", () => {
  it("cutVisual truncates by visual width, keeping ANSI", () => {
    expect(strip(cutVisual("hello", 3))).toBe("hel");
    expect(strip(cutVisual("雾雨霜", 4))).toBe("雾雨");
    expect(strip(cutVisual("雾雨霜", 5))).toBe("雾雨"); // can't split a wide glyph
    const styled = "\x1b[36m雾雨\x1b[39m";
    expect(visualWidth(cutVisual(styled, 2))).toBe(2);
    expect(cutVisual(styled, 2)).toContain("\x1b[36m");
  });

  it("padAnsi pads to exact visual width", () => {
    expect(visualWidth(padAnsi("雾", 6))).toBe(6);
    expect(visualWidth(padAnsi("雾雨霜雪露晴", 4))).toBe(4); // truncates
    expect(visualWidth(padAnsi("\x1b[31mab\x1b[0m", 5))).toBe(5);
  });

  it("wrapPlain wraps CJK per glyph and latin per word", () => {
    expect(wrapPlain("雾雨霜雪", 4)).toEqual(["雾雨", "霜雪"]);
    expect(wrapPlain("alpha beta", 6)).toEqual(["alpha", "beta"]);
    expect(wrapPlain("", 10)).toEqual([""]);
    for (const ln of wrapPlain("混合 mixed 文本 with 中英 words", 10)) {
      expect(visualWidth(ln)).toBeLessThanOrEqual(10);
    }
  });

  it("wrapPlain hard-breaks unbroken monster tokens", () => {
    const lines = wrapPlain("a".repeat(25), 10);
    expect(lines.every((l) => visualWidth(l) <= 10)).toBe(true);
    expect(lines.join("")).toBe("a".repeat(25));
  });

  it("overlay puts top glyphs over base, fixed width", () => {
    const res = overlay("▁▁▁▁▁▁", "  ≋   ", 6);
    const plain = strip(res);
    expect(plain).toContain("≋");
    expect(plain).toContain("▁");
    expect(visualWidth(res)).toBe(6);
  });

  it("circled maps indices to ①②…", () => {
    expect(circled(0)).toBe("①");
    expect(circled(5)).toBe("⑥");
  });
});

describe("Screen diff renderer", () => {
  it("repaints only changed rows", () => {
    let buf = "";
    const out = { write: (s: string) => { buf += s; return true; } };
    const sc = new Screen(out);
    sc.flush(["aaa", "bbb", "ccc"], null);
    buf = "";
    sc.flush(["aaa", "BBB", "ccc"], null);
    expect(buf).toContain("BBB");
    expect(buf).not.toContain("aaa");
    expect(buf).not.toContain("ccc");
    expect(buf).toContain("\x1b[2;1H"); // row 2 repainted in place
  });

  it("clears rows that disappear when the frame shrinks", () => {
    let buf = "";
    const out = { write: (s: string) => { buf += s; return true; } };
    const sc = new Screen(out);
    sc.flush(["a", "b", "c"], null);
    buf = "";
    sc.flush(["a"], null);
    expect(buf).toContain("\x1b[2;1H\x1b[2K");
    expect(buf).toContain("\x1b[3;1H\x1b[2K");
  });
});

describe("mountainRow", () => {
  it("is deterministic and fills the width", () => {
    const a = mountainRow(40, 5);
    const b = mountainRow(40, 5);
    expect(a).toBe(b);
    expect(visualWidth(a)).toBe(40);
  });

  it("grows with the session", () => {
    const young = strip(mountainRow(60, 0));
    const old = strip(mountainRow(60, 30));
    const mass = (s: string) => [...s].reduce((n, c) => n + " ▁▂▃▄▅".indexOf(c), 0);
    expect(mass(old)).toBeGreaterThan(mass(young));
  });
});

describe("OrchState (multi-agent dynamics)", () => {
  const plan = [
    { id: "t1", assignedTo: "fog", description: "调研", allDeps: [] },
    { id: "t2", assignedTo: "rain", description: "起草", allDeps: ["t1"] },
  ];

  it("tracks plan → start → done with per-agent tallies", () => {
    const o = new OrchState();
    o.plan(plan);
    expect(o.progress()).toEqual({ done: 0, total: 2 });
    o.start("t1");
    expect(o.runningAgents()).toEqual(["fog"]);
    expect(o.tally("fog").run).toBe(true);
    o.done("t1", true);
    expect(o.tally("fog")).toEqual({ ok: 1, fail: 0, run: false });
    o.start("t2");
    o.done("t2", false);
    expect(o.tally("rain").fail).toBe(1);
    expect(o.progress()).toEqual({ done: 2, total: 2 });
  });

  it("moves shuttles only while an agent is weaving", () => {
    const o = new OrchState();
    o.plan(plan);
    o.start("t1");
    expect(o.shuttleX.has("fog")).toBe(true);
    o.done("t1", true);
    expect(o.shuttleX.has("fog")).toBe(false);
  });
});

/** Headless LoomUI on a fake 80×24 terminal. */
function makeUI(cols = 80, rows = 24) {
  const out = { columns: cols, rows, isTTY: false, write: (_: string) => true };
  const ui = new LoomUI({ out, inp: null, headless: true });
  ui.start();
  return ui;
}

describe("LoomUI frame composition", () => {
  it("every row is exactly terminal width; frame is exactly terminal height", () => {
    const ui = makeUI(80, 24);
    ui.text("你好，世界。Hello world.");
    ui.line("a styled line");
    const frame = ui.paint();
    expect(frame.length).toBe(24);
    for (const row of frame) expect(visualWidth(row)).toBe(80);
  });

  it("streams into the open block and shows the agent header", () => {
    const ui = makeUI();
    ui.beginStream("rain");
    ui.streamWrite("江南可采莲，");
    ui.streamWrite("莲叶何田田。");
    const frame = ui.paint().map(strip).join("\n");
    expect(frame).toContain("雨");
    expect(frame).toContain("江南可采莲，莲叶何田田。");
    ui.endStream();
    for (const row of ui.paint()) expect(visualWidth(row)).toBe(80);
  });

  it("renders the weave chart and rail badges during orchestration", () => {
    const ui = makeUI(100, 30);
    ui.orch.plan([
      { id: "t1", assignedTo: "fog", description: "调研竞品", allDeps: [] },
      { id: "t2", assignedTo: "frost", description: "审校", allDeps: ["t1"] },
    ]);
    ui.orch.start("t1");
    ui.line(" ≋ ① 霧 调研竞品", "task-t1");
    ui.line(" · ② 霜 审校 ←①", "task-t2");
    const frame = ui.paint();
    expect(frame.length).toBe(30);
    for (const row of frame) expect(visualWidth(row)).toBe(100);
    const text = frame.map(strip).join("\n");
    expect(text).toContain("调研竞品");
    expect(text).toContain("①");
  });

  it("updates line blocks in place by id", () => {
    const ui = makeUI();
    ui.line("· task running", "task-x");
    ui.update("task-x", "✓ task done");
    const text = ui.paint().map(strip).join("\n");
    expect(text).toContain("✓ task done");
    expect(text).not.toContain("task running");
  });

  it("falls back to a notice on tiny terminals", () => {
    const ui = makeUI(40, 8);
    const frame = ui.paint();
    expect(strip(frame[0])).toContain("窗口太小");
  });

  it("survives many turns and long text without width drift", () => {
    const ui = makeUI(72, 20);
    for (let i = 0; i < 50; i++) {
      ui.text(`第 ${i} 轮：混排 latin text 和中文，外加长串 ${"x".repeat(90)}`);
      ui.turns++;
    }
    for (const row of ui.paint()) expect(visualWidth(row)).toBe(72);
  });
});

describe("palette ↑↓ navigation + Enter execution", () => {
  function key(ui: any, name: string, opts: Record<string, any> = {}) {
    ui.onKey(opts.str ?? "", { name, ...opts });
  }
  function type(ui: any, text: string) {
    for (const ch of text) ui.onKey(ch, { name: ch });
  }

  it("Enter runs the ↑↓-highlighted command", async () => {
    const ui = makeUI() as any;
    const p = ui.readInput();
    type(ui, "/");
    key(ui, "down"); // /fog → /rain
    key(ui, "down"); // /rain → /frost
    key(ui, "return");
    expect(await p).toBe("/frost");
  });

  it("selection can scroll past the visible window", () => {
    const ui = makeUI() as any;
    type(ui, "/");
    const total = ui.paletteMatches().length;
    for (let i = 0; i < total + 5; i++) key(ui, "down");
    expect(ui.paletteIdx).toBe(total - 1); // clamped to last, beyond first 8
    expect(total).toBeGreaterThan(8);
    for (const row of ui.paint()) expect(visualWidth(row)).toBe(80);
  });

  it("argument-taking commands fill the input instead of submitting", () => {
    const ui = makeUI() as any;
    let resolved: string | null = null;
    ui.readInput().then((s: string) => { resolved = s; });
    type(ui, "/task");
    key(ui, "return");
    expect(ui.inputGlyphs.join("")).toBe("/task ");
    expect(resolved).toBeNull(); // not submitted — waiting for arguments
  });

  it("typing resets the selection; Esc closes the palette", () => {
    const ui = makeUI() as any;
    type(ui, "/");
    key(ui, "down");
    expect(ui.paletteIdx).toBe(1);
    type(ui, "c"); // filter change
    expect(ui.paletteIdx).toBe(0);
    key(ui, "escape");
    expect(ui.inputGlyphs.length).toBe(0);
  });
});

describe("mouse wheel scrolling", () => {
  // Replay an SGR mouse sequence the way Node's keypress parser fragments it:
  // ESC[< as one event, then every remaining char separately.
  function wheel(ui: any, code: number) {
    ui.onKey("", { sequence: "\x1b[<" });
    for (const ch of `${code};10;5M`) ui.onKey(ch, { name: ch });
  }
  // Fill the viewport past one screen so there is something to scroll through.
  function fillUI() {
    const out = { columns: 80, rows: 24, isTTY: false, write: (_: string) => true };
    const ui = new LoomUI({ out, inp: null, headless: true }) as any;
    ui.start();
    for (let i = 0; i < 60; i++) ui.line(`line ${i}`);
    return ui;
  }

  it("wheel up scrolls into history, wheel down returns toward the tail", () => {
    const ui = fillUI();
    expect(ui.scrollOff).toBe(0);
    wheel(ui, 64); // wheel up
    expect(ui.scrollOff).toBeGreaterThan(0);
    const up = ui.scrollOff;
    wheel(ui, 65); // wheel down
    expect(ui.scrollOff).toBeLessThan(up);
  });

  it("mouse fragments never leak into the input line", () => {
    const ui = fillUI();
    wheel(ui, 64);
    wheel(ui, 65);
    // A click (button 0) must also be swallowed whole, not typed.
    ui.onKey("", { sequence: "\x1b[<" });
    for (const ch of "0;3;4M") ui.onKey(ch, { name: ch });
    expect(ui.inputGlyphs.join("")).toBe("");
  });

  it("does not yank a scrolled-up reader to the tail on new content", () => {
    const ui = fillUI();
    wheel(ui, 64);
    wheel(ui, 64);
    const before = ui.scrollOff;
    expect(before).toBeGreaterThan(0);
    ui.line("a fresh tool event arrives");
    ui.blank();
    expect(ui.scrollOff).toBe(before); // position preserved
  });

  it("submitting a turn snaps back to the tail", async () => {
    const ui = fillUI();
    wheel(ui, 64);
    expect(ui.scrollOff).toBeGreaterThan(0);
    const p = ui.readInput();
    for (const ch of "hi") ui.onKey(ch, { name: ch });
    ui.onKey("", { name: "return" });
    await p;
    expect(ui.scrollOff).toBe(0);
  });
});
