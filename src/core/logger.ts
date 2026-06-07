/**
 * Structured logging for Skyloom.
 *
 * Usage:
 *   const log = getLogger("fog");
 *   log.info("chat_request", { userMessage: "hello", agent: "fog" });
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
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
    const line = JSON.stringify(entry, (_key, value) => {
      // Ensure dates are serializable
      if (value instanceof Date) {
        return value.toISOString();
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    });

    // Output to stderr for logs, stdout for normal output
    const output = level >= LogLevel.WARN ? console.error : console.log;
    output(line);
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
let defaultLogLevel = LogLevel.INFO;

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
