import { describe, expect, test } from "bun:test";
import {
  DiscoveryError,
  type DoltProbe,
  discoverDatabases,
  orderDatabases,
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

describe("discoverDatabases", () => {
  function fakeProbe(fail = false): DoltProbe & { closed: boolean } {
    return {
      closed: false,
      async showDatabases() {
        if (fail) throw new Error("connection refused");
        return ALL;
      },
      async databasesWithIssuesTable() {
        return WITH_ISSUES;
      },
      async close() {
        this.closed = true;
      },
    };
  }
  const connection = { host: "127.0.0.1", port: 3399, user: "root", password: "" };

  test("uses the probe and closes it", async () => {
    const probe = fakeProbe();
    const names = await discoverDatabases({ probe, connection, requested: null });
    expect(names).toEqual(["shared", "siam", "beads_global"]);
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
