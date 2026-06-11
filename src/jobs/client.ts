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
 * A {@link Job} is an active record: build it with {@link JobsClient.new},
 * set fields, and call `save()` (create when new, full-replace update when it
 * already exists) or `delete()`. Runs are read-only views; run actions live on
 * `jobs.runs`.
 *
 * Every call delegates HTTP to the auto-generated openapi-fetch client over
 * `../generated/jobs.d.ts`; this wrapper only shapes models and raises SDK
 * exceptions.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components, paths } from "../generated/jobs.d.ts";
import { SmplError, SmplConnectionError, throwForStatus } from "../errors.js";
import { resolveManagementConfig, serviceUrl } from "../config.js";
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
} from "./types.js";

type JobsHttp = ReturnType<typeof createClient<paths>>;
type GenJobHttpConfiguration = components["schemas"]["JobHttpConfiguration"];
type GenJob = components["schemas"]["Job"];
type GenJobCreateRequest = components["schemas"]["JobCreateRequest"];
type GenJobRequest = components["schemas"]["JobRequest"];

const JSONAPI_CONTENT_TYPE = "application/vnd.api+json";

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

/** Run history and run actions (`jobs.runs`). */
export class RunsClient {
  /** @internal */
  constructor(private readonly _http: JobsHttp) {}

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

  async get(runId: string): Promise<Run> {
    return this._runAction("GET", "/api/v1/runs/{run_id}", runId);
  }

  async cancel(runId: string): Promise<Run> {
    return this._runAction("POST", "/api/v1/runs/{run_id}/actions/cancel", runId);
  }

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
 * The full surface — active-record job CRUD (`new` / `get` / `list` /
 * `delete`), the run-now action (`run`), run history and run actions
 * (`runs`), and usage (`usage`) — lives on this one class. Jobs installs no
 * in-process machinery, so there is no live connection and no install step.
 */
export class JobsClient implements JobModelClient {
  /** @internal */
  private readonly _http: JobsHttp;
  /** @internal */
  private readonly _ownsTransport: boolean;

  /** Run history and run actions. */
  readonly runs: RunsClient;

  constructor(options: JobsClientOptions = {}) {
    if (options.transport !== undefined) {
      this._http = options.transport;
      this._ownsTransport = false;
    } else {
      const cfg = resolveManagementConfig(options);
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
    this.runs = new RunsClient(this._http);
  }

  /**
   * Return an unsaved {@link Job}. Call `.save()` to create it.
   *
   * @param id - Caller-supplied unique identifier for the job. Unique within
   *   the account and immutable; the service returns 409 if another live job
   *   already uses this id.
   */
  new(
    id: string,
    fields: {
      name: string;
      schedule: string;
      configuration: HttpConfig;
      description?: string | null;
      enabled?: boolean;
      concurrencyPolicy?: string;
    },
  ): Job {
    return new Job(this, {
      id,
      name: fields.name,
      schedule: fields.schedule,
      configuration: fields.configuration,
      description: fields.description,
      enabled: fields.enabled,
      concurrencyPolicy: fields.concurrencyPolicy,
    });
  }

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

  /** Trigger one immediate `MANUAL` run of the job. */
  async run(id: string): Promise<Run> {
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.POST("/api/v1/jobs/{job_id}/actions/run", {
        params: { path: { job_id: id } },
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

  /** @internal — called by `Job.save()` for new resources. */
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

  /** @internal — full-replace PUT. Called by `Job.save()` for existing resources. */
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
