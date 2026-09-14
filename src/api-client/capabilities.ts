/**
 * Capability gating and version comparison for `GET /v0/beads/context`.
 *
 * Rules from the spec: branch on `capabilities` for operation presence, on `bd_version` for
 * behavioral changes tied to a release; never on `schema_version`. `events.list` /
 * `events.watch` say the BUILD speaks the operation — the workspace may still answer
 * `409 events_journal_disabled`.
 */
import type { Context } from "./types.ts";

/** v0 capability tokens. Operation tokens follow the PATH: `issues.batchApply`, `issues.casMetadata`. */
export type Capability =
  | "ready.list"
  | "ready.count"
  | "issues.list"
  | "issues.query"
  | "issues.count"
  | "issues.get"
  | "issues.related"
  | "issues.create"
  | "issues.addComment"
  | "issues.batchClose"
  | "issues.claim"
  | "issues.claimNext"
  | "issues.release"
  | "issues.close"
  | "issues.reopen"
  | "issues.update"
  | "issues.sweep"
  | "issues.delete"
  | "issues.batchCreate"
  | "issues.batchApply"
  | "issues.casMetadata"
  | "stats.get"
  | "config.list"
  | "config.get"
  | "config.set"
  | "config.unset"
  | "dependencies.cycles"
  | "dependencies.list"
  | "dependencies.count"
  | "dependencies.blocking"
  | "dependencies.tree"
  | "dependencies.add"
  | "dependencies.remove"
  | "memories.list"
  | "memories.get"
  | "memories.remember"
  | "memories.forget"
  | "events.list"
  | "events.watch"
  | "project.enforce"
  | (string & {});

/** Thrown by `Capabilities.require` when the server does not advertise an operation. */
export class CapabilityError extends Error {
  readonly capability: string;
  readonly bdVersion: string | undefined;

  constructor(capability: string, bdVersion?: string) {
    const version = bdVersion ? ` (bd ${bdVersion})` : "";
    super(
      `bd serve${version} does not advertise capability "${capability}"; ` +
        "the operation is unavailable on this server",
    );
    this.name = "CapabilityError";
    this.capability = capability;
    this.bdVersion = bdVersion;
  }
}

export class Capabilities {
  readonly tokens: ReadonlySet<string>;
  readonly bdVersion: string | undefined;

  constructor(tokens: Iterable<string>, bdVersion?: string) {
    this.tokens = new Set(tokens);
    this.bdVersion = bdVersion;
  }

  static fromContext(context: Pick<Context, "capabilities" | "bd_version">): Capabilities {
    return new Capabilities(context.capabilities, context.bd_version);
  }

  has(capability: Capability): boolean {
    return this.tokens.has(capability);
  }

  /** Throws `CapabilityError` unless the server advertises `capability`. */
  require(capability: Capability): void {
    if (!this.has(capability)) throw new CapabilityError(capability, this.bdVersion);
  }

  /** Every listed capability that is missing (empty array when all are present). */
  missing(capabilities: readonly Capability[]): Capability[] {
    return capabilities.filter((c) => !this.has(c));
  }

  /** Whether `Bd-Project-Id` is enforced by this build. */
  get enforcesProject(): boolean {
    return this.has("project.enforce");
  }

  toJSON(): string[] {
    return [...this.tokens].sort();
  }
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | undefined;
}

/** Parse `1.3.0`, `v1.3.0-rc.2`, `1.3.0-rc.2+build` (build metadata dropped). */
export function parseSemVer(version: string): SemVer | undefined {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim(),
  );
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] === undefined ? 0 : Number(m[3]),
    prerelease: m[4],
  };
}

/** How far the server's `bd_version` is from the version this client was built against. */
export type VersionLevel = "same" | "patch" | "minor" | "major";

export interface VersionCheck {
  /** `true` when the server is the same major and its minor is not older than `builtFor`. */
  ok: boolean;
  /** Coarsest component that differs; prerelease tags are ignored (`1.3.0-rc.2` ≈ `1.3.0`). */
  level: VersionLevel;
  server: SemVer | undefined;
  builtFor: SemVer | undefined;
  /** Set when either version did not parse (then `ok: false`, `level: "major"`). */
  reason?: string;
}

/**
 * Compare `bdVersion` (from context) with the beads version this client targets. Prerelease
 * tolerance: only major/minor/patch are compared, so `1.3.0-rc.2` vs `1.3.0` is `same`.
 */
export function checkVersion(bdVersion: string, builtFor: string): VersionCheck {
  const server = parseSemVer(bdVersion);
  const target = parseSemVer(builtFor);
  if (!server || !target) {
    const bad = !server ? bdVersion : builtFor;
    return {
      ok: false,
      level: "major",
      server,
      builtFor: target,
      reason: `unparsable version: ${JSON.stringify(bad)}`,
    };
  }
  let level: VersionLevel = "same";
  if (server.major !== target.major) level = "major";
  else if (server.minor !== target.minor) level = "minor";
  else if (server.patch !== target.patch) level = "patch";
  const ok = level !== "major" && server.minor >= target.minor;
  return { ok, level, server, builtFor: target };
}
