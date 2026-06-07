#!/usr/bin/env node
/**
 * Post-install hook — runs `npm link` so `sky` is globally available.
 * Silently skipped on CI or when permissions are insufficient.
 */
if (process.env.CI || process.env.NODE_ENV === "production") process.exit(0);
const { execSync } = require("child_process");
try {
  execSync("npm link", { stdio: "pipe", encoding: "utf-8", timeout: 10000 });
} catch (_) {}
