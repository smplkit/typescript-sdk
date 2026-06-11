/**
 * Smpl Jobs resource types.
 *
 * Unlike Config/Flags/Logging, Jobs has no live "phone-home" agent — no
 * environment registration, no WebSocket — so it has no runtime/management
 * split: a single {@link JobsClient} exposes the full surface. A {@link Job}
 * is an active record: build it with `client.jobs.new(...)`, set fields, and
 * call {@link Job.save} (create when new, full-replace update when it already
 * exists) or {@link Job.delete}. Runs are read-only views; run actions live
 * on `client.jobs.runs`.
 *
 * ADR-049.
 */

/** A request header attached to the HTTP request a job performs. */
export interface HttpHeader {
  /** Header name (e.g. `"Authorization"`, `"Content-Type"`). */
  name: string;
  /**
   * Header value, plaintext on writes. The jobs service encrypts values at
   * rest; reads return them redacted.
   */
  value: string;
}

/**
 * HTTP verb a job uses when it fires.
 *
 * Mirrors the jobs service's OpenAPI method enum so callers get
 * autocomplete and a typed value back from `job.configuration.method`.
 */
export enum HttpMethod {
  DELETE = "DELETE",
  GET = "GET",
  PATCH = "PATCH",
  POST = "POST",
  PUT = "PUT",
}

/**
 * The HTTP request a job performs when it fires (the `http` configuration).
 *
 * Extends the shared forwarder shape with the two fields a scheduled job
 * needs beyond a forwarder: a request {@link body} and a per-run
 * {@link timeout}.
 */
export class HttpConfig {
  /** HTTP verb used when the job fires. Defaults to {@link HttpMethod.POST}. */
  method: HttpMethod;
  /** Destination URL the job requests on each run. */
  url: string;
  /** Headers attached to every request. Values are redacted on reads. */
  headers: HttpHeader[];
  /**
   * Request body sent on each run. `null` (the default) sends an empty body,
   * suitable for a connectivity ping. Sent verbatim — pair with a matching
   * `Content-Type` header.
   */
  body: string | null;
  /**
   * Status the destination must return for the run to count as success —
   * either an exact code (`"200"`, `"204"`) or a status class (`"2xx"`,
   * `"4xx"`). Defaults to `"2xx"`.
   */
  successStatus: string;
  /**
   * Per-run timeout in seconds. A run that does not complete within this
   * many seconds fails with reason `TIMEOUT`. Defaults to 30; bounded by
   * your plan's maximum timeout.
   */
  timeout: number;
  /**
   * Whether to verify the destination's TLS certificate chain. Defaults to
   * `true`; flip to `false` only for short-lived testing against an
   * untrusted certificate. Prefer pinning the CA via {@link caCert}.
   */
  tlsVerify: boolean;
  /**
   * Optional PEM-encoded certificate (or bundle) trusted in addition to the
   * system CA store. Ignored when {@link tlsVerify} is `false`. `null` (the
   * default) means "use system CAs only".
   */
  caCert: string | null;

  constructor(fields: {
    url: string;
    method?: HttpMethod;
    headers?: HttpHeader[];
    body?: string | null;
    successStatus?: string;
    timeout?: number;
    tlsVerify?: boolean;
    caCert?: string | null;
  }) {
    this.url = fields.url;
    this.method = fields.method ?? HttpMethod.POST;
    this.headers = fields.headers ?? [];
    this.body = fields.body ?? null;
    this.successStatus = fields.successStatus ?? "2xx";
    this.timeout = fields.timeout ?? 30;
    this.tlsVerify = fields.tlsVerify ?? true;
    this.caCert = fields.caCert ?? null;
  }
}

/**
 * A scheduled unit of work: an HTTP request run on a schedule.
 *
 * Active-record style: mutate fields directly and call {@link save} to
 * persist, or {@link delete} to remove. Header values in
 * `configuration.headers` are returned redacted on reads — re-supply the
 * real values before calling {@link save} (the SDK does not cache them).
 */
export class Job {
  /** Caller-supplied unique identifier for the job (the resource `id`). */
  id: string;
  /** Human-readable name for the job. */
  name: string;
  /** Free-text description. `null` when unset. */
  description: string | null;
  /** Whether the job is scheduling runs. `false` pauses without deleting. */
  enabled: boolean;
  /** Job type. Only `"http"` is supported today. */
  type: string;
  /**
   * When the job runs: an ISO-8601 datetime (a one-off run), a 5-field cron
   * expression evaluated in UTC (recurring), or the literal `"now"` (run
   * once, as soon as possible). A datetime or `"now"` job disables itself
   * after it fires.
   */
  schedule: string;
  /** The HTTP request to perform when the job fires. */
  configuration: HttpConfig;
  /** How overlapping runs are handled. `"ALLOW"` (the only value) permits them. */
  concurrencyPolicy: string;
  /** The next scheduled fire time. `null` once a one-off job has fired. */
  nextRunAt: string | null;
  /** When the job was created. `null` for an unsaved instance. */
  createdAt: string | null;
  /** When the job was last modified. */
  updatedAt: string | null;
  /** Soft-delete timestamp. `null` for live jobs. */
  deletedAt: string | null;
  /** Monotonic version counter; bumped on every server-side write. */
  version: number | null;

  /** @internal */
  _client: JobModelClient | null;

  constructor(
    client: JobModelClient | null,
    fields: {
      id: string;
      name: string;
      schedule: string;
      configuration: HttpConfig;
      description?: string | null;
      enabled?: boolean;
      type?: string;
      concurrencyPolicy?: string;
      nextRunAt?: string | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      deletedAt?: string | null;
      version?: number | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.description = fields.description ?? null;
    this.enabled = fields.enabled ?? true;
    this.type = fields.type ?? "http";
    this.schedule = fields.schedule;
    this.configuration = fields.configuration;
    this.concurrencyPolicy = fields.concurrencyPolicy ?? "ALLOW";
    this.nextRunAt = fields.nextRunAt ?? null;
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
    this.deletedAt = fields.deletedAt ?? null;
    this.version = fields.version ?? null;
  }

  /**
   * Create this job, or full-replace it if it already exists.
   *
   * Upsert behavior is driven by {@link createdAt}: a job with no
   * `createdAt` is created (POST); otherwise it's full-replace updated
   * (PUT). After the call, every field is refreshed from the server
   * response (including newly-assigned `createdAt`, `version`, `nextRunAt`).
   */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Job was constructed without a client; cannot save");
    }
    const other =
      this.createdAt === null
        ? await this._client._createJob(this)
        : await this._client._updateJob(this);
    this._apply(other);
  }

  /** Soft-delete this job on the server. */
  async delete(): Promise<void> {
    if (this._client === null) {
      throw new Error("Job was constructed without a client; cannot delete");
    }
    await this._client._deleteJob(this.id);
  }

  /** @internal Copy every server-authoritative field from `other` onto self. */
  _apply(other: Job): void {
    this.id = other.id;
    this.name = other.name;
    this.description = other.description;
    this.enabled = other.enabled;
    this.type = other.type;
    this.schedule = other.schedule;
    this.configuration = other.configuration;
    this.concurrencyPolicy = other.concurrencyPolicy;
    this.nextRunAt = other.nextRunAt;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
    this.deletedAt = other.deletedAt;
    this.version = other.version;
  }
}

/**
 * A single execution of a job (read-only).
 *
 * Runs are created and mutated by the jobs service, not by clients; clients
 * influence runs only through the `run` / `cancel` / `rerun` actions on
 * `client.jobs`.
 */
export class Run {
  /** Server-assigned UUID for this run. */
  id: string;
  /** The id of the job this run belongs to. */
  job: string;
  /** The job's version at the time the run executed. */
  jobVersion: number | null;
  /** Why the run exists: `SCHEDULE`, `MANUAL` (run now), or `RERUN`. */
  trigger: string;
  /** The source run's id; set only when `trigger` is `RERUN`. */
  rerunOf: string | null;
  /** The intended fire time for a scheduled run; `null` for manual / rerun runs. */
  scheduledFor: string | null;
  /** Lifecycle state of the run. */
  status: string;
  /** When execution started. */
  startedAt: string | null;
  /** When execution finished. */
  finishedAt: string | null;
  /** Milliseconds the run waited as `PENDING` before starting. */
  pendingDurationMs: number | null;
  /** Milliseconds the run spent executing. */
  runDurationMs: number | null;
  /** Milliseconds from enqueue to finish. */
  totalDurationMs: number | null;
  /** Why a `FAILED` run failed; `null` otherwise. */
  failureReason: string | null;
  /** Free-text failure detail, if any. */
  error: string | null;
  /** Snapshot of the request that was sent (header values redacted). */
  request: Record<string, unknown> | null;
  /** Outcome of the call (status, headers, body, ...). */
  result: Record<string, unknown> | null;
  /** When the run was enqueued (became `PENDING`). */
  createdAt: string | null;

  constructor(attributes: Record<string, unknown>, id: string) {
    this.id = id;
    this.job = String(attributes.job ?? "");
    this.jobVersion = (attributes.job_version as number | null) ?? null;
    this.trigger = String(attributes.trigger ?? "");
    this.rerunOf = (attributes.rerun_of as string | null) ?? null;
    this.scheduledFor = (attributes.scheduled_for as string | null) ?? null;
    this.status = String(attributes.status ?? "");
    this.startedAt = (attributes.started_at as string | null) ?? null;
    this.finishedAt = (attributes.finished_at as string | null) ?? null;
    this.pendingDurationMs = (attributes.pending_duration_ms as number | null) ?? null;
    this.runDurationMs = (attributes.run_duration_ms as number | null) ?? null;
    this.totalDurationMs = (attributes.total_duration_ms as number | null) ?? null;
    this.failureReason = (attributes.failure_reason as string | null) ?? null;
    this.error = (attributes.error as string | null) ?? null;
    this.request = (attributes.request as Record<string, unknown> | null) ?? null;
    this.result = (attributes.result as Record<string, unknown> | null) ?? null;
    this.createdAt = (attributes.created_at as string | null) ?? null;
  }
}

/** Current-period usage against the account's plan allotments (read-only). */
export class Usage {
  /** The usage period this report covers, as `YYYY-MM` (UTC). */
  period: string;
  /** Runs metered so far this period. */
  runsUsed: number;
  /** Runs included in the plan this period (`-1` means unlimited). */
  runsIncluded: number;
  /** Number of currently-enabled jobs. */
  activeJobs: number;
  /** Maximum enabled jobs the plan allows (`-1` means unlimited). */
  activeJobsLimit: number;

  constructor(attributes: Record<string, unknown>) {
    this.period = String(attributes.period ?? "");
    this.runsUsed = Number(attributes.runs_used ?? 0);
    this.runsIncluded = Number(attributes.runs_included ?? 0);
    this.activeJobs = Number(attributes.active_jobs ?? 0);
    this.activeJobsLimit = Number(attributes.active_jobs_limit ?? 0);
  }
}

/**
 * @internal Minimal interface that `Job.save()` / `.delete()` call back
 * into. Implemented by `JobsClient` in `src/jobs/client.ts`.
 */
export interface JobModelClient {
  _createJob(job: Job): Promise<Job>;
  _updateJob(job: Job): Promise<Job>;
  _deleteJob(id: string): Promise<void>;
}

/** Parameters accepted by `client.jobs.list(...)`. */
export interface ListJobsParams {
  /** Filter to jobs matching this enabled state. */
  enabled?: boolean;
  /** 1-based page number to return. */
  pageNumber?: number;
  /** Items per page. */
  pageSize?: number;
}

/** Parameters accepted by `client.jobs.runs.list(...)`. */
export interface ListRunsParams {
  /** Filter to a single job's run history, by job id. */
  job?: string;
  /** Items per page (cursor pagination). */
  pageSize?: number;
  /** Opaque cursor token from a prior page's `next` link. */
  after?: string;
}
