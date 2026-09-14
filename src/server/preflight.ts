/**
 * Startup checks of `bddb serve` that must fail loudly instead of leaving every database
 * `down` forever: the `bd` binary must run, and its version must be one this build can drive
 * (same major, minor not older than the build target — `bd serve` appeared in 1.3.0). A newer
 * minor is a warning, not an error (the UI shows the mismatch banner as well).
 */
import { checkVersion } from "../api-client/index.ts";
import { bdVersion } from "./supervisor.ts";
import { BUILT_FOR_BEADS } from "./version.ts";

/** Startup failure with hints, printed by the CLI like `bddb doctor` prints them; exit 2. */
export class StartupError extends Error {
  readonly hints: string[];
  constructor(message: string, hints: string[] = []) {
    super(message);
    this.name = "StartupError";
    this.hints = hints;
  }
}

export interface BdCheck {
  version: string;
  raw: string;
  /** Set when the version differs in the minor component (newer bd); logged as a warning. */
  warning: string | null;
}

/** Pure decision over `bd version` output; `null` = binary missing / unparsable. */
export function assessBd(
  probe: { version: string; raw: string } | null,
  bdPath: string,
  builtFor: string = BUILT_FOR_BEADS,
): BdCheck {
  if (!probe) {
    throw new StartupError(
      `cannot run "${bdPath} version": bd binary not found or not executable`,
      [
        "install beads (https://github.com/gastownhall/beads/releases) so that `bd` is in PATH, or set BDDB_BD_PATH",
        "the release binary and a source checkout need `bd` and `git` on the host; the container image already carries both",
        "`bddb doctor` runs this and the other startup checks",
      ],
    );
  }
  const check = checkVersion(probe.version, builtFor);
  if (check.level === "major" || !check.ok) {
    throw new StartupError(
      `bd ${probe.version} at ${bdPath} is not supported by this bddb (built for beads ${builtFor}): ${check.reason ?? `${check.level} version mismatch`}`,
      [
        check.server && check.builtFor && check.server.major === check.builtFor.major
          ? `bd serve needs beads ${builtFor} or newer in the same major; upgrade bd (or point BDDB_BD_PATH at a newer one)`
          : "bddb drives bd serve of the beads major it was built for; install a matching bd or a matching bddb release",
        "docs/compatibility.md lists which bddb goes with which beads",
      ],
    );
  }
  const warning =
    check.level === "minor"
      ? `bd ${probe.version} is a newer minor than this bddb was built for (${builtFor}); keep the host bd and the dashboard on the same minor (docs/compatibility.md)`
      : null;
  return { version: probe.version, raw: probe.raw, warning };
}

/** Run `bd version` and assess it. Throws `StartupError`. */
export async function checkBd(
  bdPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BdCheck> {
  return assessBd(await bdVersion(bdPath, env), bdPath);
}
