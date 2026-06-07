#!/usr/bin/env node
/**
 * Post-install hook — tries `npm link` so `sky` is globally available.
 * Silently ignored on CI or when permissions are insufficient.
 */
try {
  require("child_process").execSync("npm link", { stdio: "pipe", encoding: "utf-8" });
} catch (_) { /* not fatal */ }
