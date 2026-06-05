/**
 * Smpl Jobs management surface — `mgmt.jobs.*`.
 *
 * Unlike Config/Flags/Logging, Jobs has no live "phone-home" agent — no
 * environment registration, no WebSocket — so its entire surface lives on
 * the management client. Defining a job, triggering a run, and reading run
 * history are all plain request/response calls here:
 *
 *   mgmt.jobs.{new,get,list,delete,run,usage}
 *   mgmt.jobs.runs.{list,get,cancel,rerun}
 *   Job.{save,delete}
 *
 * New jobs-management capabilities should be added here.
 */

import createClient from "openapi-fetch";
import type { components, paths } from "../generated/jobs.d.ts";
import { SmplError, SmplConnectionError, throwForStatus } from "../errors.js";
import {
  HttpConfig,
  HttpMethod,
  Job,
  Run,
  Usage,
  type HttpHeader,
  type JobModelClient,
  type ListJobsParams,
  type ListRunsParams,
} from "../jobs/types.js";

type JobsHttp = ReturnType<typeof createClient<paths>>;
type GenJobHttpConfiguration = components["schemas"]["JobHttpConfiguration"];
type GenJob = components["schemas"]["Job"];
type GenJobCreateRequest = components["schemas"]["JobCreateRequest"];
type GenJobRequest = components["schemas"]["JobRequest"];

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
  return {
    name: job.name,
    description: job.description,
    enabled: job.enabled,
    type: job.type as GenJob["type"],
    schedule: job.schedule,
    configuration: _configurationToWire(job.configuration),
    concurrency_policy: job.concurrencyPolicy as GenJob["concurrency_policy"],
  };
}

function _jobFromResource(
  resource: { id: string; attributes: Record<string, unknown> },
  client: JobModelClient,
): Job {
  const a = resource.attributes;
  return new Job(client, {
    id: resource.id,
    name: String(a.name ?? ""),
    description: (a.description as string | null) ?? null,
    enabled: Boolean(a.enabled ?? true),
    type: String(a.type ?? "http"),
    schedule: String(a.schedule ?? ""),
    configuration: _configurationFromWire(a.configuration as Record<string, unknown> | undefined),
    concurrencyPolicy: String(a.concurrency_policy ?? "ALLOW"),
    nextRunAt: (a.next_run_at as string | null) ?? null,
    createdAt: (a.created_at as string | null) ?? null,
    updatedAt: (a.updated_at as string | null) ?? null,
    deletedAt: (a.deleted_at as string | null) ?? null,
    version: (a.version as number | null) ?? null,
  });
}

function _runFromResource(resource: { id: string; attributes: Record<string, unknown> }): Run {
  return new Run(resource.attributes, resource.id);
}

/**
 * `mgmt.jobs.runs.*` — read-only run history plus the cancel / rerun run
 * actions.
 */
export class RunsClient {
  /** @internal */
  constructor(private readonly _http: JobsHttp) {}

  /**
   * List runs for the authenticated account, newest first. Cursor paginated
   * (ADR-014): pass {@link ListRunsParams.pageSize} and the
   * {@link ListRunsParams.after} cursor from the prior page. Pass
   * {@link ListRunsParams.job} to scope to a single job's history.
   */
  async list(params: ListRunsParams = {}): Promise<Run[]> {
    const query: Record<string, string | number> = {};
    if (params.job !== undefined) query["filter[job]"] = params.job;
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
      _runFromResource,
    );
  }

  /** Fetch a single run by id. */
  async get(runId: string): Promise<Run> {
    return this._runAction("GET", "/api/v1/runs/{run_id}", runId);
  }

  /** Cancel a pending run. */
  async cancel(runId: string): Promise<Run> {
    return this._runAction("POST", "/api/v1/runs/{run_id}/actions/cancel", runId);
  }

  /** Re-run a prior run, spawning a new `RERUN` run. */
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
    return _runFromResource(data.data);
  }
}

/**
 * `mgmt.jobs.*` — the management surface for Smpl Jobs: active-record job
 * CRUD, the run-now action, run history (`runs`), and usage.
 */
export class ManagementJobsClient implements JobModelClient {
  /** Run history and run actions. */
  readonly runs: RunsClient;

  /** @internal */
  constructor(private readonly _http: JobsHttp) {
    this.runs = new RunsClient(_http);
  }

  /**
   * Construct an unsaved {@link Job}. Call {@link Job.save} to create it.
   *
   * @param id            Caller-supplied unique identifier for the job.
   *                      Unique within the account and immutable; the service
   *                      returns 409 if another live job already uses this id.
   * @param fields.name   Human-readable name for the job.
   * @param fields.schedule        An ISO-8601 datetime, a 5-field UTC cron
   *                               expression, or the literal `"now"`.
   * @param fields.configuration   The HTTP request the job performs.
   * @param fields.enabled         Whether the job schedules runs. Defaults true.
   * @param fields.description     Optional free-text description.
   * @param fields.concurrencyPolicy  How overlapping runs are handled.
   *                                  Defaults to `"ALLOW"`.
   */
  new(
    id: string,
    fields: {
      name: string;
      schedule: string;
      configuration: HttpConfig;
      enabled?: boolean;
      description?: string | null;
      concurrencyPolicy?: string;
    },
  ): Job {
    return new Job(this, {
      id,
      name: fields.name,
      schedule: fields.schedule,
      configuration: fields.configuration,
      enabled: fields.enabled,
      description: fields.description,
      concurrencyPolicy: fields.concurrencyPolicy,
    });
  }

  /** List jobs for the authenticated account. */
  async list(params: ListJobsParams = {}): Promise<Job[]> {
    const query: Record<string, string | number | boolean> = {};
    if (params.enabled !== undefined) query["filter[enabled]"] = params.enabled;
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
   * Fetch a single job by id. The returned instance is bound to this client
   * so {@link Job.save} and {@link Job.delete} round-trip back here.
   */
  async get(jobId: string): Promise<Job> {
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.GET("/api/v1/jobs/{job_id}", {
        params: { path: { job_id: jobId } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _jobFromResource(data.data, this);
  }

  /** Soft-delete a job by id. */
  async delete(jobId: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/jobs/{job_id}", {
        params: { path: { job_id: jobId } },
      });
      if (result.response.status !== 204) await checkError(result.response, result.error);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** Trigger one immediate `MANUAL` run of the job. */
  async run(jobId: string): Promise<Run> {
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.POST("/api/v1/jobs/{job_id}/actions/run", {
        params: { path: { job_id: jobId } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _runFromResource(data.data);
  }

  /** Current-period usage counters for the account. */
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

  /**
   * @internal Called by `Job.save()` on unsaved instances. The jobs service
   * requires a caller-supplied `data.id` on create.
   */
  async _createJob(job: Job): Promise<Job> {
    const body: GenJobCreateRequest = {
      data: { id: job.id, type: "job", attributes: _jobAttrs(job) },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.POST("/api/v1/jobs", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from jobs");
    return _jobFromResource(data.data, this);
  }

  /**
   * @internal Full-replace PUT. Called by `Job.save()` on instances that
   * already have a `createdAt`. Header values must be re-supplied as
   * plaintext; the GET path redacts them.
   */
  async _updateJob(job: Job): Promise<Job> {
    const body: GenJobRequest = {
      data: { id: job.id, type: "job", attributes: _jobAttrs(job) },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.PUT("/api/v1/jobs/{job_id}", {
        params: { path: { job_id: job.id } },
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

  /** @internal Called by `Job.delete()`. */
  async _deleteJob(id: string): Promise<void> {
    return this.delete(id);
  }
}
