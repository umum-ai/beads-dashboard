/**
 * bd serve HTTP API client. Stage 0 placeholder; types are generated from
 * spec/openapi.v0.yaml in stage 1.
 */

/** Opaque optimistic-concurrency token returned by bd serve. Compare for equality only. */
export type Revision = string;

/** RFC 9457 problem document returned by bd serve on every non-2xx response. */
export interface Problem {
  code: string;
  status: number;
  title?: string;
  detail?: string;
  request_id?: string;
  [extension: string]: unknown;
}
