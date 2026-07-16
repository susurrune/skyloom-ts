/**
 * Structured logging for Skyloom.
 *
 * Usage:
 *   const log = getLogger("fog");
 *   log.info("chat_request", { userMessage: "hello", agent: "fog" });
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Where log lines go. Defaults to stderr. In a full-screen TUI, stderr writes
 * paint over the rendered frame (the "乱码" garbling), so the interactive UIs
 * redirect logs to a file via setLogFile() instead.
 */
export type LogSink = (line: string) => void;
let logSink: LogSink = (line) => { try { process.stderr.write(line); } catch { /* ignore */ } };

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|apiKey|token|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|secret|client[_-]?secret|clientSecret|password|passwd|credential|credentials)$/i;

function redactString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:~-]+/gi, '$1 [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
}

/** Send all logs to `fn` instead of stderr. */
export function setLogSink(fn: LogSink): void { logSink = fn; }

/** Drop all log output (e.g. piped/headless contexts that want a clean stream). */
export function silenceLogs(): void { logSink = () => { /* discard */ }; }

/**
 * Route logs to a file (appended), keeping them off the terminal so they can't
 * corrupt an interactive TUI. Falls back to silencing if the file can't open.
 */
export function setLogFile(filePath?: string): string | null {
  const target = filePath
    ? (filePath.startsWith("~") ? path.join(os.homedir(), filePath.slice(1)) : filePath)
    : path.join(os.homedir(), ".skyloom", "skyloom.log");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, "a", 0o600);
    try { fs.chmodSync(target, 0o600); } catch { /* best effort on Windows */ }
    logSink = (line) => { try { fs.writeSync(fd, line); } catch { /* ignore */ } };
    return target;
  } catch {
    silenceLogs();
    return null;
  }
}

export interface LogEntry {
  ts: string;
  level: string;
  logger: string;
  msg: string;
  request_id?: string;
  [key: string]: unknown;
}

/**
 * Logger instance for structured logging
 */
export class Logger {
  private name: string;
  private minLevel: LogLevel;

  constructor(name: string, minLevel: LogLevel = LogLevel.INFO) {
    this.name = name;
    this.minLevel = minLevel;
  }

  private formatEntry(
    levelName: string,
    msg: string,
    extra?: Record<string, unknown>
  ): LogEntry {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level: levelName.toLowerCase(),
      logger: this.name,
      msg,
      ...extra,
    };

    return entry;
  }

  private output(level: LogLevel, levelName: string, msg: string, extra?: Record<string, unknown>) {
    if (level < this.minLevel) return;

    const entry = this.formatEntry(levelName, msg, extra);
    const seen = new WeakSet<object>();
    const line = JSON.stringify(entry, (key, value) => {
      if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
      if (value instanceof Error) {
        return {
          name: value.name,
          message: redactString(value.message),
          stack: value.stack ? redactString(value.stack) : undefined,
        };
      }
      if (typeof value === "string") return redactString(value);
      if (typeof value === "bigint") return value.toString();
      if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });

    // Route through the configured sink (stderr by default; a file in TUI mode
    // so log lines never paint over the rendered frame).
    try { logSink(line + "\n"); } catch { /* logging must never break runtime work */ }
  }

  debug(msg: string, extra?: Record<string, unknown>) {
    this.output(LogLevel.DEBUG, "DEBUG", msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>) {
    this.output(LogLevel.INFO, "INFO", msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>) {
    this.output(LogLevel.WARN, "WARN", msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>) {
    this.output(LogLevel.ERROR, "ERROR", msg, extra);
  }

  setLevel(level: LogLevel) {
    this.minLevel = level;
  }
}

/**
 * Global logger instances
 */
const loggers = new Map<string, Logger>();
let requestId: string | null = null;
let defaultLogLevel = LogLevel.WARN; // Only warnings+errors by default

/**
 * Get or create a logger for a component
 */
export function getLogger(name: string): Logger {
  if (!loggers.has(name)) {
    loggers.set(name, new Logger(name, defaultLogLevel));
  }
  return loggers.get(name)!;
}

/**
 * Set the global request ID for tracing
 */
export function setRequestId(id: string | null) {
  requestId = id;
}

/**
 * Get the current request ID
 */
export function getRequestId(): string | null {
  return requestId;
}

/**
 * Set the global default log level
 */
export function setDefaultLogLevel(level: LogLevel) {
  defaultLogLevel = level;
  loggers.forEach((logger) => {
    logger.setLevel(level);
  });
}

/**
 * Get the current default log level
 */
export function getDefaultLogLevel(): LogLevel {
  return defaultLogLevel;
}
