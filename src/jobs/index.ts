/**
 * Smpl Jobs SDK namespace.
 *
 * Smpl Jobs runs an HTTP call (`http` configuration) on a schedule (a 5-field
 * cron expression, a one-off datetime, or `"now"`) or on demand (a manual job
 * with no schedule), and records the run history for each fire. Unlike
 * Config/Flags/Logging it installs no in-process machinery, so it has no
 * runtime/management split: a single {@link JobsClient} exposes the full
 * surface and is reachable as `client.jobs` on {@link SmplClient} or
 * constructed directly via {@link JobsClient}.
 *
 * This module is also the package's `@smplkit/sdk/jobs` subpath — the
 * edge/serverless entry. Its import graph is free of Node built-ins and of
 * the `ws` transport, so it bundles for edge runtimes (e.g. Cloudflare
 * Workers). Jobs is pure awaited CRUD — no buffers, timers, or sockets —
 * so no stateless switch is needed; the only difference from the package
 * root is configuration: defaults → the `SMPLKIT_API_KEY` /
 * `SMPLKIT_BASE_DOMAIN` / `SMPLKIT_SCHEME` / `SMPLKIT_ENVIRONMENT`
 * environment variables → constructor options — minus the `~/.smplkit`
 * file step (that machinery needs `node:fs`, and an isolate has no home
 * directory anyway).
 */

export { JobsClient, RunsClient, RetryPoliciesClient } from "./client.js";
export type { JobsClientOptions } from "./client.js";
// The full typed error surface, so edge callers can catch what the client throws.
export * from "../errors.js";
export {
  Backoff,
  HttpConfig,
  HttpMethod,
  Job,
  JobEnvironment,
  JobKind,
  RetryPolicy,
  Run,
  RunRetry,
  RunTrigger,
  Usage,
} from "./types.js";
export type { ListJobsParams, ListRetryPoliciesParams, ListRunsParams } from "./types.js";
