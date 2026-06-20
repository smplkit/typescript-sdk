/**
 * Smpl Jobs resource types.
 *
 * Unlike Config/Flags/Logging, Jobs has no live "phone-home" agent — no
 * environment registration, no WebSocket — so it has no runtime/management
 * split: a single {@link JobsClient} exposes the full surface. A {@link Job}
 * is an active record: build it with `client.jobs.newRecurringJob(...)` (or
 * `newManualJob(...)` / `schedule(...)`), set fields, and
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
 * How a job runs, derived from its schedule (read-only).
 *
 * - {@link MANUAL}: no schedule — never auto-fires; runs only when triggered.
 * - {@link ONE_OFF}: a `"now"` or datetime schedule — runs a single time, then
 *   is spent.
 * - {@link RECURRING}: a cron schedule — fires on a repeating cadence.
 */
export enum JobKind {
  MANUAL = "manual",
  ONE_OFF = "one_off",
  RECURRING = "recurring",
}

/**
 * What started a run (read-only).
 *
 * - {@link MANUAL}: a `run`/`trigger` call started it on demand.
 * - {@link RERUN}: it repeats an earlier run.
 * - {@link RETRY}: an automatic retry of a failed run, per the job's retry policy.
 * - {@link SCHEDULE}: the job's schedule fired.
 */
export enum RunTrigger {
  MANUAL = "MANUAL",
  RERUN = "RERUN",
  RETRY = "RETRY",
  SCHEDULE = "SCHEDULE",
}

/**
 * How the wait between retries grows (a retry policy's backoff strategy).
 *
 * - {@link EXPONENTIAL}: double the wait each retry — `delaySeconds`, then `2×`,
 *   `4×`, … — capped at `maxDelaySeconds`.
 * - {@link FIXED}: wait a constant `delaySeconds` before every retry.
 */
export enum Backoff {
  EXPONENTIAL = "exponential",
  FIXED = "fixed",
}

/**
 * A failure category a retry policy can retry on.
 *
 * - {@link CONNECTION_ERROR}: the endpoint could not be reached.
 * - {@link NON_SUCCESS_STATUS}: any non-success response, regardless of
 *   `statuses`.
 * - {@link TIMEOUT}: the run did not complete in time.
 */
export enum RetryReason {
  CONNECTION_ERROR = "CONNECTION_ERROR",
  NON_SUCCESS_STATUS = "NON_SUCCESS_STATUS",
  TIMEOUT = "TIMEOUT",
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
 * Which failures a retry policy retries.
 *
 * An empty `RetryOn` (both lists empty) retries nothing.
 */
export class RetryOn {
  /**
   * Response status codes to retry when a run fails because the response did
   * not match the job's success status (e.g. `[429, 503]` for rate-limit and
   * unavailable). Each is a 3-digit HTTP code. Defaults to none.
   */
  statuses: number[];
  /**
   * Failure categories to retry (see {@link RetryReason}). Defaults to none.
   */
  reasons: RetryReason[];

  constructor(fields: { statuses?: number[]; reasons?: RetryReason[] } = {}) {
    this.statuses = fields.statuses ?? [];
    this.reasons = fields.reasons ?? [];
  }
}

/**
 * Per-environment override for a job's enablement, schedule, and configuration.
 *
 * A job runs in a given environment only when that environment has an entry in
 * {@link Job.environments} with `enabled` set to `true` (scheduled there for a
 * recurring job, triggerable there for a manual one); an environment with no
 * entry (or `enabled` false) is disabled there. An entry may carry its own cron
 * {@link schedule} override (varying the cadence within that environment) and
 * exposes the read-only {@link nextRunAt} for it.
 */
export class JobEnvironment {
  /** Whether the job is enabled in this environment. Defaults to `false`. */
  enabled: boolean;
  /**
   * Optional per-environment cron schedule override. `null` (the default)
   * inherits the job's base {@link Job.schedule}. When set, it must be a
   * 5-field cron expression evaluated in UTC; it only applies to a recurring
   * job and varies that environment's cadence — it cannot appear on a manual or
   * one-off job, and cannot change a job's kind.
   */
  schedule: string | null;
  /**
   * Optional per-environment IANA timezone override for evaluating this
   * environment's cron {@link schedule} (recurring jobs only). `null` (the
   * default) inherits the job's base {@link Job.timezone}, else UTC. When set,
   * it must be a valid IANA zone key (e.g. `"America/New_York"`); it may be set
   * on an environment that inherits the base schedule (it need not also override
   * {@link schedule}).
   */
  timezone: string | null;
  /**
   * Optional per-environment retry-policy override — the id of a
   * {@link RetryPolicy} (or `"Default"`). `null` (the default) inherits the
   * job's base {@link Job.retryPolicy}. Sent on writes only when set.
   */
  retryPolicy: string | null;
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
      timezone?: string | null;
      retryPolicy?: string | null;
      configuration?: HttpConfig | null;
      nextRunAt?: string | null;
    } = {},
  ) {
    this.enabled = fields.enabled ?? false;
    this.schedule = fields.schedule ?? null;
    this.timezone = fields.timezone ?? null;
    this.retryPolicy = fields.retryPolicy ?? null;
    this.configuration = fields.configuration ?? null;
    this.nextRunAt = fields.nextRunAt ?? null;
  }
}

/**
 * A unit of work: an HTTP request, run on a schedule or triggered on demand.
 *
 * Active-record style: mutate fields directly and call {@link save} to
 * persist, or {@link delete} to remove. A job is enabled per environment via
 * {@link environments}: a recurring or manual job may be enabled in several
 * environments at once; a one-off job is born in a single environment. A job's
 * {@link kind} follows from its {@link schedule}. Header values in
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
   * The base schedule that determines the job's {@link kind}, inherited by
   * every environment unless it overrides it. `null` (no schedule) is a manual
   * job that never auto-fires and runs only when triggered; a 5-field cron
   * expression evaluated in UTC is recurring; an ISO-8601 datetime or the
   * literal `"now"` is a one-off run. A datetime or `"now"` job disables itself
   * after it fires.
   */
  schedule: string | null;
  /**
   * The base IANA timezone the cron {@link schedule} is evaluated in (e.g.
   * `"America/New_York"`); `null` means UTC. The base every environment inherits
   * unless it sets its own {@link JobEnvironment.timezone}. The cron fires on
   * this zone's wall clock (DST-aware) while each environment's `nextRunAt` is
   * still reported as a UTC instant. Only valid on a recurring (cron) job —
   * `null` for a manual or one-off job. Sent on writes only when set.
   */
  timezone: string | null;
  /**
   * The base retry policy for failed runs — the id of a {@link RetryPolicy} (or
   * the built-in `"Default"`, which never retries), overridable per environment
   * via {@link JobEnvironment.retryPolicy}. `null` (omitted on the wire) means
   * the server default `"Default"` policy. Sent on writes only when set.
   */
  retryPolicy: string | null;
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
   * Read-only server-derived kind (see {@link JobKind}): `RECURRING` for a cron
   * schedule, `ONE_OFF` for a datetime / `"now"` schedule, `MANUAL` for no
   * schedule. Derived from {@link schedule} by the server.
   */
  kind: JobKind | null;
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

  /** Whether this is a recurring (cron-scheduled) job. */
  isRecurring(): boolean {
    return this.kind === JobKind.RECURRING;
  }

  /** Whether this is a manual job — no schedule; runs only when triggered. */
  isManual(): boolean {
    return this.kind === JobKind.MANUAL;
  }

  /** Whether this is a one-off job — a single `"now"` / datetime run. */
  isOneOff(): boolean {
    return this.kind === JobKind.ONE_OFF;
  }

  /** @internal */
  _client: JobModelClient | null;

  /**
   * @internal Creation-time only: the environment a one-off job is born in,
   * sent as the `X-Smplkit-Environment` header by `_createJob`. Ignored for
   * recurring and manual jobs, whose environments come from
   * {@link environments}.
   */
  _birthEnvironment: string | null;

  /** @internal */
  constructor(
    client: JobModelClient | null,
    fields: {
      id: string;
      name: string;
      schedule: string | null;
      timezone?: string | null;
      retryPolicy?: string | null;
      configuration: HttpConfig;
      description?: string | null;
      environments?: Record<string, JobEnvironment>;
      kind?: JobKind | null;
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
    this.kind = fields.kind ?? null;
    this.type = fields.type ?? "http";
    this.schedule = fields.schedule;
    this.timezone = fields.timezone ?? null;
    this.retryPolicy = fields.retryPolicy ?? null;
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
   * `enabled` / `configuration` on it).
   *
   * Because the timezone is an integral part of a cron cadence, an optional
   * `timezone` may be supplied alongside the schedule; when given it sets the
   * same scope's timezone too (equivalent to a follow-up {@link setTimezone}).
   * Omit it to leave the timezone untouched. For a timezone-only change, use
   * {@link setTimezone}. Call {@link save} to persist.
   */
  setSchedule(schedule: string, timezone?: string, environment?: string): void {
    if (environment === undefined) {
      this.schedule = schedule;
    } else {
      this._environmentOverride(environment).schedule = schedule;
    }
    if (timezone !== undefined) {
      this.setTimezone(timezone, environment);
    }
  }

  /**
   * Set the IANA timezone the cron schedule is evaluated in — the base
   * {@link timezone} with `environment` omitted, or a per-environment override
   * otherwise. A timezone is only valid on a recurring (cron) job; omit
   * `environment` to set the timezone every environment inherits. A
   * per-environment override evaluates that environment's cadence on the named
   * zone's wall clock. Setting a per-environment override creates the override
   * entry if it doesn't exist yet (preserving any already-set `enabled` /
   * `schedule` / `configuration` on it). Call {@link save} to persist.
   */
  setTimezone(timezone: string, environment?: string): void {
    if (environment === undefined) {
      this.timezone = timezone;
    } else {
      this._environmentOverride(environment).timezone = timezone;
    }
  }

  /**
   * Set the retry policy for failed runs in memory — the base
   * {@link retryPolicy} with `environment` omitted, or a per-environment
   * override otherwise. Accepts either a {@link RetryPolicy} instance (its id is
   * used) or a policy id string — pass `"Default"` for the built-in never-retry
   * policy. Setting a per-environment override creates the override entry if it
   * doesn't exist yet (preserving any already-set `enabled` / `schedule` /
   * `timezone` / `configuration` on it). Call {@link save} to persist.
   */
  setRetryPolicy(retryPolicy: RetryPolicy | string, environment?: string): void {
    const policyId = retryPolicy instanceof RetryPolicy ? retryPolicy.id : retryPolicy;
    if (environment === undefined) {
      this.retryPolicy = policyId;
    } else {
      this._environmentOverride(environment).retryPolicy = policyId;
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
   * @param params.triggers - Restrict to runs started by any of these triggers
   *   (see {@link RunTrigger}) — e.g. `[RunTrigger.RETRY]` for automatic
   *   retries. Omit to cover every trigger.
   * @param params.lastRunOnly - When `true`, return only the last completed run
   *   per environment (in-flight runs excluded). Defaults to `false`.
   * @param params.pageSize - Maximum number of runs to return in this page.
   * @param params.after - Opaque cursor from a previous page.
   * @returns The runs in this page.
   */
  async listRuns(
    params: {
      environment?: string;
      triggers?: RunTrigger[];
      lastRunOnly?: boolean;
      pageSize?: number;
      after?: string;
    } = {},
  ): Promise<Run[]> {
    if (this._client === null) {
      throw new Error("Job was constructed without a client; cannot list runs");
    }
    return this._client.runs.list({
      job: this.id,
      environments: params.environment === undefined ? undefined : [params.environment],
      triggers: params.triggers,
      lastRunOnly: params.lastRunOnly,
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
    this.kind = other.kind;
    this.type = other.type;
    this.schedule = other.schedule;
    this.timezone = other.timezone;
    this.retryPolicy = other.retryPolicy;
    this.configuration = other.configuration;
    this.concurrencyPolicy = other.concurrencyPolicy;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
    this.deletedAt = other.deletedAt;
    this.version = other.version;
  }
}

/**
 * Where a `RETRY` run sits in its retry chain (read-only).
 */
export class RunRetry {
  /**
   * Id of the chain's original run — the first attempt that failed and started
   * the chain.
   */
  of: string;
  /**
   * Which retry this run is — `1` for the first retry, `2` for the second, and
   * so on.
   */
  attempt: number;

  constructor(of: string, attempt: number) {
    this.of = of;
    this.attempt = attempt;
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
  /**
   * Why the run exists. A raw string; compare against the {@link RunTrigger}
   * constants — `SCHEDULE`, `MANUAL` (run now), or `RERUN`.
   */
  trigger: string;
  /** The source run's id; set only when `trigger` is `RERUN`. */
  rerunOf: string | null;
  /**
   * Retry-chain position, present only when `trigger` is `RETRY` (`null`
   * otherwise): the original run the chain retries and this run's attempt
   * number. See {@link RunRetry}.
   */
  retry: RunRetry | null;
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
    // Retry-chain position is sent only on RETRY runs; parse it when present.
    const retry = attributes.retry as { of?: unknown; attempt?: unknown } | null | undefined;
    this.retry = retry ? new RunRetry(String(retry.of), Number(retry.attempt)) : null;
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
  /** Number of permanent jobs (recurring and manual) counted against the plan's job limit. */
  activeJobs: number;
  /** Maximum permanent jobs the plan allows (`-1` means unlimited). */
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
 * A named, reusable automatic-retry policy.
 *
 * Active-record style: build one with `client.jobs.retryPolicies.new(...)`,
 * mutate fields, and call {@link save} (create when new, full-replace update
 * when it already exists) or {@link delete}. Reference it from a job's
 * {@link Job.retryPolicy} (see {@link Job.setRetryPolicy}). Retry policies are
 * account-global — never environment-scoped.
 */
export class RetryPolicy {
  /** Caller-supplied unique identifier for the policy (the resource `id`); immutable. */
  id: string;
  /** Human-readable name for the policy. */
  name: string;
  /**
   * How many times a failed run is retried after the initial attempt — `3`
   * means up to 4 attempts total. `0` disables retries. Maximum 10.
   */
  maxRetries: number;
  /** How the wait between retries grows (see {@link Backoff}). */
  backoff: Backoff;
  /**
   * The wait before a retry, in seconds — the constant wait for `fixed`
   * backoff, or the base that doubles each retry for `exponential`.
   */
  delaySeconds: number;
  /**
   * Ceiling on the wait between retries, for `exponential` backoff only. `null`
   * (the default) leaves it uncapped and is omitted on the wire; invalid with
   * `fixed` backoff.
   */
  maxDelaySeconds: number | null;
  /** Which failures to retry (see {@link RetryOn}). An empty `RetryOn` retries nothing. */
  retryOn: RetryOn;
  /** When the policy was created. `null` for an unsaved instance. */
  createdAt: string | null;
  /** When the policy was last modified. */
  updatedAt: string | null;
  /** When the policy was deleted; `null` for live policies. */
  deletedAt: string | null;
  /** Monotonic version counter; bumped on every server-side write. */
  version: number | null;

  /** @internal */
  _client: RetryPolicyModelClient | null;

  /** @internal */
  constructor(
    client: RetryPolicyModelClient | null,
    fields: {
      id: string;
      name: string;
      maxRetries: number;
      backoff: Backoff;
      delaySeconds: number;
      maxDelaySeconds?: number | null;
      retryOn?: RetryOn | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      deletedAt?: string | null;
      version?: number | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.maxRetries = fields.maxRetries;
    this.backoff = fields.backoff;
    this.delaySeconds = fields.delaySeconds;
    this.maxDelaySeconds = fields.maxDelaySeconds ?? null;
    this.retryOn = fields.retryOn ?? new RetryOn();
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
    this.deletedAt = fields.deletedAt ?? null;
    this.version = fields.version ?? null;
  }

  /**
   * Create this policy, or full-replace it if it already exists.
   *
   * Upsert behavior is driven by {@link createdAt}: a policy with no
   * `createdAt` is created (POST); otherwise it's full-replace updated (PUT).
   * After the call, every field is refreshed from the server response.
   */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("RetryPolicy was constructed without a client; cannot save");
    }
    const other =
      this.createdAt === null
        ? await this._client._createRetryPolicy(this)
        : await this._client._updateRetryPolicy(this);
    this._apply(other);
  }

  /** Delete this policy on the server. */
  async delete(): Promise<void> {
    if (this._client === null) {
      throw new Error("RetryPolicy was constructed without a client; cannot delete");
    }
    await this._client._deleteRetryPolicy(this.id);
  }

  /** @internal Copy every server-authoritative field from `other` onto self. */
  _apply(other: RetryPolicy): void {
    this.id = other.id;
    this.name = other.name;
    this.maxRetries = other.maxRetries;
    this.backoff = other.backoff;
    this.delaySeconds = other.delaySeconds;
    this.maxDelaySeconds = other.maxDelaySeconds;
    this.retryOn = other.retryOn;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
    this.deletedAt = other.deletedAt;
    this.version = other.version;
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

/**
 * @internal Minimal interface that `RetryPolicy.save()` / `.delete()` call back
 * into. Implemented by `RetryPoliciesClient` in `src/jobs/client.ts`.
 */
export interface RetryPolicyModelClient {
  _createRetryPolicy(policy: RetryPolicy): Promise<RetryPolicy>;
  _updateRetryPolicy(policy: RetryPolicy): Promise<RetryPolicy>;
  _deleteRetryPolicy(id: string): Promise<void>;
}

/** Parameters accepted by `client.jobs.list(...)`. */
export interface ListJobsParams {
  /**
   * Filter to jobs of this {@link JobKind}. Omit to list recurring and manual
   * jobs; one-off jobs are omitted unless you pass {@link JobKind.ONE_OFF}.
   */
  kind?: JobKind;
  /**
   * Filter to jobs that have an upcoming fire in some environment (`true`) or
   * none (`false`) — the feed for an upcoming-runs view, which includes
   * one-offs. Omit to not filter on scheduling.
   */
  scheduled?: boolean;
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
  /**
   * Restrict to runs started by any of these triggers (see {@link RunTrigger})
   * — serialized as a comma-joined `filter[trigger]` (any-of). Omit (or pass an
   * empty array) to cover every trigger.
   */
  triggers?: RunTrigger[];
  /**
   * When `true`, collapse the result to the last completed (succeeded / failed
   * / canceled) run per job-and-environment; in-flight runs are excluded. Other
   * filters apply first, then the collapse. Defaults to `false`; only sent on
   * the wire when `true`.
   */
  lastRunOnly?: boolean;
  /** Items per page (cursor pagination). */
  pageSize?: number;
  /** Opaque cursor token from a prior page's `next` link. */
  after?: string;
}

/** Parameters accepted by `client.jobs.retryPolicies.list(...)`. */
export interface ListRetryPoliciesParams {
  /** Filter to policies whose name contains this text (case-insensitive). Omit to list all. */
  name?: string;
  /** 1-based page number to return. */
  pageNumber?: number;
  /** Items per page. */
  pageSize?: number;
}
