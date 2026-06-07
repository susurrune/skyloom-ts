#!/usr/bin/env node
/**
 * Post-install hook — tries `npm link` so `sky` is globally available.
 * Silently ignored on CI, Docker, or when permissions are insufficient.
 */
if (process.env.CI || process.env.NODE_ENV === "production") process.exit(0);
try {
  require("child_process").execSync("npm link", { stdio: "pipe", encoding: "utf-8" });
} catch (_) { /* not fatal */ }
