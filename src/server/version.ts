/**
 * Version constants. `BUILT_FOR_BEADS` is the beads release this build targets; it must equal
 * the `github:gastownhall/beads` pin in `mise.toml` (tests/unit/server/version.test.ts asserts
 * it). `checkVersion` (api-client) compares it with `bd_version` from `GET /v0/beads/context`.
 */
import pkg from "../../package.json";
import { checkVersion } from "../api-client/index.ts";

export const BDDB_VERSION: string = pkg.version;
export const BUILT_FOR_BEADS = "1.3.0-rc.2";

/**
 * Human-readable warning when the running `bd serve` differs from `BUILT_FOR_BEADS` by
 * major or minor (schema of a shared Dolt may differ); `null` when compatible.
 */
export function versionWarning(
  bdVersion: string,
  builtFor: string = BUILT_FOR_BEADS,
): string | null {
  const check = checkVersion(bdVersion, builtFor);
  if (check.level === "same" || check.level === "patch") return null;
  const grade = check.level === "major" ? "major" : "minor";
  return `bd ${bdVersion} differs from the beads version this bddb was built for (${builtFor}) in the ${grade} component; keep the host bd and the dashboard on the same minor`;
}
