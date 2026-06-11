/**
 * Smpl Jobs SDK namespace.
 *
 * Smpl Jobs schedules HTTP calls (cron-style `schedule` + `http`
 * configuration) and records their run history. Unlike Config/Flags/Logging it
 * installs no in-process machinery, so it has no runtime/management split: a
 * single {@link JobsClient} exposes the full surface and is reachable as
 * `client.jobs` on {@link SmplClient} or constructed directly via
 * {@link JobsClient}.
 *
 * See ADR-049.
 */

export { JobsClient, RunsClient } from "./client.js";
export type { JobsClientOptions } from "./client.js";
export { HttpConfig, HttpMethod, Job, Run, Usage } from "./types.js";
export type { HttpHeader, JobModelClient, ListJobsParams, ListRunsParams } from "./types.js";
