/**
 * Design tokens — single source of truth for Skyloom's "水墨气象台" identity.
 *
 * One definition drives every surface: CLI (chalk truecolor), the full-screen
 * TUI, and the Web ink-wash UI. Change a pigment here and all three follow.
 *
 * Design rationale: docs/AESTHETIC_DESIGN.md
 */

/** Base paper-and-ink palette (hex). */
export const PALETTE = {
  paper: "#f8f4ec",
  paperWarm: "#f3ede2",
  inkDeep: "#1a1614",
  inkMid: "#3d3833",
  inkLight: "#8c8680",
  inkFaint: "#c4bfb8",
} as const;

/** Per-agent identity: weather + mineral pigment + classical poem + motion. */
export interface AgentTheme {
  /** Agent key (fog/rain/…). */
  name: string;
  /** Weather kanji used as a seal stamp (霧/雨/…). */
  kanji: string;
  /** Single-glyph weather symbol used across CLI/TUI/Web. */
  symbol: string;
  /** Mineral pigment hex. */
  hex: string;
  /** Mineral pigment RGB triple (for ANSI truecolor / CSS rgba). */
  rgb: [number, number, number];
  /** Pigment name in Chinese (松烟墨/石青/…). */
  pigment: string;
  /** Responsibility (探索洞察/创造产出/…). */
  specialty: string;
  /** Classical poem line shown in empty states / sidebars. */
  poem: string;
  /** Motion keyword (drift/fall/glint/float/bead/rise). */
  motion: string;
}

function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const AGENT_THEMES: Record<string, AgentTheme> = {
  fog: { name: "fog", kanji: "霧", symbol: "≋", hex: "#4a4a44", rgb: rgbOf("#4a4a44"), pigment: "松烟墨", specialty: "探索洞察", poem: "山色有无中", motion: "drift" },
  rain: { name: "rain", kanji: "雨", symbol: "⸽", hex: "#2a5c8a", rgb: rgbOf("#2a5c8a"), pigment: "石青", specialty: "创造产出", poem: "一蓑烟雨任平生", motion: "fall" },
  frost: { name: "frost", kanji: "霜", symbol: "✱", hex: "#3a7a6e", rgb: rgbOf("#3a7a6e"), pigment: "石绿", specialty: "精炼品质", poem: "月落乌啼霜满天", motion: "glint" },
  snow: { name: "snow", kanji: "雪", symbol: "❉", hex: "#8a8a82", rgb: rgbOf("#8a8a82"), pigment: "铅白", specialty: "架构规划", poem: "千树万树梨花开", motion: "float" },
  dew: { name: "dew", kanji: "露", symbol: "∘", hex: "#8b6914", rgb: rgbOf("#8b6914"), pigment: "赭石", specialty: "可靠守护", poem: "金风玉露一相逢", motion: "bead" },
  fair: { name: "fair", kanji: "晴", symbol: "☼", hex: "#b3342d", rgb: rgbOf("#b3342d"), pigment: "朱砂", specialty: "情感陪伴", poem: "道是无晴却有晴", motion: "rise" },
};

/** Ordered agent keys (織機 six shuttles). */
export const AGENT_ORDER = ["fog", "rain", "frost", "snow", "dew", "fair"] as const;

/** Brand seal pigment (朱砂) — used for the active-agent stamp everywhere. */
export const SEAL_HEX = AGENT_THEMES.fair.hex;

/** Look up an agent theme, defaulting to fog. */
export function agentTheme(name: string): AgentTheme {
  return AGENT_THEMES[name] ?? AGENT_THEMES.fog;
}
