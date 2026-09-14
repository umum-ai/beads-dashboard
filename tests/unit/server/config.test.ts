import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  DEFAULTS,
  loadConfig,
  normalizeBasePath,
  parseArgs,
  parseCsv,
  parseDuration,
} from "../../../src/server/config.ts";

const NO_ENV: Record<string, string | undefined> = {};

describe("parseDuration", () => {
  test("accepts ms, s, m, h and compound forms", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("15s")).toBe(15_000);
    expect(parseDuration("2m")).toBe(120_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1m30s")).toBe(90_000);
    expect(parseDuration("1.5s")).toBe(1500);
  });
  test("bare numbers are seconds", () => {
    expect(parseDuration("20")).toBe(20_000);
  });
  test("rejects garbage", () => {
    expect(() => parseDuration("soon")).toThrow(ConfigError);
    expect(() => parseDuration("")).toThrow(ConfigError);
    expect(() => parseDuration("5x")).toThrow(ConfigError);
  });
});

describe("parseArgs", () => {
  test("--name value and --name=value", () => {
    const parsed = parseArgs(["--port", "8080", "--dolt-host=db.local", "--help"]);
    expect(parsed.flags).toEqual({ port: "8080", "dolt-host": "db.local", help: "true" });
  });
  test("unknown flag and missing value are errors", () => {
    expect(() => parseArgs(["--nope", "1"])).toThrow(/unknown flag --nope/);
    expect(() => parseArgs(["--port"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--port", "--host"])).toThrow(/needs a value/);
  });
});

describe("normalizeBasePath / parseCsv", () => {
  test("base path forms", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("beads")).toBe("/beads");
    expect(normalizeBasePath("/beads/")).toBe("/beads");
    expect(normalizeBasePath("/a/b//")).toBe("/a/b");
    expect(() => normalizeBasePath("/a b")).toThrow(ConfigError);
  });
  test("csv dedupes, trims, validates", () => {
    expect(parseCsv(" shared, siam ,shared,")).toEqual(["shared", "siam"]);
    expect(() => parseCsv("a;b")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  test("defaults", () => {
    const cfg = loadConfig({ env: NO_ENV, argv: [] });
    expect(cfg.host).toBe(DEFAULTS.host);
    expect(cfg.port).toBe(7331);
    expect(cfg.basePath).toBe("");
    expect(cfg.doltHost).toBe("host.docker.internal");
    expect(cfg.doltPort).toBe(3308);
    expect(cfg.doltUser).toBe("root");
    expect(cfg.doltPassword).toBe("");
    expect(cfg.databases).toBeNull();
    expect(cfg.defaultDatabase).toBeNull();
    expect(cfg.actor).toBe("bddb");
    expect(cfg.pollIntervalMs).toBe(15_000);
    expect(cfg.closedDays).toBe(7);
    expect(cfg.bdPath).toBe("bd");
    expect(cfg.logLevel).toBe("info");
  });

  test("env is read, flags override env", () => {
    const env = {
      BDDB_PORT: "8000",
      BDDB_DOLT_PORT: "3399",
      BDDB_DATABASES: "kb,shared",
      BDDB_DEFAULT_DATABASE: "shared",
      BDDB_POLL_INTERVAL: "3s",
      BDDB_BASE_PATH: "beads",
      BDDB_LOG_LEVEL: "debug",
      BDDB_DOLT_PASSWORD: "secret",
    };
    const cfg = loadConfig({ env, argv: ["--port", "9000", "--closed-days=30"] });
    expect(cfg.port).toBe(9000);
    expect(cfg.doltPort).toBe(3399);
    expect(cfg.databases).toEqual(["kb", "shared"]);
    expect(cfg.defaultDatabase).toBe("shared");
    expect(cfg.pollIntervalMs).toBe(3000);
    expect(cfg.basePath).toBe("/beads");
    expect(cfg.closedDays).toBe(30);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.doltPassword).toBe("secret");
  });

  test("validation errors are ConfigError with a clear message", () => {
    expect(() => loadConfig({ env: { BDDB_PORT: "70000" } })).toThrow(/BDDB_PORT/);
    expect(() => loadConfig({ env: { BDDB_POLL_INTERVAL: "100ms" } })).toThrow(/at least 1s/);
    expect(() => loadConfig({ env: { BDDB_LOG_LEVEL: "loud" } })).toThrow(/BDDB_LOG_LEVEL/);
    expect(() => loadConfig({ env: { BDDB_DATABASES: " , " } })).toThrow(/lists no database/);
    expect(() =>
      loadConfig({ env: { BDDB_DATABASES: "a,b", BDDB_DEFAULT_DATABASE: "c" } }),
    ).toThrow(/not in BDDB_DATABASES/);
    const bell = String.fromCharCode(7);
    expect(() => loadConfig({ env: { BDDB_ACTOR: `bad${bell}actor` } })).toThrow(/BDDB_ACTOR/);
    expect(() => loadConfig({ env: NO_ENV, argv: ["--bogus", "1"] })).toThrow(ConfigError);
  });
});
