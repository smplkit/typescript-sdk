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
 */

/** A request header attached to the HTTP request a job performs. */
export interface HttpHeader {
  /** Header name (e.g. `"Authorization"`, `"Content-Type"`). */
  name: string;
  /**
   * Header value. Returned in plaintext on reads, so a get-mutate-put
   * round-trip preserves it without re-entering secrets.
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
  /**
   * Headers attached to every request. Values often carry credentials and
   * are returned in plaintext on reads, so a get-mutate-put round-trip
   * preserves them without re-entering secrets.
   */
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
 * Per-environment override for a job's enablement, schedule, and configuration.
 *
 * A recurring job fires in a given environment only when that environment has
 * an entry in {@link Job.environments} with `enabled` set to `true`; an
 * environment with no entry (or `enabled` false) does not fire there. An entry
 * may carry its own cron {@link schedule} override (varying the cadence within
 * that environment) and exposes the read-only {@link nextRunAt} for it.
 */
export class JobEnvironment {
  /** Whether the job schedules runs in this environment. Defaults to `false`. */
  enabled: boolean;
  /**
   * Optional per-environment cron schedule override. `null` (the default)
   * inherits the job's base {@link Job.schedule}. When set, it must be a
   * 5-field cron expression evaluated in UTC; it only applies to a recurring
   * job and varies that environment's cadence — it cannot turn a one-off job
   * recurring or vice-versa.
   */
  schedule: string | null;
  /**
   * Optional per-environment request configuration that fully replaces the
   * job's base {@link Job.configuration} for this environment. `null` (the
   * default) inherits the base configuration.
   */
  configuration: HttpConfig | null;
  /**
   * Read-only: the next scheduled fire time in this environment. `null` when
   * the environment is not enabled, or once a one-off run has fired. Populated
   * from the server on reads; never sent on writes.
   */
  nextRunAt: string | null;

  constructor(
    fields: {
      enabled?: boolean;
      schedule?: string | null;
      configuration?: HttpConfig | null;
      nextRunAt?: string | null;
    } = {},
  ) {
    this.enabled = fields.enabled ?? false;
    this.schedule = fields.schedule ?? null;
    this.configuration = fields.configuration ?? null;
    this.nextRunAt = fields.nextRunAt ?? null;
  }
}

/**
 * A scheduled unit of work: an HTTP request run on a schedule.
 *
 * Active-record style: mutate fields directly and call {@link save} to
 * persist, or {@link delete} to remove. A job is enabled per environment via
 * {@link environments}: a recurring job may be enabled in several environments
 * at once; a one-off job is born in a single environment. Header values in
 * `configuration.headers` are returned in plaintext on reads, so fetching a
 * job, mutating it, and calling {@link save} preserves its header values
 * without re-entering secrets.
 */
export class Job {
  /** Caller-supplied unique identifier for the job (the resource `id`). */
  id: string;
  /** Human-readable name for the job. */
  name: string;
  /** Free-text description. `null` when unset. */
  description: string | null;
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
  /**
   * Per-environment overrides keyed by environment key (e.g. `"production"`,
   * `"staging"`). A job fires in an environment only when
   * `environments[env].enabled` is `true`. Each entry may carry an optional
   * {@link HttpConfig} override; omit it to inherit the base
   * {@link configuration}. For a recurring job, supply this map to choose
   * where it runs; a one-off job records the single environment it was created
   * in. Every referenced environment must exist for the account.
   */
  environments: Record<string, JobEnvironment>;
  /**
   * Read-only: `true` for a recurring (cron) schedule, `false` for a one-off
   * datetime / `"now"` schedule. Derived from {@link schedule} by the server.
   */
  recurring: boolean | null;
  /** How overlapping runs are handled. `"ALLOW"` (the only value) permits them. */
  concurrencyPolicy: string;
  /** When the job was created. `null` for an unsaved instance. */
  createdAt: string | null;
  /** When the job was last modified. */
  updatedAt: string | null;
  /** When the job was deleted; `null` for live jobs. */
  deletedAt: string | null;
  /** Monotonic version counter; bumped on every server-side write. */
  version: number | null;

  /**
   * Whether the job is enabled in at least one environment. Read-only roll-up
   * derived from {@link environments} — `true` iff any environment override has
   * `enabled` set. Set enablement per environment via {@link setEnabled}; this
   * value is never read from the wire.
   */
  get enabled(): boolean {
    return Object.values(this.environments).some((env) => env.enabled);
  }

  /** @internal */
  _client: JobModelClient | null;

  /**
   * @internal Creation-time only: the environment a one-off job is born in,
   * sent as the `X-Smplkit-Environment` header by `_createJob`. Ignored for a
   * recurring job, whose environments come from {@link environments}.
   */
  _birthEnvironment: string | null;

  /** @internal */
  constructor(
    client: JobModelClient | null,
    fields: {
      id: string;
      name: string;
      schedule: string;
      configuration: HttpConfig;
      description?: string | null;
      environments?: Record<string, JobEnvironment>;
      recurring?: boolean | null;
      type?: string;
      concurrencyPolicy?: string;
      createdAt?: string | null;
      updatedAt?: string | null;
      deletedAt?: string | null;
      version?: number | null;
      birthEnvironment?: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.description = fields.description ?? null;
    this.environments = fields.environments ?? {};
    this.recurring = fields.recurring ?? null;
    this.type = fields.type ?? "http";
    this.schedule = fields.schedule;
    this.configuration = fields.configuration;
    this.concurrencyPolicy = fields.concurrencyPolicy ?? "ALLOW";
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
    this.deletedAt = fields.deletedAt ?? null;
    this.version = fields.version ?? null;
    this._birthEnvironment = fields.birthEnvironment ?? null;
  }

  /**
   * Create this job, or full-replace it if it already exists.
   *
   * Upsert behavior is driven by {@link createdAt}: a job with no
   * `createdAt` is created (POST); otherwise it's full-replace updated
   * (PUT). After the call, every field is refreshed from the server
   * response (including newly-assigned `createdAt`, `version`, and each
   * environment's read-only `nextRunAt`).
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

  /** Delete this job on the server. */
  async delete(): Promise<void> {
    if (this._client === null) {
      throw new Error("Job was constructed without a client; cannot delete");
    }
    await this._client._deleteJob(this.id);
  }

  /**
   * Return the override for `environment`, creating an empty one if absent.
   * @internal
   */
  private _environmentOverride(environment: string): JobEnvironment {
    let env = this.environments[environment];
    if (env === undefined) {
      env = new JobEnvironment();
      this.environments[environment] = env;
    }
    return env;
  }

  /**
   * Enable or disable the job in a single environment, in memory. Call
   * {@link save} to persist. Creates the override entry if it doesn't exist
   * yet (preserving any already-set `configuration` on it).
   */
  setEnabled(enabled: boolean, environment: string): void {
    this._environmentOverride(environment).enabled = enabled;
  }

  /**
   * Whether the job is enabled. With `environment` omitted, returns the
   * roll-up ({@link enabled} — enabled in at least one environment); with an
   * `environment`, returns whether the job is enabled in that environment.
   */
  isEnabled(environment?: string): boolean {
    if (environment === undefined) return this.enabled;
    const override = this.environments[environment];
    return override !== undefined && override.enabled;
  }

  /**
   * Set the job's configuration in memory — the base configuration with
   * `environment` omitted, or a per-environment override otherwise. Call
   * {@link save} to persist.
   */
  setConfiguration(configuration: HttpConfig, environment?: string): void {
    if (environment === undefined) {
      this.configuration = configuration;
    } else {
      this._environmentOverride(environment).configuration = configuration;
    }
  }

  /**
   * The job's effective configuration. With `environment` omitted, the base
   * configuration; with an `environment`, that environment's override when it
   * has one, else the base — the request the job actually sends when it fires
   * in that environment.
   */
  getConfiguration(environment?: string): HttpConfig {
    if (environment !== undefined) {
      const override = this.environments[environment];
      if (override !== undefined && override.configuration !== null) {
        return override.configuration;
      }
    }
    return this.configuration;
  }

  /**
   * Set the job's schedule in memory — the base {@link schedule} with
   * `environment` omitted, or a per-environment cron override otherwise. A
   * per-environment override varies the cadence in that environment only and
   * applies to recurring jobs; omit `environment` to set the schedule every
   * environment inherits. Setting a per-environment override creates the
   * override entry if it doesn't exist yet (preserving any already-set
   * `enabled` / `configuration` on it). Call {@link save} to persist.
   */
  setSchedule(schedule: string, environment?: string): void {
    if (environment === undefined) {
      this.schedule = schedule;
    } else {
      this._environmentOverride(environment).schedule = schedule;
    }
  }

  /**
   * Trigger one immediate, manual run of this job (a `MANUAL` run).
   *
   * @param environment - Environment the run executes in. Defaults to the
   *   client's configured environment; when the job is enabled in exactly one
   *   environment that environment is used.
   * @returns The {@link Run} that was started.
   */
  async trigger(environment?: string): Promise<Run> {
    if (this._client === null) {
      throw new Error("Job was constructed without a client; cannot trigger a run");
    }
    return this._client.run(this.id, { environment });
  }

  /**
   * List this job's run history, most recent first.
   *
   * @param params.environment - Restrict to runs stamped with this
   *   environment. Omit to cover every environment you can access.
   * @param params.pageSize - Maximum number of runs to return in this page.
   * @param params.after - Opaque cursor from a previous page.
   * @returns The runs in this page.
   */
  async listRuns(
    params: { environment?: string; pageSize?: number; after?: string } = {},
  ): Promise<Run[]> {
    if (this._client === null) {
      throw new Error("Job was constructed without a client; cannot list runs");
    }
    return this._client.runs.list({
      job: this.id,
      environments: params.environment === undefined ? undefined : [params.environment],
      pageSize: params.pageSize,
      after: params.after,
    });
  }

  /** @internal Copy every server-authoritative field from `other` onto self. */
  _apply(other: Job): void {
    this.id = other.id;
    this.name = other.name;
    this.description = other.description;
    this.environments = other.environments;
    this.recurring = other.recurring;
    this.type = other.type;
    this.schedule = other.schedule;
    this.configuration = other.configuration;
    this.concurrencyPolicy = other.concurrencyPolicy;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
    this.deletedAt = other.deletedAt;
    this.version = other.version;
  }
}

/**
 * A single execution of a job.
 *
 * Read-only apart from the {@link rerun} / {@link cancel} actions: a run is
 * created and driven by the jobs service, not by clients.
 */
export class Run {
  /** Server-assigned UUID for this run. */
  id: string;
  /** The id of the job this run belongs to. */
  job: string;
  /** The job's version at the time the run executed. */
  jobVersion: number | null;
  /**
   * The environment this run executed in. A scheduled run inherits the firing
   * job-environment; a manual run is created in the environment named by the
   * `X-Smplkit-Environment` header; a rerun copies its source run's
   * environment.
   */
  environment: string;
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

  /** @internal */
  _runs: RunModelClient | null;

  /** @internal */
  constructor(attributes: Record<string, unknown>, id: string, runs: RunModelClient | null = null) {
    this._runs = runs;
    this.id = id;
    this.job = String(attributes.job ?? "");
    this.jobVersion = (attributes.job_version as number | null) ?? null;
    this.environment = String(attributes.environment ?? "");
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

  /** Start a new run that repeats this one (a `RERUN`), in the same environment. */
  async rerun(): Promise<Run> {
    if (this._runs === null) {
      throw new Error("Run was constructed without a client; cannot rerun");
    }
    return this._runs.rerun(this.id);
  }

  /** Cancel this run if it has not finished yet. */
  async cancel(): Promise<Run> {
    if (this._runs === null) {
      throw new Error("Run was constructed without a client; cannot cancel");
    }
    return this._runs.cancel(this.id);
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
 * @internal Minimal interface that `Job.save()` / `.delete()` / `.trigger()` /
 * `.listRuns()` call back into. Implemented by `JobsClient` in
 * `src/jobs/client.ts`.
 */
export interface JobModelClient {
  _createJob(job: Job): Promise<Job>;
  _updateJob(job: Job): Promise<Job>;
  _deleteJob(id: string): Promise<void>;
  run(id: string, params?: { environment?: string }): Promise<Run>;
  readonly runs: { list(params?: ListRunsParams): Promise<Run[]> };
}

/**
 * @internal Minimal interface that `Run.rerun()` / `.cancel()` call back into.
 * Implemented by `RunsClient` in `src/jobs/client.ts`.
 */
export interface RunModelClient {
  cancel(runId: string): Promise<Run>;
  rerun(runId: string): Promise<Run>;
}

/** Parameters accepted by `client.jobs.list(...)`. */
export interface ListJobsParams {
  /** Filter to recurring (`true`) or one-off (`false`) jobs. Omit to list both. */
  recurring?: boolean;
  /** Filter to jobs whose name contains this text (case-insensitive). Omit to list all. */
  name?: string;
  /** 1-based page number to return. */
  pageNumber?: number;
  /** Items per page. */
  pageSize?: number;
}

/** Parameters accepted by `client.jobs.runs.list(...)`. */
export interface ListRunsParams {
  /** Filter to a single job's run history, by job id. */
  job?: string;
  /**
   * Restrict to runs stamped with any of these environment keys. Omit to fall
   * back to the client's configured environment (if any), otherwise covering
   * every environment you can access.
   */
  environments?: string[];
  /** Items per page (cursor pagination). */
  pageSize?: number;
  /** Opaque cursor token from a prior page's `next` link. */
  after?: string;
}
