/**
 * Configuration of `bddb serve` / `bddb doctor`: `BDDB_*` environment variables (plan 3.5,
 * docs/configuration.md) overridden by CLI flags that mirror them one to one.
 *
 * Validation failures throw `ConfigError`; the CLI prints the message and exits 2.
 */
import { isLogLevel, type LogFormat, type LogLevel } from "./log.ts";

export interface Config {
  host: string;
  port: number;
  /** Normalised: empty, or `/prefix` with a leading slash and no trailing slash. */
  basePath: string;
  doltHost: string;
  doltPort: number;
  doltUser: string;
  doltPassword: string;
  /** `null` → auto-discovery. */
  databases: string[] | null;
  defaultDatabase: string | null;
  actor: string;
  pollIntervalMs: number;
  /** Closed issues newer than this many hours are in the board snapshot (1–720). */
  closedHours: number;
  bdPath: string;
  logLevel: LogLevel;
  logFormat: LogFormat;
  /** Pre-built SPA directory (`bun build src/web/index.html --outdir ...`); `null` → build from source at start. */
  webDir: string | null;
  /** Directory for the synthesized workspaces; default `$TMPDIR/bddb` or `os.tmpdir()/bddb`. */
  workDir: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Flag name (without `--`) → environment variable. Every serve/doctor flag is here. */
export const FLAG_ENV: Readonly<Record<string, string>> = {
  host: "BDDB_HOST",
  port: "BDDB_PORT",
  "base-path": "BDDB_BASE_PATH",
  "dolt-host": "BDDB_DOLT_HOST",
  "dolt-port": "BDDB_DOLT_PORT",
  "dolt-user": "BDDB_DOLT_USER",
  "dolt-password": "BDDB_DOLT_PASSWORD",
  databases: "BDDB_DATABASES",
  "default-database": "BDDB_DEFAULT_DATABASE",
  actor: "BDDB_ACTOR",
  "poll-interval": "BDDB_POLL_INTERVAL",
  "closed-hours": "BDDB_CLOSED_HOURS",
  "bd-path": "BDDB_BD_PATH",
  "log-level": "BDDB_LOG_LEVEL",
  "log-format": "BDDB_LOG_FORMAT",
  "web-dir": "BDDB_WEB_DIR",
  "work-dir": "BDDB_WORK_DIR",
};

export const DEFAULTS = {
  host: "0.0.0.0",
  port: 7331,
  basePath: "",
  doltHost: "host.docker.internal",
  doltPort: 3308,
  doltUser: "root",
  doltPassword: "",
  actor: "bddb",
  pollInterval: "15s",
  closedHours: 72,
  bdPath: "bd",
  logLevel: "info" as LogLevel,
  logFormat: "text" as LogFormat,
} as const;

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** `500ms`, `15s`, `2m`, `1h`, `1m30s`, or a bare number of seconds. */
export function parseDuration(text: string): number {
  const value = text.trim();
  if (value === "") throw new ConfigError("duration is empty");
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/gy;
  let total = 0;
  let index = 0;
  for (;;) {
    re.lastIndex = index;
    const m = re.exec(value);
    if (!m) break;
    total += Number(m[1]) * (DURATION_UNITS[m[2] ?? ""] ?? 0);
    index = re.lastIndex;
    if (index === value.length) return Math.round(total);
  }
  throw new ConfigError(
    `invalid duration ${JSON.stringify(text)} (expected e.g. 500ms, 15s, 2m, 1h)`,
  );
}

export interface ParsedArgs {
  flags: Record<string, string>;
  positionals: string[];
}

/**
 * Parse `--name value` / `--name=value` flags. Only names in `FLAG_ENV` (plus `help`) are
 * accepted; anything else is a `ConfigError`.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "help" || name === "h") {
      flags.help = "true";
      continue;
    }
    if (!Object.hasOwn(FLAG_ENV, name)) {
      throw new ConfigError(`unknown flag --${name} (see bddb help)`);
    }
    if (eq !== -1) {
      flags[name] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new ConfigError(`flag --${name} needs a value`);
      }
      flags[name] = next;
      i++;
    }
  }
  return { flags, positionals };
}

function intOf(name: string, text: string, min: number, max: number): number {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(
      `${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(text)}`,
    );
  }
  return n;
}

/** Normalise a base path: `beads`, `/beads/`, `/beads` → `/beads`; `/` or empty → ``. */
export function normalizeBasePath(text: string): string {
  let value = text.trim();
  if (value === "" || value === "/") return "";
  if (!value.startsWith("/")) value = `/${value}`;
  value = value.replace(/\/+$/, "");
  if (/[\s?#]/.test(value))
    throw new ConfigError(`base path may not contain whitespace, ? or #: ${JSON.stringify(text)}`);
  return value;
}

export function parseCsv(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const name = raw.trim();
    if (name === "") continue;
    if (!/^[A-Za-z0-9_$-]+$/.test(name)) {
      throw new ConfigError(`invalid database name ${JSON.stringify(name)} in BDDB_DATABASES`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export interface LoadConfigInput {
  env?: Readonly<Record<string, string | undefined>>;
  argv?: readonly string[];
}

/** Env + flags → validated `Config`. Flags win over env, env over defaults. */
export function loadConfig(input: LoadConfigInput = {}): Config {
  const env = input.env ?? process.env;
  const { flags } = parseArgs(input.argv ?? []);
  const pick = (flag: string): string | undefined => {
    const fromFlag = flags[flag];
    if (fromFlag !== undefined) return fromFlag;
    const fromEnv = env[FLAG_ENV[flag] ?? ""];
    return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
  };

  const logLevelText = pick("log-level") ?? DEFAULTS.logLevel;
  if (!isLogLevel(logLevelText)) {
    throw new ConfigError(
      `BDDB_LOG_LEVEL must be one of debug, info, warn, error; got ${JSON.stringify(logLevelText)}`,
    );
  }
  const logFormatText = pick("log-format") ?? DEFAULTS.logFormat;
  if (logFormatText !== "text" && logFormatText !== "json") {
    throw new ConfigError(
      `BDDB_LOG_FORMAT must be text or json; got ${JSON.stringify(logFormatText)}`,
    );
  }

  const databasesText = pick("databases");
  const databases = databasesText === undefined ? null : parseCsv(databasesText);
  if (databases !== null && databases.length === 0) {
    throw new ConfigError("BDDB_DATABASES is set but lists no database");
  }
  const defaultDatabase = pick("default-database") ?? null;
  if (defaultDatabase !== null && databases !== null && !databases.includes(defaultDatabase)) {
    throw new ConfigError(
      `BDDB_DEFAULT_DATABASE ${JSON.stringify(defaultDatabase)} is not in BDDB_DATABASES (${databases.join(", ")})`,
    );
  }

  const pollIntervalMs = parseDuration(pick("poll-interval") ?? DEFAULTS.pollInterval);
  if (pollIntervalMs < 1000) {
    throw new ConfigError(`BDDB_POLL_INTERVAL must be at least 1s, got ${pollIntervalMs}ms`);
  }

  const actor = (pick("actor") ?? DEFAULTS.actor).trim();
  if (actor === "" || /[\p{Cc}]/u.test(actor) || Buffer.byteLength(actor) > 256) {
    throw new ConfigError(
      "BDDB_ACTOR must be a non-empty string of at most 256 bytes without control characters",
    );
  }

  const doltHost = (pick("dolt-host") ?? DEFAULTS.doltHost).trim();
  if (doltHost === "") throw new ConfigError("BDDB_DOLT_HOST must not be empty");
  const host = (pick("host") ?? DEFAULTS.host).trim();
  if (host === "") throw new ConfigError("BDDB_HOST must not be empty");
  const bdPath = (pick("bd-path") ?? DEFAULTS.bdPath).trim();
  if (bdPath === "") throw new ConfigError("BDDB_BD_PATH must not be empty");

  return {
    host,
    port: intOf("BDDB_PORT", pick("port") ?? String(DEFAULTS.port), 1, 65535),
    basePath: normalizeBasePath(pick("base-path") ?? DEFAULTS.basePath),
    doltHost,
    doltPort: intOf("BDDB_DOLT_PORT", pick("dolt-port") ?? String(DEFAULTS.doltPort), 1, 65535),
    doltUser: pick("dolt-user") ?? DEFAULTS.doltUser,
    doltPassword: flags["dolt-password"] ?? env.BDDB_DOLT_PASSWORD ?? DEFAULTS.doltPassword,
    databases,
    defaultDatabase,
    actor,
    pollIntervalMs,
    closedHours: intOf(
      "BDDB_CLOSED_HOURS",
      pick("closed-hours") ?? String(DEFAULTS.closedHours),
      1,
      720,
    ),
    bdPath,
    logLevel: logLevelText,
    logFormat: logFormatText,
    webDir: pick("web-dir") ?? null,
    workDir: pick("work-dir") ?? null,
  };
}

/** Help text for the flags shared by `serve` and `doctor`. */
export const FLAGS_HELP = `Flags (each overrides the environment variable in brackets):
  --host ADDR              dashboard bind address           [BDDB_HOST=${DEFAULTS.host}]
  --port N                 dashboard port                   [BDDB_PORT=${DEFAULTS.port}]
  --base-path /prefix      path prefix behind a proxy       [BDDB_BASE_PATH=]
  --dolt-host HOST         your dolt sql-server host        [BDDB_DOLT_HOST=${DEFAULTS.doltHost}]
  --dolt-port N            dolt port                        [BDDB_DOLT_PORT=${DEFAULTS.doltPort}]
  --dolt-user USER         dolt MySQL user                  [BDDB_DOLT_USER=${DEFAULTS.doltUser}]
  --dolt-password PASS     dolt password                    [BDDB_DOLT_PASSWORD=]
  --databases a,b          databases to serve (CSV)         [BDDB_DATABASES= (auto-discovery)]
  --default-database NAME  project opened by default        [BDDB_DEFAULT_DATABASE= (largest)]
  --actor NAME             default actor for writes         [BDDB_ACTOR=${DEFAULTS.actor}]
  --poll-interval 15s      full re-read interval            [BDDB_POLL_INTERVAL=${DEFAULTS.pollInterval}]
  --closed-hours N         closed window on the board (h)   [BDDB_CLOSED_HOURS=${DEFAULTS.closedHours}]
  --bd-path PATH           bd binary                        [BDDB_BD_PATH=${DEFAULTS.bdPath}]
  --log-level LEVEL        debug|info|warn|error            [BDDB_LOG_LEVEL=${DEFAULTS.logLevel}]
  --log-format FMT         text|json                        [BDDB_LOG_FORMAT=${DEFAULTS.logFormat}]
  --web-dir DIR            pre-built SPA directory          [BDDB_WEB_DIR= (build from src/web)]
  --work-dir DIR           synthesized workspaces           [BDDB_WORK_DIR=$TMPDIR/bddb]`;
