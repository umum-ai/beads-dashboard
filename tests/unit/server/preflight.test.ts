import { describe, expect, test } from "bun:test";
import { assessBd, StartupError } from "../../../src/server/preflight.ts";

const probe = (version: string) => ({ version, raw: `bd version ${version} (abc)` });

describe("assessBd", () => {
  test("missing binary is a StartupError with install hints", () => {
    expect(() => assessBd(null, "/nonexistent", "1.3.0-rc.2")).toThrow(StartupError);
    try {
      assessBd(null, "/nonexistent", "1.3.0-rc.2");
    } catch (err) {
      const e = err as StartupError;
      expect(e.message).toContain('cannot run "/nonexistent version"');
      expect(e.hints.some((h) => h.includes("BDDB_BD_PATH"))).toBe(true);
      expect(e.hints.some((h) => h.includes("bddb doctor"))).toBe(true);
    }
  });

  test("same version and patch differences pass silently", () => {
    expect(assessBd(probe("1.3.0-rc.2"), "bd", "1.3.0-rc.2").warning).toBeNull();
    expect(assessBd(probe("1.3.4"), "bd", "1.3.0").warning).toBeNull();
  });

  test("a newer minor passes with a warning", () => {
    const check = assessBd(probe("1.4.0"), "bd", "1.3.0-rc.2");
    expect(check.warning).toContain("newer minor");
    expect(check.warning).toContain("docs/compatibility.md");
  });

  test("an older minor (no bd serve) and another major are refused with hints", () => {
    for (const version of ["1.2.9", "2.0.0", "0.9.0"]) {
      try {
        assessBd(probe(version), "bd", "1.3.0-rc.2");
        throw new Error("did not throw");
      } catch (err) {
        expect(err).toBeInstanceOf(StartupError);
        const e = err as StartupError;
        expect(e.message).toContain(`bd ${version} at bd is not supported`);
        expect(e.hints.at(-1)).toContain("docs/compatibility.md");
      }
    }
    try {
      assessBd(probe("1.2.9"), "bd", "1.3.0-rc.2");
    } catch (err) {
      expect((err as StartupError).hints[0]).toContain("beads 1.3.0-rc.2 or newer");
    }
  });

  test("unparsable output is refused", () => {
    expect(() => assessBd({ version: "weird", raw: "bd version weird" }, "bd", "1.3.0")).toThrow(
      /unparsable version/,
    );
  });
});
