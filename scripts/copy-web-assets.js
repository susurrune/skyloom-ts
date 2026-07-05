#!/usr/bin/env node

/**
 * tsc only emits JavaScript and declarations. Copy the Web UI template,
 * stylesheet, and SVG assets so the compiled CLI can serve them from dist/.
 */

const { cpSync, existsSync, mkdirSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const source = join(root, "src", "web", "ui");
const target = join(root, "dist", "web", "ui");

if (!existsSync(source)) {
  console.error(`Web UI source assets not found: ${source}`);
  process.exit(1);
}

mkdirSync(join(root, "dist", "web"), { recursive: true });
mkdirSync(target, { recursive: true });
cpSync(join(source, "index.html"), join(target, "index.html"));
cpSync(join(source, "styles.css"), join(target, "styles.css"));
cpSync(join(source, "assets"), join(target, "assets"), { recursive: true });
