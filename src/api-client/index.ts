/**
 * bd serve HTTP API client (beads 1.3.0-rc.2, `/v0/beads`). See docs/api-client.md.
 *
 * - `BdClient` — typed methods for every operation the dashboard uses; throws `ProblemError`.
 * - `watchEvents` / `SseParser` — the `events:watch` SSE consumer (no reconnect; the BFF does).
 * - `Capabilities` / `checkVersion` — gate on `context.capabilities` and `bd_version`.
 * - Types are generated from `spec/openapi.v0.yaml` (`mise run gen:api`) and aliased in `types.ts`.
 */

export {
  Capabilities,
  type Capability,
  CapabilityError,
  checkVersion,
  parseSemVer,
  type SemVer,
  type VersionCheck,
  type VersionLevel,
} from "./capabilities.ts";
export { BdClient, type BdClientOptions, type RequestOptions } from "./client.ts";
export {
  frameToWatchEvent,
  type SseFrame,
  SseParser,
  SseProtocolError,
  type WatchEvent,
  type WatchEventsOptions,
  watchEvents,
} from "./events.ts";
export { type ConnectionOptions, type QueryValue, serializeQuery } from "./http.ts";
export {
  isProblem,
  isProblemClass,
  isProblemCode,
  type Problem,
  type ProblemClass,
  type ProblemCode,
  ProblemError,
  type ProblemReason,
  parseRetryAfter,
  problemClass,
  problemFromBody,
  problemFromResponse,
  synthesizeProblem,
} from "./problem.ts";
export type * from "./types.ts";
