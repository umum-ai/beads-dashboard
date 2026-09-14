import { describe, expect, test } from "bun:test";
import { BUILT_FOR_BEADS, versionWarning } from "../../../src/server/version.ts";

describe("version pin", () => {
  test("BUILT_FOR_BEADS equals the github:gastownhall/beads pin in mise.toml", async () => {
    const toml = await Bun.file(new URL("../../../mise.toml", import.meta.url)).text();
    const m = /"github:gastownhall\/beads"\s*=\s*"([^"]+)"/.exec(toml);
    expect(m?.[1]).toBe(BUILT_FOR_BEADS);
  });
  test("versionWarning: null on same/patch, text on minor/major", () => {
    expect(versionWarning("1.3.0-rc.2")).toBeNull();
    expect(versionWarning("1.3.1")).toBeNull();
    expect(versionWarning("1.4.0")).toMatch(/minor/);
    expect(versionWarning("2.0.0")).toMatch(/major/);
  });
});
