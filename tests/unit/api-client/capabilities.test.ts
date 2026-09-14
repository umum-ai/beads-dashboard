import { describe, expect, test } from "bun:test";
import {
  Capabilities,
  CapabilityError,
  checkVersion,
  parseSemVer,
} from "../../../src/api-client/index.ts";

describe("Capabilities", () => {
  const caps = Capabilities.fromContext({
    capabilities: ["issues.list", "issues.get", "events.watch", "project.enforce"],
    bd_version: "1.3.0-rc.2",
  });

  test("has / require / missing / enforcesProject", () => {
    expect(caps.has("issues.list")).toBe(true);
    expect(caps.has("issues.delete")).toBe(false);
    expect(caps.has("something.future")).toBe(false);
    expect(() => caps.require("issues.get")).not.toThrow();
    expect(() => caps.require("memories.list")).toThrow(CapabilityError);
    expect(() => caps.require("memories.list")).toThrow(
      /bd serve \(bd 1\.3\.0-rc\.2\) does not advertise capability "memories\.list"/,
    );
    expect(caps.missing(["issues.list", "issues.update", "events.list"])).toEqual([
      "issues.update",
      "events.list",
    ]);
    expect(caps.enforcesProject).toBe(true);
    expect(new Capabilities([]).enforcesProject).toBe(false);
    expect(JSON.stringify(caps)).toBe(
      JSON.stringify(["events.watch", "issues.get", "issues.list", "project.enforce"]),
    );
  });
});

describe("parseSemVer", () => {
  test("accepts release, prerelease, v-prefix, build metadata; rejects garbage", () => {
    expect(parseSemVer("1.3.0")).toEqual({ major: 1, minor: 3, patch: 0, prerelease: undefined });
    expect(parseSemVer("v1.3.0-rc.2+abc")).toEqual({
      major: 1,
      minor: 3,
      patch: 0,
      prerelease: "rc.2",
    });
    expect(parseSemVer("1.4")).toEqual({ major: 1, minor: 4, patch: 0, prerelease: undefined });
    expect(parseSemVer("dev")).toBeUndefined();
    expect(parseSemVer("")).toBeUndefined();
  });
});

describe("checkVersion", () => {
  test("prerelease tags are ignored", () => {
    expect(checkVersion("1.3.0-rc.2", "1.3.0")).toMatchObject({ ok: true, level: "same" });
    expect(checkVersion("1.3.0", "1.3.0-rc.2")).toMatchObject({ ok: true, level: "same" });
  });

  test("patch and minor differences are ok; older minor and other major are not", () => {
    expect(checkVersion("1.3.1", "1.3.0")).toMatchObject({ ok: true, level: "patch" });
    expect(checkVersion("1.4.0", "1.3.0")).toMatchObject({ ok: true, level: "minor" });
    expect(checkVersion("1.2.9", "1.3.0")).toMatchObject({ ok: false, level: "minor" });
    expect(checkVersion("2.0.0", "1.3.0")).toMatchObject({ ok: false, level: "major" });
    expect(checkVersion("0.9.0", "1.3.0")).toMatchObject({ ok: false, level: "major" });
  });

  test("unparsable versions fail closed with a reason", () => {
    const r = checkVersion("dev-build", "1.3.0");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("major");
    expect(r.reason).toContain("dev-build");
    expect(r.builtFor?.minor).toBe(3);
  });
});
