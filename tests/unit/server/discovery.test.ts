import { describe, expect, test } from "bun:test";
import {
  createDoltProbe,
  DATABASE_NAME_RE,
  type DiscoveredDatabase,
  DiscoveryError,
  type DoltProbe,
  describeDatabases,
  discoverDatabases,
  orderDatabases,
  pickDefaultDatabase,
  rankDatabases,
  selectDatabases,
} from "../../../src/server/discovery.ts";

const ALL = ["beads_global", "dolt", "information_schema", "mysql", "probe", "shared", "siam"];
const WITH_ISSUES = ["beads_global", "shared", "siam"];

describe("selectDatabases", () => {
  test("auto-discovery drops system databases and those without an issues table, beads_global last", () => {
    expect(selectDatabases(ALL, WITH_ISSUES, null)).toEqual(["shared", "siam", "beads_global"]);
  });
  test("orderDatabases keeps order otherwise", () => {
    expect(orderDatabases(["b", "beads_global", "a"])).toEqual(["b", "a", "beads_global"]);
    expect(orderDatabases(["b", "a"])).toEqual(["b", "a"]);
  });
  test("explicit list is kept in the given order and validated", () => {
    expect(selectDatabases(ALL, WITH_ISSUES, ["siam", "shared"])).toEqual(["siam", "shared"]);
  });
  test("explicit list with a missing database lists what exists", () => {
    let err: unknown;
    try {
      selectDatabases(ALL, WITH_ISSUES, ["shared", "nope"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DiscoveryError);
    const d = err as DiscoveryError;
    expect(d.message).toContain("nope");
    expect(d.hints.join("\n")).toContain("shared");
    expect(d.hints.join("\n")).not.toContain("information_schema");
  });
  test("explicit database without an issues table is refused", () => {
    expect(() => selectDatabases(ALL, WITH_ISSUES, ["probe"])).toThrow(/issues/);
  });
  test("empty auto-discovery gives hints", () => {
    let err: DiscoveryError | undefined;
    try {
      selectDatabases(["information_schema", "mysql", "probe"], [], null);
    } catch (e) {
      err = e as DiscoveryError;
    }
    expect(err?.message).toMatch(/no beads database/);
    expect(err?.hints.join("\n")).toMatch(/BDDB_DOLT_HOST/);
    expect(err?.hints.join("\n")).toMatch(/bd init --server/);
    expect(err?.hints.join("\n")).toMatch(/BDDB_DATABASES/);
  });
});

describe("rankDatabases / pickDefaultDatabase", () => {
  const list: DiscoveredDatabase[] = [
    { name: "siam", issueCount: 75 },
    { name: "beads_global", issueCount: 900 },
    { name: "shared", issueCount: 312 },
    { name: "probe", issueCount: 75 },
  ];
  test("largest first, ties keep their order, beads_global last whatever its size", () => {
    expect(rankDatabases(list).map((d) => d.name)).toEqual([
      "shared",
      "siam",
      "probe",
      "beads_global",
    ]);
    expect(rankDatabases([])).toEqual([]);
  });
  test("default is the largest unless configured", () => {
    expect(pickDefaultDatabase(list, null)).toBe("shared");
    expect(pickDefaultDatabase(list, "siam")).toBe("siam");
    expect(pickDefaultDatabase([{ name: "beads_global", issueCount: 1 }], null)).toBe(
      "beads_global",
    );
    // Ties: the first in the given order (the operator's order for BDDB_DATABASES).
    expect(
      pickDefaultDatabase(
        [
          { name: "b", issueCount: 3 },
          { name: "a", issueCount: 3 },
        ],
        null,
      ),
    ).toBe("b");
  });
  test("a configured default that is not served is a DiscoveryError with the list", () => {
    let err: DiscoveryError | undefined;
    try {
      pickDefaultDatabase(list, "nope");
    } catch (e) {
      err = e as DiscoveryError;
    }
    expect(err).toBeInstanceOf(DiscoveryError);
    expect(err?.message).toContain('"nope"');
    expect(err?.hints.join("\n")).toContain("shared");
  });
  test("the identifier alphabet matches BDDB_DATABASES and the real probe refuses the rest", async () => {
    expect(DATABASE_NAME_RE.test("beads_global")).toBe(true);
    expect(DATABASE_NAME_RE.test("kb-2$x")).toBe(true);
    expect(DATABASE_NAME_RE.test("a`.b")).toBe(false);
    expect(DATABASE_NAME_RE.test("")).toBe(false);
    // Bun.SQL connects lazily: an invalid name is refused before any query is attempted.
    const probe = createDoltProbe({ host: "127.0.0.1", port: 9, user: "root", password: "" }, 1);
    try {
      await expect(probe.countIssues("x`; DROP DATABASE y; --")).rejects.toBeInstanceOf(
        DiscoveryError,
      );
    } finally {
      await probe.close().catch(() => {});
    }
  });
  test("describeDatabases prints the counts", () => {
    expect(describeDatabases(rankDatabases(list))).toBe(
      "shared (312), siam (75), probe (75), beads_global (900)",
    );
  });
});

describe("discoverDatabases", () => {
  const COUNTS: Record<string, number> = { beads_global: 3, shared: 312, siam: 75 };
  function fakeProbe(
    fail = false,
    counts: Record<string, number> = COUNTS,
  ): DoltProbe & { closed: boolean; counted: string[] } {
    return {
      closed: false,
      counted: [],
      async showDatabases() {
        if (fail) throw new Error("connection refused");
        return ALL;
      },
      async databasesWithIssuesTable() {
        return WITH_ISSUES;
      },
      async countIssues(database) {
        this.counted.push(database);
        const n = counts[database];
        if (n === undefined) throw new Error(`table not found: ${database}.issues`);
        return n;
      },
      async close() {
        this.closed = true;
      },
    };
  }
  const connection = { host: "127.0.0.1", port: 3399, user: "root", password: "" };

  test("uses the probe, counts every selected database, orders by size and closes it", async () => {
    const probe = fakeProbe();
    const found = await discoverDatabases({ probe, connection, requested: null });
    expect(found).toEqual([
      { name: "shared", issueCount: 312 },
      { name: "siam", issueCount: 75 },
      { name: "beads_global", issueCount: 3 },
    ]);
    expect(probe.counted.sort()).toEqual(["beads_global", "shared", "siam"]);
    expect(probe.closed).toBe(true);
  });
  test("the smaller database comes first only when the counts say so", async () => {
    const probe = fakeProbe(false, { beads_global: 0, shared: 10, siam: 500 });
    const found = await discoverDatabases({ probe, connection, requested: null });
    expect(found.map((d) => d.name)).toEqual(["siam", "shared", "beads_global"]);
    expect(pickDefaultDatabase(found, null)).toBe("siam");
  });
  test("an explicit list keeps the operator's order; the default is still the largest", async () => {
    const probe = fakeProbe();
    const found = await discoverDatabases({ probe, connection, requested: ["siam", "shared"] });
    expect(found).toEqual([
      { name: "siam", issueCount: 75 },
      { name: "shared", issueCount: 312 },
    ]);
    expect(pickDefaultDatabase(found, null)).toBe("shared");
    expect(pickDefaultDatabase(found, "siam")).toBe("siam");
  });
  test("a failing count becomes a DiscoveryError naming the database", async () => {
    const probe = fakeProbe(false, { shared: 1 });
    const err = await discoverDatabases({ probe, connection, requested: null }).catch((e) => e);
    expect(err).toBeInstanceOf(DiscoveryError);
    expect((err as DiscoveryError).message).toMatch(
      /cannot count issues of database (siam|beads_global)/,
    );
    expect(probe.closed).toBe(true);
  });
  test("connection failure becomes a DiscoveryError with hints", async () => {
    const probe = fakeProbe(true);
    const err = await discoverDatabases({ probe, connection, requested: null }).catch((e) => e);
    expect(err).toBeInstanceOf(DiscoveryError);
    expect((err as DiscoveryError).message).toContain("127.0.0.1:3399");
    expect((err as DiscoveryError).hints.join("\n")).toMatch(/0\.0\.0\.0/);
    expect(probe.closed).toBe(true);
  });
});
