/**
 * Database discovery over the MySQL protocol (`Bun.SQL`), the only place bddb talks to dolt
 * directly. Everything about issues goes through `bd serve`.
 *
 * Rules (plan 3.1): `BDDB_DATABASES` when set (each must exist); otherwise `SHOW DATABASES`
 * minus `information_schema`, `mysql`, `dolt`, keeping the databases that have an `issues`
 * table. Every selected database is then counted (`SELECT COUNT(*) FROM <db>.issues`): the
 * auto-discovered list is ordered by that count, largest first, `beads_global` last; an explicit
 * list keeps the operator's order. The default database (when `BDDB_DEFAULT_DATABASE` is unset)
 * is the largest one either way. An empty result is an error with hints.
 */
import type { Config } from "./config.ts";

/** The alphabet `parseCsv` accepts for `BDDB_DATABASES`; asserted before a name is interpolated. */
export const DATABASE_NAME_RE = /^[A-Za-z0-9_$-]+$/;

export const SYSTEM_DATABASES: ReadonlySet<string> = new Set([
  "information_schema",
  "mysql",
  "dolt",
]);
export const GLOBAL_DATABASE = "beads_global";

export class DiscoveryError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = "DiscoveryError";
    this.hints = hints;
  }
}

/** The three queries discovery needs; a fake implements them in unit tests. */
export interface DoltProbe {
  showDatabases(): Promise<string[]>;
  /** Names of databases that contain a table called `issues`. */
  databasesWithIssuesTable(): Promise<string[]>;
  /** Rows in `<database>.issues`. */
  countIssues(database: string): Promise<number>;
  close(): Promise<void>;
}

/** A served database as discovery reports it: its name and the size of its `issues` table. */
export interface DiscoveredDatabase {
  name: string;
  /** `SELECT COUNT(*) FROM <db>.issues` at discovery time (startup). */
  issueCount: number;
}

export interface DoltConnection {
  host: string;
  port: number;
  user: string;
  password: string;
}

export function doltConnection(cfg: Config): DoltConnection {
  return { host: cfg.doltHost, port: cfg.doltPort, user: cfg.doltUser, password: cfg.doltPassword };
}

/** `Bun.SQL`-backed probe. Connection failures surface as thrown errors from the queries. */
export function createDoltProbe(conn: DoltConnection, timeoutSeconds = 5): DoltProbe {
  const sql = new Bun.SQL({
    adapter: "mysql",
    hostname: conn.host,
    port: conn.port,
    username: conn.user,
    password: conn.password,
    max: 1,
    connectionTimeout: timeoutSeconds,
  });
  return {
    async showDatabases() {
      const rows = (await sql`SHOW DATABASES`) as Record<string, unknown>[];
      return rows.map((row) => String(Object.values(row)[0] ?? "")).filter((n) => n !== "");
    },
    async databasesWithIssuesTable() {
      const rows = (await sql`
        SELECT table_schema AS db FROM information_schema.tables WHERE table_name = 'issues'
      `) as { db: string }[];
      return [...new Set(rows.map((r) => r.db))];
    },
    async countIssues(database) {
      // The name is interpolated as an identifier: refuse anything outside the validated alphabet.
      if (!DATABASE_NAME_RE.test(database)) {
        throw new DiscoveryError(
          `refusing to count issues of database ${JSON.stringify(database)}: invalid name`,
        );
      }
      const rows = (await sql.unsafe(`SELECT COUNT(*) AS n FROM \`${database}\`.issues`)) as {
        n: number | bigint | string;
      }[];
      return Number(rows[0]?.n ?? 0);
    },
    async close() {
      await sql.close();
    },
  };
}

/** `beads_global` goes last; everything else keeps the server's order. */
export function orderDatabases(names: readonly string[]): string[] {
  const rest = names.filter((n) => n !== GLOBAL_DATABASE);
  return names.includes(GLOBAL_DATABASE) ? [...rest, GLOBAL_DATABASE] : rest;
}

/**
 * Largest `issues` table first (ties keep the given order), `beads_global` last regardless of
 * its size. Pure; orders the auto-discovered list and picks the default database.
 */
export function rankDatabases(databases: readonly DiscoveredDatabase[]): DiscoveredDatabase[] {
  const rest = databases.filter((d) => d.name !== GLOBAL_DATABASE);
  const global = databases.filter((d) => d.name === GLOBAL_DATABASE);
  // Array.prototype.sort is stable: equal counts keep their order.
  const ranked = [...rest].sort((a, b) => b.issueCount - a.issueCount);
  return [...ranked, ...global];
}

/**
 * `BDDB_DEFAULT_DATABASE` when set (it must be served), else the largest database — the first
 * of `rankDatabases`, so `beads_global` is the default only when it is the only database.
 */
export function pickDefaultDatabase(
  databases: readonly DiscoveredDatabase[],
  configured: string | null,
): string {
  if (configured !== null) {
    if (!databases.some((d) => d.name === configured)) {
      throw new DiscoveryError(
        `BDDB_DEFAULT_DATABASE ${JSON.stringify(configured)} is not among the served databases`,
        [`databases: ${databases.map((d) => d.name).join(", ")}`],
      );
    }
    return configured;
  }
  const first = rankDatabases(databases)[0];
  if (!first) throw new DiscoveryError("no database to serve");
  return first.name;
}

/** `shared (312), siam (75), beads_global (3)` — the startup log line and `bddb doctor`. */
export function describeDatabases(databases: readonly DiscoveredDatabase[]): string {
  return databases.map((d) => `${d.name} (${d.issueCount})`).join(", ");
}

/**
 * Pure selection step. `all` = `SHOW DATABASES`; `withIssues` = databases owning an `issues`
 * table; `requested` = `BDDB_DATABASES` or `null` for auto-discovery.
 */
export function selectDatabases(
  all: readonly string[],
  withIssues: readonly string[],
  requested: readonly string[] | null,
): string[] {
  const candidates = all.filter((n) => !SYSTEM_DATABASES.has(n));
  if (requested !== null) {
    const missing = requested.filter((n) => !all.includes(n));
    if (missing.length > 0) {
      throw new DiscoveryError(
        `BDDB_DATABASES names ${missing.length === 1 ? "a database that does" : "databases that do"} not exist on the dolt server: ${missing.join(", ")}`,
        [`databases present: ${candidates.length > 0 ? candidates.join(", ") : "(none)"}`],
      );
    }
    const noIssues = requested.filter((n) => !withIssues.includes(n));
    if (noIssues.length > 0) {
      throw new DiscoveryError(
        `BDDB_DATABASES names ${noIssues.length === 1 ? "a database" : "databases"} without an \`issues\` table (not a beads database?): ${noIssues.join(", ")}`,
        [
          `beads databases present: ${candidates.filter((n) => withIssues.includes(n)).join(", ") || "(none)"}`,
        ],
      );
    }
    return [...requested];
  }
  const found = orderDatabases(candidates.filter((n) => withIssues.includes(n)));
  if (found.length === 0) {
    throw new DiscoveryError("no beads database found on the dolt server", [
      candidates.length > 0
        ? `databases present but without an \`issues\` table: ${candidates.join(", ")}`
        : "the server has no user databases at all",
      "is this the right dolt? check BDDB_DOLT_HOST / BDDB_DOLT_PORT (shared-server default: 3308)",
      "a beads workspace must have been initialised in server mode against it (`bd init --server` / `--shared-server`)",
      "or list databases explicitly with BDDB_DATABASES=name1,name2",
    ]);
  }
  return found;
}

export interface DiscoverOptions {
  probe?: DoltProbe;
  requested: readonly string[] | null;
  connection: DoltConnection;
}

const CONNECTION_HINTS = [
  "is `dolt sql-server` running and reachable from here? (try `bddb doctor`)",
  "from a container the host's dolt must listen on 0.0.0.0 (`listener.host` in dolt-server-config.yaml) or use `--network host`",
  "check BDDB_DOLT_USER / BDDB_DOLT_PASSWORD",
];

/**
 * Connect, select, count, close. Connection errors become `DiscoveryError` with hints. The
 * result is ordered largest first (`beads_global` last) for auto-discovery, and in the
 * operator's order for `BDDB_DATABASES`.
 */
export async function discoverDatabases(options: DiscoverOptions): Promise<DiscoveredDatabase[]> {
  const probe = options.probe ?? createDoltProbe(options.connection);
  const where = `${options.connection.host}:${options.connection.port}`;
  try {
    let all: string[];
    let withIssues: string[];
    try {
      all = await probe.showDatabases();
      withIssues = await probe.databasesWithIssuesTable();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DiscoveryError(
        `cannot query dolt at ${where} as ${options.connection.user}: ${message}`,
        CONNECTION_HINTS,
      );
    }
    const names = selectDatabases(all, withIssues, options.requested);
    const counted: DiscoveredDatabase[] = [];
    for (const name of names) {
      try {
        counted.push({ name, issueCount: await probe.countIssues(name) });
      } catch (err) {
        if (err instanceof DiscoveryError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new DiscoveryError(
          `cannot count issues of database ${name} on dolt at ${where}: ${message}`,
          CONNECTION_HINTS,
        );
      }
    }
    return options.requested !== null ? counted : rankDatabases(counted);
  } finally {
    await probe.close().catch(() => {});
  }
}

/** Plain TCP reachability check (doctor, 503 watchdog). */
export async function tcpReachable(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.end();
          done(true);
        },
        data() {},
        error() {
          done(false);
        },
        connectError() {
          done(false);
        },
        close() {},
      },
    }).catch(() => done(false));
  });
}
