/**
 * Small leveled logger. `text` format for humans (default), `json` for log collectors.
 * Levels: debug < info < warn < error. `child(prefix)` prefixes every message.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "text" | "json";

export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(prefix: string): Logger;
  enabled(level: LogLevel): boolean;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Where lines go; defaults to `process.stderr`. Tests pass an array collector. */
  sink?: (line: string) => void;
  now?: () => Date;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text =
      typeof value === "string"
        ? /[\s"=]/.test(value)
          ? JSON.stringify(value)
          : value
        : value instanceof Error
          ? JSON.stringify(value.message)
          : JSON.stringify(value);
    parts.push(`${key}=${text}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function serializeError(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "text";
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  function make(prefix: string): Logger {
    const emit = (lvl: LogLevel, message: string, fields?: LogFields) => {
      if (RANK[lvl] < RANK[level]) return;
      const ts = now().toISOString();
      if (format === "json") {
        const record: LogFields = { ts, level: lvl, msg: message };
        if (prefix) record.component = prefix;
        for (const [k, v] of Object.entries(fields ?? {})) record[k] = serializeError(v);
        sink(JSON.stringify(record));
        return;
      }
      const head = prefix ? `${prefix} ` : "";
      sink(`${ts} ${lvl.toUpperCase().padEnd(5)} ${head}${message}${formatFields(fields)}`);
    };
    return {
      level,
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (p) => make(prefix ? `${prefix} ${p}` : p),
      enabled: (lvl) => RANK[lvl] >= RANK[level],
    };
  }
  return make("");
}

/** A logger that drops everything (tests, `bddb version`). */
export const silentLogger: Logger = createLogger({ level: "error", sink: () => {} });
