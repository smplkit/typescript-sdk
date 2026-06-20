/**
 * Smpl Jobs SDK client (`client.jobs` on SmplClient, or standalone `JobsClient`).
 *
 * Unlike Config/Flags/Logging, Jobs installs no in-process machinery — no
 * environment registration, no WebSocket, no logger monkey-patching. It is a
 * product you *use*, not infrastructure you *install*, so it has no
 * runtime/management split: a single {@link JobsClient} exposes the full
 * surface, reachable two ways:
 *
 * - `client.jobs.*` on {@link SmplClient}
 * - directly — `new JobsClient({ apiKey })` — for callers that only need jobs.
 *
 * A {@link Job} is an active record: build it with
 * {@link JobsClient.newRecurringJob} / {@link JobsClient.newManualJob} /
 * {@link JobsClient.schedule}, set fields, and call `save()` (create when new,
 * full-replace update when it already exists) or `delete()`. Runs are read-only
 * views; run actions live on `jobs.runs`.
 *
 * Every call delegates HTTP to the auto-generated openapi-fetch client over
 * `../generated/jobs.d.ts`; this wrapper only shapes models and raises SDK
 * exceptions.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components, paths } from "../generated/jobs.d.ts";
import { SmplError, SmplConnectionError, throwForStatus } from "../errors.js";
import { resolveClientConfig, serviceUrl } from "../config.js";
import {
  HttpConfig,
  HttpMethod,
  Job,
  JobEnvironment,
  JobKind,
  Run,
  Usage,
  type HttpHeader,
  type ListJobsParams,
  type ListRunsParams,
} from "./types.js";

type JobsHttp = ReturnType<typeof createClient<paths>>;
type GenJobHttpConfiguration = components["schemas"]["JobHttpConfiguration"];
type GenJob = components["schemas"]["Job"];
type GenJobEnvironment = components["schemas"]["JobEnvironment"];
type GenJobCreateRequest = components["schemas"]["JobCreateRequest"];
type GenJobRequest = components["schemas"]["JobRequest"];

const JSONAPI_CONTENT_TYPE = "application/vnd.api+json";

/**
 * Comma-join environment keys for the `filter[environment]` read filter.
 * Returns `undefined` (so the caller omits the param) when the list is absent
 * or empty.
 */
function _joinEnvironments(environments: string[] | undefined): string | undefined {
  if (environments === undefined || environments.length === 0) return undefined;
  return environments.join(",");
}

/**
 * Resolve the `filter[environment]` value for a runs read: an explicit
 * `environments` list (comma-joined) wins, else the client's configured
 * environment, else `undefined` (no filter; the credential's scoping applies).
 */
function _resolveEnvironmentFilter(
  environments: string[] | undefined,
  defaultEnv: string | undefined,
): string | undefined {
  return _joinEnvironments(environments) ?? defaultEnv;
}

function _environmentsToWire(environments: Record<string, JobEnvironment>): {
  [key: string]: GenJobEnvironment;
} {
  const out: { [key: string]: GenJobEnvironment } = {};
  for (const [envKey, env] of Object.entries(environments)) {
    const wire: GenJobEnvironment = {
      enabled: env.enabled,
      configuration: env.configuration === null ? null : _configurationToWire(env.configuration),
    };
    // `schedule` and `timezone` are customer-settable per-environment cron
    // overrides; send each only when set. `nextRunAt` is read-only — never sent.
    if (env.schedule !== null) wire.schedule = env.schedule;
    if (env.timezone !== null) wire.timezone = env.timezone;
    out[envKey] = wire;
  }
  return out;
}

function _environmentsFromWire(
  raw: Record<string, unknown> | undefined,
): Record<string, JobEnvironment> {
  const out: Record<string, JobEnvironment> = {};
  for (const [envKey, value] of Object.entries(raw ?? {})) {
    const v = (value ?? {}) as {
      enabled?: unknown;
      schedule?: unknown;
      timezone?: unknown;
      configuration?: Record<string, unknown> | null;
      next_run_at?: unknown;
    };
    out[envKey] = new JobEnvironment({
      enabled: Boolean(v.enabled ?? false),
      schedule: v.schedule == null ? null : String(v.schedule),
      timezone: v.timezone == null ? null : String(v.timezone),
      configuration:
        v.configuration == null
          ? null
          : _configurationFromWire(v.configuration as Record<string, unknown>),
      nextRunAt: v.next_run_at == null ? null : String(v.next_run_at),
    });
  }
  return out;
}

/** @internal */
async function checkError(response: Response, error?: unknown): Promise<never> {
  // ``openapi-fetch`` pre-reads the response body to populate ``result.error``
  // / ``result.data`` — by the time we get here ``response.text()`` returns
  // ``""`` because the stream is consumed. Prefer the pre-parsed error payload
  // when openapi-fetch handed one to us; fall back to a fresh ``.text()``.
  let body = "";
  if (error !== undefined && error !== null) {
    try {
      body = typeof error === "string" ? error : JSON.stringify(error);
      /* v8 ignore start — defensive guard; openapi-fetch parses JSON itself
         so circular refs / BigInts never reach this code path. */
    } catch {
      // leave body empty; throwForStatus tolerates an empty payload
    }
    /* v8 ignore stop */
  }
  /* v8 ignore start — fallback for the rare null/empty-error case. */
  if (!body) {
    body = await response.text().catch(() => "");
  }
  /* v8 ignore stop */
  throwForStatus(response.status, body);
}

/** @internal */
function wrapFetchError(err: unknown): never {
  if (err instanceof SmplError) throw err;
  if (err instanceof TypeError) {
    throw new SmplConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

function _configurationToWire(config: HttpConfig): GenJobHttpConfiguration {
  return {
    method: config.method as GenJobHttpConfiguration["method"],
    url: config.url,
    headers: config.headers.map((h: HttpHeader) => ({ name: h.name, value: h.value })),
    body: config.body,
    success_status: config.successStatus,
    timeout: config.timeout,
    tls_verify: config.tlsVerify,
    ca_cert: config.caCert,
  };
}

function _configurationFromWire(raw: Record<string, unknown> | undefined): HttpConfig {
  const r = raw ?? {};
  const headers = ((r.headers as Array<{ name?: string; value?: string }>) ?? []).map((h) => ({
    name: String(h.name ?? ""),
    value: String(h.value ?? ""),
  }));
  return new HttpConfig({
    url: String(r.url ?? ""),
    method: (r.method as HttpMethod | undefined) ?? HttpMethod.POST,
    headers,
    body: r.body == null ? null : String(r.body),
    successStatus: String(r.success_status ?? "2xx"),
    timeout: r.timeout === undefined ? 30 : Number(r.timeout),
    tlsVerify: r.tls_verify === undefined ? true : Boolean(r.tls_verify),
    caCert: r.ca_cert == null ? null : String(r.ca_cert),
  });
}

function _jobAttrs(job: Job): GenJob {
  // The base `enabled` is a server-derived read-only roll-up; we don't send
  // it. Enablement travels entirely through `environments`.
  const attrs: GenJob = {
    name: job.name,
    description: job.description,
    type: job.type as GenJob["type"],
    schedule: job.schedule,
    configuration: _configurationToWire(job.configuration),
    concurrency_policy: job.concurrencyPolicy as GenJob["concurrency_policy"],
  } as GenJob;
  // `timezone` is the IANA zone the cron is evaluated in (recurring jobs only);
  // a null timezone is omitted, leaving the server default of UTC.
  if (job.timezone !== null) attrs.timezone = job.timezone;
  if (Object.keys(job.environments).length > 0) {
    attrs.environments = _environmentsToWire(job.environments);
  }
  return attrs;
}

function _jobFromResource(
  resource: { id: string; attributes: Record<string, unknown> },
  client: JobsClient,
): Job {
  const a = resource.attributes;
  // The base `enabled` roll-up is derived from `environments` on the model and
  // each environment's `next_run_at` is read inside `_environmentsFromWire`;
  // there are no top-level `enabled` / `next_run_at` attributes to read.
  return new Job(client, {
    id: resource.id,
    name: String(a.name ?? ""),
    description: (a.description as string | null) ?? null,
    environments: _environmentsFromWire(a.environments as Record<string, unknown> | undefined),
    kind: a.kind == null ? null : (a.kind as JobKind),
    type: String(a.type ?? "http"),
    schedule: a.schedule == null ? null : String(a.schedule),
    timezone: a.timezone == null ? null : String(a.timezone),
    configuration: _configurationFromWire(a.configuration as Record<string, unknown> | undefined),
    concurrencyPolicy: String(a.concurrency_policy ?? "ALLOW"),
    createdAt: (a.created_at as string | null) ?? null,
    updatedAt: (a.updated_at as string | null) ?? null,
    deletedAt: (a.deleted_at as string | null) ?? null,
    version: (a.version as number | null) ?? null,
  });
}

function _runFromResource(
  resource: { id: string; attributes: Record<string, unknown> },
  runs: RunsClient,
): Run {
  return new Run(resource.attributes, resource.id, runs);
}

/** Run history and run actions (`jobs.runs`). */
export class RunsClient {
  /** @internal */
  constructor(
    private readonly _http: JobsHttp,
    private readonly _environment: string | undefined = undefined,
  ) {}

  /**
   * List past runs, most recent first.
   *
   * @param params.job - Return only runs of the job with this id. Omit to
   *   list runs across all jobs in the account.
   * @param params.environments - Restrict to runs stamped with any of these
   *   environment keys. Omit to fall back to the client's configured
   *   environment, otherwise covering every environment you can access.
   * @param params.pageSize - Maximum number of runs to return in this page.
   *   Omit to use the server default.
   * @param params.after - Opaque cursor from a previous page; returns the runs
   *   that follow it. Omit to start from the first page.
   * @returns The runs in this page.
   */
  async list(params: ListRunsParams = {}): Promise<Run[]> {
    const query: Record<string, string | number> = {};
    if (params.job !== undefined) query["filter[job]"] = params.job;
    const environments = _resolveEnvironmentFilter(params.environments, this._environment);
    if (environments !== undefined) query["filter[environment]"] = environments;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.after !== undefined) query["page[after]"] = params.after;

    let data: { data?: unknown[] } | undefined;
    try {
      const result = await this._http.GET("/api/v1/runs", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    return ((data?.data ?? []) as Array<{ id: string; attributes: Record<string, unknown> }>).map(
      (r) => _runFromResource(r, this),
    );
  }

  /**
   * Fetch a single run by its id.
   *
   * @param runId - Identifier of the run to fetch.
   * @returns The matching run.
   */
  async get(runId: string): Promise<Run> {
    return this._runAction("GET", "/api/v1/runs/{run_id}", runId);
  }

  /**
   * Cancel a run that has not finished yet.
   *
   * @param runId - Identifier of the run to cancel.
   * @returns The updated run reflecting the cancellation.
   */
  async cancel(runId: string): Promise<Run> {
    return this._runAction("POST", "/api/v1/runs/{run_id}/actions/cancel", runId);
  }

  /**
   * Start a new run that repeats a previous one.
   *
   * @param runId - Identifier of the run to repeat.
   * @returns The new run, with `rerunOf` set to `runId`.
   */
  async rerun(runId: string): Promise<Run> {
    return this._runAction("POST", "/api/v1/runs/{run_id}/actions/rerun", runId);
  }

  /** @internal Shared single-run GET/POST helper. */
  private async _runAction(
    verb: "GET" | "POST",
    path:
      | "/api/v1/runs/{run_id}"
      | "/api/v1/runs/{run_id}/actions/cancel"
      | "/api/v1/runs/{run_id}/actions/rerun",
    runId: string,
  ): Promise<Run> {
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const opts = { params: { path: { run_id: runId } } };
      const result =
        verb === "GET"
          ? await this._http.GET(path as "/api/v1/runs/{run_id}", opts)
          : await this._http.POST(path as "/api/v1/runs/{run_id}/actions/cancel", opts);
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _runFromResource(data.data, this);
  }
}

/** Configuration options for the {@link JobsClient}. */
export interface JobsClientOptions {
  /** API key. When omitted, resolved from `SMPLKIT_API_KEY` or `~/.smplkit`. */
  apiKey?: string;
  /**
   * Full jobs-service base URL. Usually resolved from `baseDomain`/`scheme`;
   * supplied directly by the top-level clients which have already computed it.
   */
  baseUrl?: string;
  /** Named `~/.smplkit` profile section. */
  profile?: string;
  /** Base domain for API requests (default `"smplkit.com"`). */
  baseDomain?: string;
  /** URL scheme (default `"https"`). */
  scheme?: string;
  /** Enable SDK debug logging. */
  debug?: boolean;
  /** Extra headers attached to every request. */
  extraHeaders?: Record<string, string>;
  /**
   * Default environment for environment-scoped operations — the environment a
   * one-off job created through this client is born in, the default a manual
   * run executes in, and the default scope for `jobs.runs.list()`. Omit to
   * leave these unset (the credential's permitted environment is implied where
   * unambiguous).
   */
  environment?: string;
  /**
   * Internal — a pre-built jobs transport supplied by a top-level client so
   * the jobs surface shares one connection pool. Not for direct use.
   * @internal
   */
  transport?: JobsHttp;
}

/**
 * Smpl Jobs client.
 *
 * Reachable as `client.jobs` ({@link SmplClient}) or constructed directly:
 *
 * @example
 * ```typescript
 * import { JobsClient } from "@smplkit/sdk";
 *
 * const jobs = new JobsClient();
 * for (const job of await jobs.list()) {
 *   console.log(job.id);
 * }
 * ```
 *
 * The full surface — active-record job CRUD (`newRecurringJob` /
 * `newManualJob` / `schedule` / `get` / `list` / `delete`), the run-now action
 * (`run`), run history and run actions (`runs`), and usage (`usage`) — lives on
 * this one class. Jobs installs no in-process machinery, so there is no live
 * connection and no install step.
 */
export class JobsClient {
  /** @internal */
  private readonly _http: JobsHttp;
  /** @internal */
  private readonly _ownsTransport: boolean;
  /** @internal */
  private readonly _environment: string | undefined;

  /** Run history and run actions. */
  readonly runs: RunsClient;

  constructor(options: JobsClientOptions = {}) {
    if (options.transport !== undefined) {
      this._http = options.transport;
      this._ownsTransport = false;
    } else {
      const cfg = resolveClientConfig(options);
      const jobsUrl = options.baseUrl ?? serviceUrl(cfg.scheme, "jobs", cfg.baseDomain);
      this._http = createClient<paths>({
        baseUrl: jobsUrl.replace(/\/+$/, ""),
        headers: {
          ...(options.extraHeaders ?? {}),
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: JSONAPI_CONTENT_TYPE,
          "Content-Type": JSONAPI_CONTENT_TYPE,
        },
      });
      this._ownsTransport = true;
    }
    this._environment = options.environment;
    this.runs = new RunsClient(this._http, this._environment);
  }

  /** @internal Shared builder behind the public job constructors. */
  private _newJob(
    id: string,
    fields: {
      name: string;
      schedule: string | null;
      configuration: HttpConfig;
      description?: string | null;
      environments?: Record<string, JobEnvironment>;
      concurrencyPolicy?: string;
      environment?: string;
    },
  ): Job {
    return new Job(this, {
      id,
      name: fields.name,
      schedule: fields.schedule,
      configuration: fields.configuration,
      description: fields.description,
      environments: fields.environments,
      concurrencyPolicy: fields.concurrencyPolicy,
      birthEnvironment: fields.environment ?? this._environment ?? null,
    });
  }

  /**
   * Return an unsaved recurring {@link Job}. Call `.save()` to create it.
   *
   * @param id - Caller-supplied unique identifier for the job. Unique within
   *   the account and immutable; the service returns 409 if another live job
   *   already uses this id.
   * @param fields.name - Human-readable name for the job.
   * @param fields.schedule - The base cadence — a 5-field cron expression
   *   evaluated in UTC (e.g. `"0 2 * * *"`) — that every environment inherits
   *   unless it sets its own override.
   * @param fields.configuration - The HTTP request the job sends each time it
   *   fires.
   * @param fields.description - Free-text description for the job. Defaults to
   *   none.
   * @param fields.environments - Per-environment overrides keyed by environment
   *   key. The job is scheduled only in environments enabled here.
   * @param fields.concurrencyPolicy - How overlapping runs are handled.
   *   `"ALLOW"` (the default and only value today) permits a new run to start
   *   while a previous one is still in flight.
   * @returns An unsaved recurring {@link Job} bound to this client.
   */
  newRecurringJob(
    id: string,
    fields: {
      name: string;
      schedule: string;
      configuration: HttpConfig;
      description?: string | null;
      environments?: Record<string, JobEnvironment>;
      concurrencyPolicy?: string;
    },
  ): Job {
    return this._newJob(id, { ...fields });
  }

  /**
   * Return an unsaved manual {@link Job}. Call `.save()` to create it.
   *
   * A manual job has no schedule — it never auto-fires and runs only when
   * triggered via {@link run} / {@link Job.trigger}.
   *
   * @param id - Caller-supplied unique identifier for the job. Unique within
   *   the account and immutable; the service returns 409 if another live job
   *   already uses this id.
   * @param fields.name - Human-readable name for the job.
   * @param fields.configuration - The HTTP request the job sends each time it
   *   runs.
   * @param fields.description - Free-text description for the job. Defaults to
   *   none.
   * @param fields.environments - Per-environment overrides keyed by environment
   *   key. The job is triggerable only in environments enabled here.
   * @param fields.concurrencyPolicy - How overlapping runs are handled.
   *   `"ALLOW"` (the default and only value today) permits a new run to start
   *   while a previous one is still in flight.
   * @returns An unsaved manual {@link Job} bound to this client.
   */
  newManualJob(
    id: string,
    fields: {
      name: string;
      configuration: HttpConfig;
      description?: string | null;
      environments?: Record<string, JobEnvironment>;
      concurrencyPolicy?: string;
    },
  ): Job {
    return this._newJob(id, { ...fields, schedule: null });
  }

  /**
   * Return an unsaved one-off {@link Job}. Call `.save()` to create it.
   *
   * A one-off job runs a single time at `fields.schedule` and is then spent.
   *
   * @param id - Caller-supplied unique identifier for the job. Unique within
   *   the account and immutable; the service returns 409 if another live job
   *   already uses this id.
   * @param fields.name - Human-readable name for the job.
   * @param fields.schedule - The instant the single run fires, as a `Date`.
   * @param fields.configuration - The HTTP request the job sends when it runs.
   * @param fields.description - Free-text description for the job. Defaults to
   *   none.
   * @param fields.concurrencyPolicy - How overlapping runs are handled.
   *   `"ALLOW"` (the default and only value today) permits a new run to start
   *   while a previous one is still in flight.
   * @param fields.environment - The environment the job is born in. Defaults to
   *   the client's configured environment.
   * @returns An unsaved one-off {@link Job} bound to this client.
   */
  schedule(
    id: string,
    fields: {
      name: string;
      schedule: Date;
      configuration: HttpConfig;
      description?: string | null;
      concurrencyPolicy?: string;
      environment?: string;
    },
  ): Job {
    return this._newJob(id, {
      name: fields.name,
      schedule: fields.schedule.toISOString(),
      configuration: fields.configuration,
      description: fields.description,
      concurrencyPolicy: fields.concurrencyPolicy,
      environment: fields.environment,
    });
  }

  /**
   * List jobs in the account.
   *
   * @param params.kind - Return only jobs of this {@link JobKind}. Omit to list
   *   recurring and manual jobs; one-off jobs are omitted unless you pass
   *   {@link JobKind.ONE_OFF}.
   * @param params.scheduled - Return only jobs that have an upcoming fire in
   *   some environment (`true`) or none (`false`) — the feed for an
   *   upcoming-runs view, which includes one-offs. Omit to not filter on
   *   scheduling.
   * @param params.name - Return only jobs whose name contains this text
   *   (case-insensitive). Omit to list all.
   * @param params.pageNumber - 1-based page to return. Omit for the first page.
   * @param params.pageSize - Maximum number of jobs to return in this page.
   *   Omit to use the server default.
   * @returns The jobs in this page.
   */
  async list(params: ListJobsParams = {}): Promise<Job[]> {
    const query: Record<string, string | number | boolean> = {};
    if (params.kind !== undefined) query["filter[kind]"] = params.kind;
    if (params.scheduled !== undefined) query["filter[scheduled]"] = params.scheduled;
    if (params.name !== undefined) query["filter[name]"] = params.name;
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;

    let data: { data?: unknown[] } | undefined;
    try {
      const result = await this._http.GET("/api/v1/jobs", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    return ((data?.data ?? []) as Array<{ id: string; attributes: Record<string, unknown> }>).map(
      (r) => _jobFromResource(r, this),
    );
  }

  /**
   * Fetch a single job by its id.
   *
   * @param id - Identifier of the job to fetch.
   * @returns The matching {@link Job}.
   */
  async get(id: string): Promise<Job> {
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.GET("/api/v1/jobs/{job_id}", {
        params: { path: { job_id: id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _jobFromResource(data.data, this);
  }

  /**
   * Delete a job by its id.
   *
   * @param id - Identifier of the job to delete.
   */
  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/jobs/{job_id}", {
        params: { path: { job_id: id } },
      });
      if (result.response.status !== 204) await checkError(result.response, result.error);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * Trigger one immediate, manual run of a job, ignoring its schedule.
   *
   * This starts an ad-hoc run right now in addition to any scheduled runs; it
   * does not alter the job's schedule. To read or act on existing runs, use
   * `jobs.runs`.
   *
   * @param id - Identifier of the job to run.
   * @param params.environment - Environment the manual run executes in.
   *   Defaults to the client's configured environment; when the job is enabled
   *   in exactly one environment that environment is used. The job must be
   *   enabled in the chosen environment.
   * @returns The {@link Run} that was started, with `trigger` set to
   *   `"MANUAL"`.
   */
  async run(id: string, params: { environment?: string } = {}): Promise<Run> {
    const environment = params.environment ?? this._environment;
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.POST("/api/v1/jobs/{job_id}/actions/run", {
        params: {
          path: { job_id: id },
          ...(environment !== undefined
            ? { header: { "X-Smplkit-Environment": environment } }
            : {}),
        },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _runFromResource(data.data, this.runs);
  }

  /**
   * Report current-period usage against the account's plan allotments.
   *
   * @returns A {@link Usage} snapshot with runs used/included and active-job
   *   counts for the current period.
   */
  async usage(): Promise<Usage> {
    let data: { data: { attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.GET("/api/v1/usage", {});
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return new Usage(data.data.attributes);
  }

  /** @internal — called by `Job.save()` for new resources. */
  async _createJob(job: Job): Promise<Job> {
    const body: GenJobCreateRequest = {
      data: { id: job.id, type: "job", attributes: _jobAttrs(job) },
    };
    // A one-off job is born in the environment named here (recurring and
    // manual jobs ignore it server-side; their environments come from the map).
    const birthEnv = job._birthEnvironment ?? undefined;
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.POST("/api/v1/jobs", {
        ...(birthEnv !== undefined
          ? { params: { header: { "X-Smplkit-Environment": birthEnv } } }
          : {}),
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _jobFromResource(data.data, this);
  }

  /** @internal — full-replace PUT. Called by `Job.save()` for existing resources. */
  async _updateJob(job: Job): Promise<Job> {
    const body: GenJobRequest = {
      data: { id: job.id, type: "job", attributes: _jobAttrs(job) },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.PUT("/api/v1/jobs/{job_id}", {
        params: {
          path: { job_id: job.id },
          ...(this._environment !== undefined
            ? { header: { "X-Smplkit-Environment": this._environment } }
            : {}),
        },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _jobFromResource(data.data, this);
  }

  /** @internal — called by `Job.delete()`. */
  async _deleteJob(id: string): Promise<void> {
    return this.delete(id);
  }

  /**
   * Release HTTP resources — only when this client owns its transport.
   *
   * A jobs client wired by a top-level client shares that client's transport
   * and must not close it here; the owning client's `close()` handles
   * teardown.
   */
  close(): void {
    // openapi-fetch holds no persistent connection to tear down (unlike
    // Python's httpx transport), so an owned transport needs no explicit
    // close. `_ownsTransport` records ownership so a wired client never
    // attempts to release a borrowed transport.
    void this._ownsTransport;
  }
}
