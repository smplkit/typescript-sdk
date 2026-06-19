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
 */

export { JobsClient, RunsClient } from "./client.js";
export type { JobsClientOptions } from "./client.js";
export {
  HttpConfig,
  HttpMethod,
  Job,
  JobEnvironment,
  JobKind,
  Run,
  RunTrigger,
  Usage,
} from "./types.js";
export type { HttpHeader, ListJobsParams, ListRunsParams } from "./types.js";
