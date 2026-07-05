/**
 * Skyloom ink-wash Web UI resource assembly.
 *
 * The browser surface is intentionally split into static assets:
 * - src/web/ui/index.html — semantic shell
 * - src/web/ui/styles.css — ink-wash visual system
 * - src/web/ui/app.ts — browser client serialized for /ui/app.js
 * - src/web/ui/assets/* — brand marks and share assets
 *
 * This module keeps the zero-dependency delivery model while making the Web UI
 * maintainable and driven by the shared core theme tokens.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as md from "./markdown";
import { AGENT_ORDER, AGENT_THEMES, PALETTE, type AgentTheme } from "../core/theme";
import { clientMain } from "./ui/app";

export interface AgentMeta {
  name: string;
  label: string;
  kanji: string;
  pig: string;
  sub: string;
  poem: string;
  light: string;
  dark: string;
  particles: "mist" | "rainfall" | "frostc" | "snowp" | "dewb" | "sunm";
  tips: string[];
}

const WEB_AGENT_EXTRAS: Record<string, {
  english: string;
  dark: string;
  particles: AgentMeta["particles"];
  tips: string[];
}> = {
  fog: {
    english: "Fog",
    dark: "#a8a294",
    particles: "mist",
    tips: ["帮我调研一下这个技术选型", "解释一下这段代码在做什么", "对比这两种方案的取舍"],
  },
  rain: {
    english: "Rain",
    dark: "#6ea6dc",
    particles: "rainfall",
    tips: ["写一个解析 CSV 的工具函数", "实现一个防抖 Hook", "把这段逻辑重构得更清晰"],
  },
  frost: {
    english: "Frost",
    dark: "#67c2af",
    particles: "frostc",
    tips: ["审查这段代码有什么问题", "找出这个函数的潜在 bug", "这段实现还能怎么优化"],
  },
  snow: {
    english: "Snow",
    dark: "#b6b6aa",
    particles: "snowp",
    tips: ["帮我规划这个项目的里程碑", "设计一个清晰的模块边界", "把这个大任务拆成步骤"],
  },
  dew: {
    english: "Dew",
    dark: "#d2a83e",
    particles: "dewb",
    tips: ["排查一下这个部署报错", "写一份 CI 工作流配置", "这个服务怎么做健康检查"],
  },
  fair: {
    english: "Fair",
    dark: "#e0635a",
    particles: "sunm",
    tips: ["今天有点累，陪我聊聊", "讲一个温柔的小故事", "给我一点出发的勇气"],
  },
};

function toAgentMeta(theme: AgentTheme): AgentMeta {
  const extra = WEB_AGENT_EXTRAS[theme.name] ?? WEB_AGENT_EXTRAS.fog;
  return {
    name: theme.name,
    label: `${theme.kanji} ${extra.english}`,
    kanji: theme.kanji,
    pig: theme.pigment,
    sub: theme.specialty,
    poem: theme.poem,
    light: theme.hex,
    dark: extra.dark,
    particles: extra.particles,
    tips: extra.tips,
  };
}

export const AGENTS_META: AgentMeta[] = AGENT_ORDER.map((name) => toAgentMeta(AGENT_THEMES[name]));

export const SKYLOOM_FAVICON_PNG = readWebAssetBuffer("assets/image2-favicon.png");

const CACHE_BUST = "art-v2";

function assetCandidates(relativePath: string): string[] {
  return [
    join(__dirname, "ui", relativePath),
    join(process.cwd(), "src", "web", "ui", relativePath),
  ];
}

export function readWebAsset(relativePath: string): string {
  for (const candidate of assetCandidates(relativePath)) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`Web UI asset not found: ${relativePath}`);
}

export function readWebAssetBuffer(relativePath: string): Buffer {
  for (const candidate of assetCandidates(relativePath)) {
    if (existsSync(candidate)) return readFileSync(candidate);
  }
  throw new Error(`Web UI asset not found: ${relativePath}`);
}

export function renderInkWashCSS(): string {
  return readWebAsset("styles.css");
}

export function renderInkWashAppJS(): string {
  return [
    `window.__SKYLOOM_PALETTE__ = ${JSON.stringify(PALETTE)};`,
    md.escapeHtml.toString(),
    md.highlightCode.toString(),
    md.mdInline.toString(),
    md.mdToHtml.toString(),
    clientMain.toString(),
    "clientMain();",
  ].join("\n");
}

export function renderInkWashUI(): string {
  const boot = JSON.stringify({ agents: AGENTS_META });
  return readWebAsset("index.html")
    .replace(/\{\{CACHE_BUST\}\}/g, CACHE_BUST)
    .replace("{{BOOT}}", boot);
}
