/**
 * Tests for the fused Jobs surface — `client.jobs.*`, `client.jobs.runs.*`,
 * and the active-record {@link Job} model.
 *
 * After the one-client refactor there is a single {@link JobsClient} (no
 * runtime/management split). It is reachable as `client.jobs` on the
 * top-level client (wired with a shared `transport`) or constructed directly
 * (`new JobsClient({ apiKey, ... })`, which builds its own jobs transport with
 * JSON:API headers). These tests drive both construction shapes by stubbing
 * `globalThis.fetch` and returning `application/vnd.api+json` responses.
 *
 * ADR-056 reshaped the per-environment surface into a flat sparse overlay:
 * `HttpConfig.headers` is a name→value object (with `setHeader`/`getHeader`),
 * a {@link JobEnvironment} is a flat sparse override (only the leaves it sets
 * travel on the wire, each header as a `headers.<name>` leaf), and a job's
 * base fields are set by direct assignment while per-environment overrides are
 * reached through `job.environment(env)`.
 *
 * Coverage target is 100% lines on src/jobs/{client,types,index}.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import createClient from "openapi-fetch";
import type { paths } from "../../../src/generated/jobs.d.ts";
import { JobsClient, RunsClient, RetryPoliciesClient } from "../../../src/jobs/client.js";
import {
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
} from "../../../src/jobs/types.js";
import * as JobsNamespace from "../../../src/jobs/index.js";
import { SmplNotFoundError, SmplError, SmplConnectionError } from "../../../src/errors.js";

const JOB_ID = "nightly-cache-warm";
const RUN_ID = "8f2b1c4a-0000-4a1b-9c3d-1e2f3a4b5c6d";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Standalone client — exercises the transport-building constructor branch. */
function makeClient(): JobsClient {
  return new JobsClient({
    apiKey: "sk_jobs_test",
    baseDomain: "test",
    scheme: "http",
  });
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function _jobResource(
  attrs: Record<string, unknown> = {},
  id: string = JOB_ID,
): { id: string; type: string; attributes: Record<string, unknown> } {
  return {
    id,
    type: "job",
    attributes: {
      name: "Nightly cache warm",
      description: null,
      type: "http",
      schedule: "0 2 * * *",
      configuration: {
        method: "POST",
        url: "https://api.example.com/cache/warm",
        // Wire headers are a name→value object (ADR-056).
        headers: { Authorization: "<redacted>" },
        body: '{"scope":"all"}',
        success_status: "2xx",
        timeout: 30,
        tls_verify: true,
        ca_cert: null,
      },
      concurrency_policy: "ALLOW",
      created_at: "2026-06-05T12:00:00+00:00",
      updated_at: "2026-06-05T12:00:00+00:00",
      deleted_at: null,
      version: 1,
      ...attrs,
    },
  };
}

function _runResource(
  attrs: Record<string, unknown> = {},
  id: string = RUN_ID,
): { id: string; type: string; attributes: Record<string, unknown> } {
  return {
    id,
    type: "run",
    attributes: {
      job: JOB_ID,
      job_version: 1,
      trigger: "MANUAL",
      rerun_of: null,
      scheduled_for: null,
      status: "PENDING",
      started_at: null,
      finished_at: null,
      pending_duration_ms: null,
      run_duration_ms: null,
      total_duration_ms: null,
      failure_reason: null,
      error: null,
      request: null,
      result: null,
      created_at: "2026-06-05T02:00:00+00:00",
      ...attrs,
    },
  };
}

const POLICY_ID = "retry-on-5xx";

function _retryPolicyResource(
  attrs: Record<string, unknown> = {},
  id: string = POLICY_ID,
): { id: string; type: string; attributes: Record<string, unknown> } {
  return {
    id,
    type: "retry_policy",
    attributes: {
      name: "Retry on server errors",
      max_retries: 5,
      backoff: "exponential",
      delay_seconds: 2,
      max_delay_seconds: 60,
      retry_on_timeout: true,
      retry_on_connection_error: true,
      retry_statuses: ["429", "5xx"],
      retry_statuses_except: ["501"],
      created_at: "2026-06-05T12:00:00+00:00",
      updated_at: "2026-06-05T12:00:00+00:00",
      deleted_at: null,
      version: 1,
      ...attrs,
    },
  };
}

function _newJob(client: JobsClient): Job {
  return client.newRecurringJob(JOB_ID, {
    name: "Nightly cache warm",
    schedule: "0 2 * * *",
    configuration: new HttpConfig({
      method: HttpMethod.POST,
      url: "https://api.example.com/cache/warm",
      headers: { Authorization: "Bearer s3cr3t" },
      body: '{"scope":"all"}',
    }),
  });
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("HttpConfig", () => {
  test("applies defaults for omitted fields", () => {
    const c = new HttpConfig({ url: "https://e.com" });
    expect(c.method).toBe(HttpMethod.POST);
    expect(c.headers).toEqual({});
    expect(c.body).toBeNull();
    expect(c.successStatus).toBe("2xx");
    expect(c.timeout).toBe(30);
    expect(c.tlsVerify).toBe(true);
    expect(c.caCert).toBeNull();
  });

  test("keeps explicit field values", () => {
    const c = new HttpConfig({
      url: "https://e.com",
      method: HttpMethod.GET,
      headers: { X: "y" },
      body: "hi",
      successStatus: "200",
      timeout: 5,
      tlsVerify: false,
      caCert: "PEM",
    });
    expect(c.method).toBe(HttpMethod.GET);
    expect(c.headers).toEqual({ X: "y" });
    expect(c.timeout).toBe(5);
    expect(c.tlsVerify).toBe(false);
    expect(c.caCert).toBe("PEM");
  });

  test("setHeader / getHeader read and write individual headers by name", () => {
    const c = new HttpConfig({ url: "https://e.com", headers: { Authorization: "Bearer one" } });
    expect(c.getHeader("Authorization")).toBe("Bearer one");
    // getHeader of a missing header returns undefined.
    expect(c.getHeader("X-Trace")).toBeUndefined();
    // setHeader adds a new header and replaces an existing one.
    c.setHeader("X-Trace", "abc");
    expect(c.getHeader("X-Trace")).toBe("abc");
    c.setHeader("Authorization", "Bearer two");
    expect(c.getHeader("Authorization")).toBe("Bearer two");
    expect(c.headers).toEqual({ Authorization: "Bearer two", "X-Trace": "abc" });
  });

  test("copies the supplied headers object rather than aliasing it", () => {
    const source = { Authorization: "Bearer one" };
    const c = new HttpConfig({ url: "https://e.com", headers: source });
    c.setHeader("Authorization", "Bearer two");
    // Mutating the config must not reach back into the caller's object.
    expect(source.Authorization).toBe("Bearer one");
  });
});

describe("Run / Usage models", () => {
  test("Run reads attributes, with null fallbacks", () => {
    const run = new Run({ job: JOB_ID, trigger: "SCHEDULE", status: "SUCCEEDED" }, RUN_ID);
    expect(run.id).toBe(RUN_ID);
    expect(run.job).toBe(JOB_ID);
    // trigger is a plain string, equal to the RunTrigger constant and the raw value
    expect(run.trigger).toBe(RunTrigger.SCHEDULE);
    expect(run.trigger).toBe("SCHEDULE");
    expect(run.jobVersion).toBeNull();
    expect(run.rerunOf).toBeNull();
    expect(run.scheduledFor).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
    expect(run.pendingDurationMs).toBeNull();
    expect(run.runDurationMs).toBeNull();
    expect(run.totalDurationMs).toBeNull();
    expect(run.failureReason).toBeNull();
    expect(run.error).toBeNull();
    expect(run.request).toBeNull();
    expect(run.result).toBeNull();
    expect(run.createdAt).toBeNull();
  });

  test("Run reads fully-populated attributes", () => {
    const run = new Run(
      {
        job: JOB_ID,
        job_version: 3,
        trigger: "RERUN",
        rerun_of: "prev-run",
        scheduled_for: "2026-06-05T02:00:00+00:00",
        status: "SUCCEEDED",
        started_at: "2026-06-05T02:00:01+00:00",
        finished_at: "2026-06-05T02:00:02+00:00",
        pending_duration_ms: 12,
        run_duration_ms: 34,
        total_duration_ms: 46,
        failure_reason: "TIMEOUT",
        error: "boom",
        request: { method: "POST" },
        result: { status: 200 },
        created_at: "2026-06-05T02:00:00+00:00",
      },
      RUN_ID,
    );
    expect(run.jobVersion).toBe(3);
    expect(run.trigger).toBe("RERUN");
    expect(run.rerunOf).toBe("prev-run");
    expect(run.scheduledFor).toBe("2026-06-05T02:00:00+00:00");
    expect(run.startedAt).toBe("2026-06-05T02:00:01+00:00");
    expect(run.finishedAt).toBe("2026-06-05T02:00:02+00:00");
    expect(run.pendingDurationMs).toBe(12);
    expect(run.runDurationMs).toBe(34);
    expect(run.totalDurationMs).toBe(46);
    expect(run.failureReason).toBe("TIMEOUT");
    expect(run.error).toBe("boom");
    expect(run.request).toEqual({ method: "POST" });
    expect(run.result).toEqual({ status: 200 });
  });

  test("Usage reads counters", () => {
    const u = new Usage({
      period: "2026-06",
      runs_used: 7,
      runs_included: 3000,
      active_jobs: 1,
      active_jobs_limit: 100,
    });
    expect(u.period).toBe("2026-06");
    expect(u.runsUsed).toBe(7);
    expect(u.runsIncluded).toBe(3000);
    expect(u.activeJobs).toBe(1);
    expect(u.activeJobsLimit).toBe(100);
  });

  test("Usage applies zero fallbacks for missing counters", () => {
    const u = new Usage({});
    expect(u.period).toBe("");
    expect(u.runsUsed).toBe(0);
    expect(u.runsIncluded).toBe(0);
    expect(u.activeJobs).toBe(0);
    expect(u.activeJobsLimit).toBe(0);
  });
});

describe("Job model", () => {
  test("constructor applies defaults for omitted fields", () => {
    const job = new Job(null, {
      id: JOB_ID,
      name: "x",
      schedule: "now",
      configuration: new HttpConfig({ url: "https://e.com" }),
    });
    expect(job.description).toBeNull();
    expect(job.enabled).toBe(false); // derived roll-up over an empty environments map
    expect(job.environments).toEqual({});
    expect(job.kind).toBeNull();
    expect(job.type).toBe("http");
    expect(job.timezone).toBeNull();
    expect(job.retryPolicy).toBeNull();
    expect(job.concurrencyPolicy).toBe("ALLOW");
    expect(job.createdAt).toBeNull();
    expect(job.updatedAt).toBeNull();
    expect(job.deletedAt).toBeNull();
    expect(job.version).toBeNull();
    expect(job._client).toBeNull();
  });

  test("kind predicates reflect the server-derived kind", () => {
    const cfg = new HttpConfig({ url: "https://e.com" });
    const rec = new Job(null, {
      id: "a",
      name: "a",
      schedule: "0 * * * *",
      configuration: cfg,
      kind: JobKind.RECURRING,
    });
    expect(rec.kind).toBe(JobKind.RECURRING);
    expect(rec.isRecurring()).toBe(true);
    expect(rec.isManual()).toBe(false);
    expect(rec.isOneOff()).toBe(false);
    const man = new Job(null, {
      id: "b",
      name: "b",
      schedule: null,
      configuration: cfg,
      kind: JobKind.MANUAL,
    });
    expect(man.isManual()).toBe(true);
    expect(man.isRecurring()).toBe(false);
    expect(man.isOneOff()).toBe(false);
    const off = new Job(null, {
      id: "c",
      name: "c",
      schedule: "now",
      configuration: cfg,
      kind: JobKind.ONE_OFF,
    });
    expect(off.isOneOff()).toBe(true);
    expect(off.isRecurring()).toBe(false);
    expect(off.isManual()).toBe(false);
    // a job with no kind leaves it null — every predicate is false
    const none = new Job(null, { id: "d", name: "d", schedule: null, configuration: cfg });
    expect(none.kind).toBeNull();
    expect(none.isRecurring() || none.isManual() || none.isOneOff()).toBe(false);
  });

  test("save without a client throws", async () => {
    const job = new Job(null, {
      id: JOB_ID,
      name: "x",
      schedule: "now",
      configuration: new HttpConfig({ url: "https://e.com" }),
    });
    await expect(job.save()).rejects.toThrow("cannot save");
  });

  test("delete without a client throws", async () => {
    const job = new Job(null, {
      id: JOB_ID,
      name: "x",
      schedule: "now",
      configuration: new HttpConfig({ url: "https://e.com" }),
    });
    await expect(job.delete()).rejects.toThrow("cannot delete");
  });

  test("enabled roll-up is false with no enabled env and true once any env is enabled", () => {
    const job = _newJob(makeClient());
    // No environments overridden yet — the roll-up reads false.
    expect(job.enabled).toBe(false);
    // An override present but disabled keeps the roll-up false.
    job.environment("staging").enabled = false;
    expect(job.enabled).toBe(false);
    // Enabling any environment flips the roll-up to true.
    job.environment("production").enabled = true;
    expect(job.enabled).toBe(true);
    // Disabling it again returns the roll-up to false.
    job.environment("production").enabled = false;
    expect(job.enabled).toBe(false);
  });

  test("retryPolicy accessor coerces instances, strings, and null on the base job", () => {
    const client = makeClient();
    const job = _newJob(client);
    const policy = client.retryPolicies.new(POLICY_ID, {
      name: "Retry on server errors",
      maxRetries: 5,
      backoff: Backoff.EXPONENTIAL,
      delaySeconds: 2,
    });
    // Assigning a RetryPolicy instance stores its id.
    job.retryPolicy = policy;
    expect(job.retryPolicy).toBe(POLICY_ID);
    // Assigning a string stores the string verbatim.
    job.retryPolicy = "Default";
    expect(job.retryPolicy).toBe("Default");
    // Assigning null clears the override.
    job.retryPolicy = null;
    expect(job.retryPolicy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// JobEnvironment (flat sparse override, ADR-056)
// ---------------------------------------------------------------------------

describe("JobEnvironment", () => {
  test("defaults: disabled, every leaf null, headers empty", () => {
    const e = new JobEnvironment();
    expect(e.enabled).toBe(false);
    expect(e.schedule).toBeNull();
    expect(e.timezone).toBeNull();
    expect(e.retryPolicy).toBeNull();
    expect(e.url).toBeNull();
    expect(e.method).toBeNull();
    expect(e.timeout).toBeNull();
    expect(e.body).toBeNull();
    expect(e.successStatus).toBeNull();
    expect(e.tlsVerify).toBeNull();
    expect(e.caCert).toBeNull();
    expect(e.headers).toEqual({});
    expect(e.nextRunAt).toBeNull();
    expect(e.getHeader("anything")).toBeUndefined();
  });

  test("keeps explicit leaf values", () => {
    const e = new JobEnvironment({
      enabled: true,
      schedule: "0 3 * * *",
      timezone: "Europe/London",
      retryPolicy: "Default",
      url: "https://prod.example.com/warm",
      method: HttpMethod.GET,
      timeout: 5,
      body: "payload",
      successStatus: "204",
      tlsVerify: false,
      caCert: "PEM",
      headers: { Authorization: "Bearer prod" },
      nextRunAt: "2026-06-07T03:00:00+00:00",
    });
    expect(e.enabled).toBe(true);
    expect(e.schedule).toBe("0 3 * * *");
    expect(e.timezone).toBe("Europe/London");
    expect(e.retryPolicy).toBe("Default");
    expect(e.url).toBe("https://prod.example.com/warm");
    expect(e.method).toBe(HttpMethod.GET);
    expect(e.timeout).toBe(5);
    expect(e.body).toBe("payload");
    expect(e.successStatus).toBe("204");
    expect(e.tlsVerify).toBe(false);
    expect(e.caCert).toBe("PEM");
    expect(e.getHeader("Authorization")).toBe("Bearer prod");
    expect(e.nextRunAt).toBe("2026-06-07T03:00:00+00:00");
  });

  test("retryPolicy accessor coerces a RetryPolicy instance to its id", () => {
    const policy = new RetryPolicy(null, {
      id: POLICY_ID,
      name: "Retry on server errors",
      maxRetries: 5,
      backoff: Backoff.EXPONENTIAL,
      delaySeconds: 2,
    });
    // Coercion runs in the constructor path too.
    const e = new JobEnvironment({ retryPolicy: policy });
    expect(e.retryPolicy).toBe(POLICY_ID);
    // And via the setter: instance -> id, string -> string, null -> null.
    e.retryPolicy = "Default";
    expect(e.retryPolicy).toBe("Default");
    e.retryPolicy = policy;
    expect(e.retryPolicy).toBe(POLICY_ID);
    e.retryPolicy = null;
    expect(e.retryPolicy).toBeNull();
  });

  test("setHeader / getHeader read and write individual header overrides", () => {
    const e = new JobEnvironment();
    expect(e.getHeader("Authorization")).toBeUndefined();
    e.setHeader("Authorization", "Bearer prod");
    expect(e.getHeader("Authorization")).toBe("Bearer prod");
    e.setHeader("Authorization", "Bearer prod-2");
    expect(e.getHeader("Authorization")).toBe("Bearer prod-2");
    expect(e.headers).toEqual({ Authorization: "Bearer prod-2" });
  });
});

// ---------------------------------------------------------------------------
// Jobs CRUD
// ---------------------------------------------------------------------------

describe("jobs CRUD", () => {
  test("new + save creates the job (POST) and refreshes fields", async () => {
    const client = makeClient();
    const job = _newJob(client);
    expect(job.createdAt).toBeNull();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    expect(job.version).toBe(1);
    expect(job.createdAt).not.toBeNull();
    expect(job.configuration.url).toBe("https://api.example.com/cache/warm");
    expect((mockFetch.mock.calls[0][0] as Request).method).toBe("POST");
  });

  test("save on an existing job updates it (PUT)", async () => {
    const client = makeClient();
    const job = _newJob(client);
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    job.name = "renamed";
    job.environment("production").enabled = true;
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          name: "renamed",
          version: 2,
          environments: { production: { enabled: true } },
        }),
      }),
    );
    await job.save();
    expect(job.version).toBe(2);
    // `enabled` is the derived roll-up: true because the server echoed an
    // enabled `production` environment.
    expect(job.enabled).toBe(true);
    expect(job.environments.production.enabled).toBe(true);
    expect((mockFetch.mock.calls[1][0] as Request).method).toBe("PUT");
  });

  test("list with and without filters", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_jobResource()] }));
    const all = await client.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toBeInstanceOf(Job);
    expect(all[0]._client).toBe(client);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const filtered = await client.list({
      kind: JobKind.MANUAL,
      scheduled: true,
      name: "health",
      pageNumber: 1,
      pageSize: 50,
    });
    expect(filtered).toEqual([]);
    const url = new URL((mockFetch.mock.calls[1][0] as Request).url);
    expect(url.searchParams.get("filter[kind]")).toBe("manual"); // JobKind serialized to its value
    expect(url.searchParams.get("filter[scheduled]")).toBe("true");
    expect(url.searchParams.get("filter[name]")).toBe("health");
    expect(url.searchParams.get("page[number]")).toBe("1");
    expect(url.searchParams.get("page[size]")).toBe("50");
    // The dropped recurring filter is never emitted.
    expect(url.searchParams.has("filter[recurring]")).toBe(false);
  });

  test("list tolerates a missing data array", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await client.list()).toEqual([]);
  });

  test("newManualJob has no schedule and sends schedule:null on create", async () => {
    // A manual job is created with no schedule: newManualJob leaves schedule
    // null, the create body carries schedule: null, and the server echoes back
    // kind="manual" with no schedule.
    const client = makeClient();
    const job = client.newManualJob("manual-job", {
      name: "Manual",
      configuration: new HttpConfig({ url: "https://e.com" }),
    });
    expect(job.schedule).toBeNull(); // no schedule supplied
    job.environment("production").enabled = true;
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _jobResource({ kind: "manual", schedule: null }, "manual-job") }, 201),
    );
    await job.save();
    expect(job.isManual()).toBe(true);
    expect(job.kind).toBe(JobKind.MANUAL);
    expect(job.schedule).toBeNull();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect(sent.data.attributes.schedule).toBeNull(); // null sent on the wire
  });

  test("list surfaces an API error", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "404" }] }, 404));
    await expect(client.list()).rejects.toThrow(SmplNotFoundError);
  });

  test("get returns a bound Job and reads configuration back from the wire", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await client.get(JOB_ID);
    expect(job.id).toBe(JOB_ID);
    expect(job._client).toBe(client);
    expect(job.configuration).toBeInstanceOf(HttpConfig);
    expect(job.configuration.method).toBe("POST");
    // Wire object headers round-trip onto the base configuration.
    expect(job.configuration.headers).toEqual({ Authorization: "<redacted>" });
    expect(job.configuration.getHeader("Authorization")).toBe("<redacted>");
    expect(job.configuration.timeout).toBe(30);
    expect(job.configuration.tlsVerify).toBe(true);
  });

  test("get applies wire fallbacks for a sparse resource", async () => {
    const client = makeClient();
    // Attributes object present but with no fields → every fallback fires,
    // including the configuration defaults (empty url/method/headers/etc.).
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: JOB_ID, type: "job", attributes: {} } }),
    );
    const job = await client.get(JOB_ID);
    expect(job.name).toBe("");
    expect(job.description).toBeNull();
    expect(job.enabled).toBe(false); // derived: no environments → not enabled anywhere
    expect(job.environments).toEqual({});
    expect(job.kind).toBeNull();
    expect(job.type).toBe("http");
    expect(job.schedule).toBeNull();
    expect(job.timezone).toBeNull();
    expect(job.retryPolicy).toBeNull();
    expect(job.concurrencyPolicy).toBe("ALLOW");
    expect(job.createdAt).toBeNull();
    expect(job.version).toBeNull();
    expect(job.configuration.url).toBe("");
    expect(job.configuration.method).toBe(HttpMethod.POST);
    expect(job.configuration.headers).toEqual({});
    expect(job.configuration.body).toBeNull();
    expect(job.configuration.successStatus).toBe("2xx");
    expect(job.configuration.timeout).toBe(30);
    expect(job.configuration.tlsVerify).toBe(true);
    expect(job.configuration.caCert).toBeNull();
  });

  test("get handles a configuration with object headers and an explicit body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          configuration: {
            url: "https://e.com",
            method: "GET",
            headers: { "X-Token": "abc", "X-Count": 7 },
            body: "payload",
            success_status: "200",
            timeout: 5,
            tls_verify: false,
            ca_cert: "PEM",
          },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    // Non-string header values are coerced to strings by _headersFromWire.
    expect(job.configuration.headers).toEqual({ "X-Token": "abc", "X-Count": "7" });
    expect(job.configuration.body).toBe("payload");
    expect(job.configuration.successStatus).toBe("200");
    expect(job.configuration.timeout).toBe(5);
    expect(job.configuration.tlsVerify).toBe(false);
    expect(job.configuration.caCert).toBe("PEM");
  });

  test("get tolerates a non-object headers value on the wire", async () => {
    const client = makeClient();
    // A malformed/absent headers field (here a string) exercises the
    // non-object branch of _headersFromWire, which yields an empty object.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          configuration: { url: "https://e.com", method: "POST", headers: "not-an-object" },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    expect(job.configuration.headers).toEqual({});
  });

  test("get throws on an empty body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(client.get(JOB_ID)).rejects.toThrow(SmplError);
  });

  test("delete (204) succeeds; delete via Job.delete round-trips", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await client.get(JOB_ID);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await job.delete();
    const url = (mockFetch.mock.calls[1][0] as Request).url;
    expect(url).toContain(`/api/v1/jobs/${JOB_ID}`);
    expect((mockFetch.mock.calls[1][0] as Request).method).toBe("DELETE");
  });

  test("delete surfaces a non-204 error status", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "nope" }] }, 404));
    await expect(client.delete(JOB_ID)).rejects.toThrow(SmplNotFoundError);
  });

  test("delete surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.delete(JOB_ID)).rejects.toThrow(SmplConnectionError);
  });

  test("run triggers a MANUAL run", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource() }));
    const run = await client.run(JOB_ID);
    expect(run).toBeInstanceOf(Run);
    expect(run.trigger).toBe("MANUAL");
    const url = (mockFetch.mock.calls[0][0] as Request).url;
    expect(url).toContain(`/api/v1/jobs/${JOB_ID}/actions/run`);
  });

  test("run throws on an empty body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(client.run(JOB_ID)).rejects.toThrow(SmplError);
  });

  test("run surfaces an API error", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "404" }] }, 404));
    await expect(client.run("missing")).rejects.toThrow(SmplNotFoundError);
  });

  test("usage returns the counters", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "current",
          type: "usage",
          attributes: {
            period: "2026-06",
            runs_used: 7,
            runs_included: 3000,
            active_jobs: 1,
            active_jobs_limit: 100,
          },
        },
      }),
    );
    const usage = await client.usage();
    expect(usage).toBeInstanceOf(Usage);
    expect(usage.runsUsed).toBe(7);
  });

  test("usage throws on an empty body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(client.usage()).rejects.toThrow(SmplError);
  });

  test("usage surfaces an API error", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "402" }] }, 402));
    await expect(client.usage()).rejects.toThrow(SmplError);
  });

  test("usage surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.usage()).rejects.toThrow(SmplConnectionError);
  });

  test("_createJob serializes the full configuration to the wire", async () => {
    const client = makeClient();
    const job = client.newRecurringJob(JOB_ID, {
      name: "n",
      schedule: "0 2 * * *",
      description: "desc",
      concurrencyPolicy: "ALLOW",
      configuration: new HttpConfig({
        url: "https://e.com",
        method: HttpMethod.PUT,
        headers: { X: "y" },
        body: "b",
        successStatus: "204",
        timeout: 10,
        tlsVerify: false,
        caCert: "PEM",
      }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const req = mockFetch.mock.calls[0][0] as Request;
    const sent = JSON.parse(await req.text());
    const cfg = sent.data.attributes.configuration;
    expect(sent.data.id).toBe(JOB_ID);
    expect(sent.data.attributes.description).toBe("desc");
    expect(cfg.method).toBe("PUT");
    // Configuration headers serialize as a name→value object on the wire.
    expect(cfg.headers).toEqual({ X: "y" });
    expect(cfg.body).toBe("b");
    expect(cfg.success_status).toBe("204");
    expect(cfg.timeout).toBe(10);
    expect(cfg.tls_verify).toBe(false);
    expect(cfg.ca_cert).toBe("PEM");
  });

  test("_createJob throws on an empty body", async () => {
    const client = makeClient();
    const job = _newJob(client);
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 201));
    await expect(job.save()).rejects.toThrow(SmplError);
  });

  test("_updateJob throws on an empty body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await client.get(JOB_ID);
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(job.save()).rejects.toThrow(SmplError);
  });

  test("_createJob surfaces an API error (409 on duplicate id)", async () => {
    const client = makeClient();
    const job = _newJob(client);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ errors: [{ status: "409", detail: "exists" }] }, 409),
    );
    await expect(job.save()).rejects.toThrow(SmplError);
  });

  test("_updateJob surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await client.get(JOB_ID);
    mockFetch.mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(job.save()).rejects.toThrow(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// Runs sub-client
// ---------------------------------------------------------------------------

describe("jobs.runs", () => {
  test("runs namespace is wired", () => {
    const client = makeClient();
    expect(client.runs).toBeInstanceOf(RunsClient);
  });

  test("list with and without params", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    const all = await client.runs.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toBeInstanceOf(Run);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.runs.list({ job: JOB_ID, pageSize: 2, after: "cursor" });
    const url = (mockFetch.mock.calls[1][0] as Request).url;
    expect(url).toContain("filter[job]=" + JOB_ID);
    expect(url).toContain("page[size]=2");
    expect(url).toContain("page[after]=cursor");
  });

  test("list tolerates a missing data array", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await client.runs.list()).toEqual([]);
  });

  test("get / cancel / rerun a run", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource() }));
    const got = await client.runs.get(RUN_ID);
    expect(got.id).toBe(RUN_ID);
    expect((mockFetch.mock.calls[0][0] as Request).method).toBe("GET");

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource({ status: "CANCELED" }) }));
    const canceled = await client.runs.cancel(RUN_ID);
    expect(canceled.status).toBe("CANCELED");
    expect((mockFetch.mock.calls[1][0] as Request).method).toBe("POST");
    expect((mockFetch.mock.calls[1][0] as Request).url).toContain(
      `/api/v1/runs/${RUN_ID}/actions/cancel`,
    );

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _runResource(
          { trigger: "RERUN", rerun_of: RUN_ID },
          "00000000-0000-4000-8000-000000000001",
        ),
      }),
    );
    const rerun = await client.runs.rerun(RUN_ID);
    expect(rerun.trigger).toBe("RERUN");
    expect(rerun.rerunOf).toBe(RUN_ID);
    expect((mockFetch.mock.calls[2][0] as Request).url).toContain(
      `/api/v1/runs/${RUN_ID}/actions/rerun`,
    );
  });

  test("a run action throws on an empty body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(client.runs.get(RUN_ID)).rejects.toThrow(SmplError);
  });

  test("a run action surfaces an API error", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "404" }] }, 404));
    await expect(client.runs.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  test("runs.list surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.runs.list()).rejects.toThrow(SmplConnectionError);
  });

  test("a run action surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.runs.cancel(RUN_ID)).rejects.toThrow(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// Error wrapping
// ---------------------------------------------------------------------------

describe("error wrapping", () => {
  test("a 404 surfaces as SmplNotFoundError", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ errors: [{ status: "404", detail: "missing" }] }, 404),
    );
    await expect(client.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  test("a network TypeError becomes SmplConnectionError", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.get(JOB_ID)).rejects.toThrow(SmplConnectionError);
  });

  test("a non-Error rejection becomes SmplConnectionError", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce("boom");
    await expect(client.list()).rejects.toThrow(SmplConnectionError);
  });

  test("a generic Error rejection becomes SmplConnectionError with its message", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("kaboom"));
    await expect(client.list()).rejects.toThrow(/Request failed: kaboom/);
  });

  test("an already-wrapped SmplError propagates unchanged", async () => {
    const client = makeClient();
    // checkError throws SmplNotFoundError synchronously inside the try; the
    // catch's wrapFetchError must re-throw the SmplError as-is, not re-wrap it.
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "404" }] }, 404));
    await expect(client.get("x")).rejects.toBeInstanceOf(SmplNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("JobsClient construction", () => {
  test("standalone construction builds its own transport and sends JSON:API headers", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.list();
    const req = mockFetch.mock.calls[0][0] as Request;
    expect(req.url).toContain("http://jobs.test");
    expect(req.headers.get("Accept")).toBe("application/vnd.api+json");
    expect(req.headers.get("Content-Type")).toBe("application/vnd.api+json");
    expect(req.headers.get("Authorization")).toBe("Bearer sk_jobs_test");
  });

  test("standalone construction honours an explicit baseUrl and extra headers", async () => {
    const client = new JobsClient({
      apiKey: "sk_jobs_test",
      baseUrl: "http://jobs.internal:9000/",
      extraHeaders: { "X-Trace": "abc" },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.list();
    const req = mockFetch.mock.calls[0][0] as Request;
    // Trailing slash stripped from baseUrl before the path is appended.
    expect(req.url).toBe("http://jobs.internal:9000/api/v1/jobs");
    expect(req.headers.get("X-Trace")).toBe("abc");
  });

  test("wired construction reuses a supplied transport", async () => {
    const transport = createClient<paths>({
      baseUrl: "http://jobs.wired",
      headers: { Authorization: "Bearer shared", Accept: "application/vnd.api+json" },
    });
    const client = new JobsClient({ transport });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.list();
    const req = mockFetch.mock.calls[0][0] as Request;
    expect(req.url).toContain("http://jobs.wired");
    expect(req.headers.get("Authorization")).toBe("Bearer shared");
  });

  test("close() is a no-op for both owned and wired transports", () => {
    const owned = makeClient();
    expect(() => owned.close()).not.toThrow();

    const transport = createClient<paths>({ baseUrl: "http://jobs.wired" });
    const wired = new JobsClient({ transport });
    expect(() => wired.close()).not.toThrow();
  });

  test("the jobs namespace barrel re-exports the public surface", () => {
    expect(JobsNamespace.JobsClient).toBe(JobsClient);
    expect(JobsNamespace.RunsClient).toBe(RunsClient);
    expect(JobsNamespace.RetryPoliciesClient).toBe(RetryPoliciesClient);
    expect(JobsNamespace.HttpConfig).toBe(HttpConfig);
    expect(JobsNamespace.JobEnvironment).toBe(JobEnvironment);
    expect(JobsNamespace.Job).toBe(Job);
    expect(JobsNamespace.Run).toBe(Run);
    expect(JobsNamespace.RunRetry).toBe(RunRetry);
    expect(JobsNamespace.Usage).toBe(Usage);
    expect(JobsNamespace.RetryPolicy).toBe(RetryPolicy);
    expect(JobsNamespace.HttpMethod).toBe(HttpMethod);
    expect(JobsNamespace.JobKind).toBe(JobKind);
    expect(JobsNamespace.RunTrigger).toBe(RunTrigger);
    expect(JobsNamespace.Backoff).toBe(Backoff);
  });
});

describe("jobs environment scoping", () => {
  function envClient(environment?: string): JobsClient {
    return new JobsClient({
      apiKey: "sk_jobs_test",
      baseDomain: "test",
      scheme: "http",
      environment,
    });
  }

  test("environment() lazily creates an override and returns the existing one thereafter", () => {
    const job = _newJob(makeClient());
    expect(job.environments).toEqual({});
    const prod = job.environment("production");
    expect(prod).toBeInstanceOf(JobEnvironment);
    // The freshly-created override is stored in the environments map.
    expect(job.environments.production).toBe(prod);
    // A second access returns the SAME instance (the create-vs-existing branch).
    expect(job.environment("production")).toBe(prod);
    // Mutations through the returned override are visible on the map.
    prod.enabled = true;
    expect(job.environments.production.enabled).toBe(true);
  });

  test("per-env leaf overrides serialize to a flat snake_case overlay on save", async () => {
    const client = makeClient();
    const job = client.newRecurringJob(JOB_ID, {
      name: "x",
      schedule: "0 2 * * *",
      timezone: "America/New_York", // base timezone (direct assignment via field)
      configuration: new HttpConfig({ url: "https://api.example.com" }),
    });
    // Production overrides several leaves plus a header.
    const prod = job.environment("production");
    prod.enabled = true;
    prod.schedule = "0 5 * * *";
    prod.timezone = "Europe/London";
    prod.url = "https://prod.example.com/warm";
    prod.method = HttpMethod.GET;
    prod.timeout = 45;
    prod.body = "prod-body";
    prod.successStatus = "204";
    prod.tlsVerify = false;
    prod.caCert = "PROD-PEM";
    prod.retryPolicy = "Default";
    prod.setHeader("Authorization", "Bearer prod");
    // Staging only flips enabled off — every other leaf stays null and must be
    // omitted from its overlay.
    job.environment("staging").enabled = false;
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    // The read-only roll-up `enabled` is never sent at the top level.
    expect(sent.data.attributes.enabled).toBeUndefined();
    expect(sent.data.attributes.timezone).toBe("America/New_York");
    // production carries enabled plus only the overridden snake_case leaves and
    // its header as a `headers.<name>` entry.
    expect(sent.data.attributes.environments.production).toEqual({
      enabled: true,
      schedule: "0 5 * * *",
      timezone: "Europe/London",
      retry_policy: "Default",
      url: "https://prod.example.com/warm",
      method: "GET",
      timeout: 45,
      body: "prod-body",
      success_status: "204",
      tls_verify: false,
      ca_cert: "PROD-PEM",
      "headers.Authorization": "Bearer prod",
    });
    // nextRunAt is read-only and never serialized.
    expect("next_run_at" in sent.data.attributes.environments.production).toBe(false);
    // staging overrides nothing else, so only `enabled` rides along.
    expect(sent.data.attributes.environments.staging).toEqual({ enabled: false });
  });

  test("parse a flat overlay back into the model, including a dotted header name", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          kind: "recurring",
          timezone: "America/New_York", // base timezone
          environments: {
            production: {
              enabled: true,
              schedule: "0 3 * * *",
              timezone: "Europe/London",
              url: "https://prod.example.com/warm",
              method: "GET",
              timeout: 45,
              body: "prod-body",
              success_status: "204",
              tls_verify: false,
              ca_cert: "PROD-PEM",
              retry_policy: "Default",
              // Header whose name itself contains a dot: the wrapper splits on
              // the FIRST dot only, so the rest of the key is the header name.
              "headers.X-Foo.Bar": "v",
              "headers.Authorization": "Bearer prod",
              next_run_at: "2026-06-07T03:00:00+00:00", // read-only
              // An unknown leaf key must be ignored (forward-compat).
              future_leaf: "ignored",
            },
          },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    expect(job.kind).toBe(JobKind.RECURRING);
    expect(job.enabled).toBe(true); // derived roll-up: production enabled
    expect(job.timezone).toBe("America/New_York"); // base timezone decodes from the wire
    const prod = job.environment("production");
    expect(prod.enabled).toBe(true);
    expect(prod.schedule).toBe("0 3 * * *");
    expect(prod.timezone).toBe("Europe/London");
    expect(prod.url).toBe("https://prod.example.com/warm");
    expect(prod.method).toBe(HttpMethod.GET);
    expect(prod.timeout).toBe(45);
    expect(prod.body).toBe("prod-body");
    expect(prod.successStatus).toBe("204");
    expect(prod.tlsVerify).toBe(false);
    expect(prod.caCert).toBe("PROD-PEM");
    expect(prod.retryPolicy).toBe("Default");
    expect(prod.nextRunAt).toBe("2026-06-07T03:00:00+00:00");
    // The dotted header name is preserved (split on first dot only).
    expect(prod.getHeader("X-Foo.Bar")).toBe("v");
    expect(prod.getHeader("Authorization")).toBe("Bearer prod");
    // The unknown leaf never lands on a model field.
    expect(prod.getHeader("future_leaf")).toBeUndefined();
  });

  test("a pure-enabled override reads every other leaf as null and missing headers as undefined", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          environments: {
            // Overrides ONLY enabled — the SDK must NOT merge in base values.
            production: { enabled: true },
          },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    const prod = job.environment("production");
    expect(prod.enabled).toBe(true);
    expect(prod.schedule).toBeNull();
    expect(prod.timezone).toBeNull();
    expect(prod.retryPolicy).toBeNull();
    expect(prod.url).toBeNull();
    expect(prod.method).toBeNull();
    expect(prod.timeout).toBeNull();
    expect(prod.body).toBeNull();
    expect(prod.successStatus).toBeNull();
    expect(prod.tlsVerify).toBeNull();
    expect(prod.caCert).toBeNull();
    expect(prod.nextRunAt).toBeNull();
    expect(prod.getHeader("missing")).toBeUndefined();
  });

  test("parse tolerates a header key that is just `headers.` (empty name) and a null env value", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          environments: {
            // `headers.` with no name after the dot must be skipped, not stored
            // under an empty key.
            production: { enabled: true, "headers.": "orphan" },
            // A null environment value coerces to an empty (disabled) override.
            staging: null,
          },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    expect(job.environments.production.headers).toEqual({});
    expect(job.environments.staging.enabled).toBe(false);
    expect(job.environments.staging.headers).toEqual({});
  });

  test("create omits the environments attribute entirely when no env is overridden", async () => {
    const client = makeClient();
    const job = client.newRecurringJob(JOB_ID, {
      name: "x",
      schedule: "0 2 * * *",
      configuration: new HttpConfig({ url: "https://api.example.com" }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect("environments" in sent.data.attributes).toBe(false);
  });

  test("base fields are set by direct assignment and serialized", async () => {
    const client = makeClient();
    const job = _newJob(client);
    // Direct assignment of base fields (no setters anymore).
    job.schedule = "30 2 * * *";
    job.timezone = "America/New_York";
    job.configuration = new HttpConfig({ url: "https://new.example.com" });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect(sent.data.attributes.schedule).toBe("30 2 * * *");
    expect(sent.data.attributes.timezone).toBe("America/New_York");
    expect(sent.data.attributes.configuration.url).toBe("https://new.example.com");
  });

  test("base timezone is omitted from the wire when null", async () => {
    const client = makeClient();
    const job = _newJob(client); // no timezone
    expect(job.timezone).toBeNull();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect("timezone" in sent.data.attributes).toBe(false);
  });

  test("schedule() serializes the Date to ISO-8601 and sends the birth environment", async () => {
    const client = makeClient();
    const when = new Date("2030-01-01T12:30:00.000Z");
    const job = client.schedule("one-off", {
      name: "One",
      schedule: when,
      configuration: new HttpConfig({ url: "https://api.example.com" }),
      environment: "staging",
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource({}, "one-off") }, 201));
    await job.save();
    const req = mockFetch.mock.calls[0][0] as Request;
    expect(req.headers.get("X-Smplkit-Environment")).toBe("staging"); // birth environment
    const sent = JSON.parse(await req.text());
    expect(sent.data.attributes.schedule).toBe(when.toISOString()); // Date -> ISO-8601
  });

  test("client-level environment is the default birth header and update header", async () => {
    const client = envClient("production");
    const job = client.newRecurringJob(JOB_ID, {
      name: "x",
      schedule: "0 2 * * *",
      configuration: new HttpConfig({ url: "https://api.example.com" }),
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save(); // create
    expect((mockFetch.mock.calls[0][0] as Request).headers.get("X-Smplkit-Environment")).toBe(
      "production",
    );
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource({}, JOB_ID) }));
    job.name = "renamed";
    await job.save(); // update
    expect((mockFetch.mock.calls[1][0] as Request).headers.get("X-Smplkit-Environment")).toBe(
      "production",
    );
  });

  test("create with no environment sends no header", async () => {
    const job = _newJob(makeClient());
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    expect((mockFetch.mock.calls[0][0] as Request).headers.get("X-Smplkit-Environment")).toBeNull();
  });

  test("run-now sends the environment header and the returned run is bound", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _runResource({ environment: "production" }) }),
    );
    const run = await client.run(JOB_ID, { environment: "production" });
    expect((mockFetch.mock.calls[0][0] as Request).headers.get("X-Smplkit-Environment")).toBe(
      "production",
    );
    expect(run.environment).toBe("production");
    // returned run is active-record: rerun() works
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource({ trigger: "RERUN" }) }));
    expect((await run.rerun()).trigger).toBe("RERUN");
  });

  test("job.trigger sends the run-now header", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await client.get(JOB_ID);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _runResource({ environment: "production" }) }),
    );
    const run = await job.trigger("production");
    expect(run.environment).toBe("production");
    expect((mockFetch.mock.calls[1][0] as Request).headers.get("X-Smplkit-Environment")).toBe(
      "production",
    );
  });

  test("job.listRuns filters by environment", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await client.get(JOB_ID);
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    await job.listRuns({ environment: "production" });
    const url = new URL((mockFetch.mock.calls[1][0] as Request).url);
    expect(url.searchParams.get("filter[environment]")).toBe("production");
    expect(url.searchParams.get("filter[job]")).toBe(JOB_ID);
  });

  test("runs.list resolves filter[environment]: explicit, client default, none", async () => {
    // explicit list wins
    const c1 = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    await c1.runs.list({ environments: ["production", "staging"] });
    expect(
      new URL((mockFetch.mock.calls[0][0] as Request).url).searchParams.get("filter[environment]"),
    ).toBe("production,staging");
    // client default applies
    const c2 = envClient("production");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    await c2.runs.list();
    expect(
      new URL((mockFetch.mock.calls[1][0] as Request).url).searchParams.get("filter[environment]"),
    ).toBe("production");
    // neither -> param omitted
    const c3 = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    await c3.runs.list();
    expect(
      new URL((mockFetch.mock.calls[2][0] as Request).url).searchParams.get("filter[environment]"),
    ).toBeNull();
  });

  test("runs.get / cancel / rerun return active-record runs", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _runResource({ environment: "staging" }) }),
    );
    const run = await client.runs.get(RUN_ID);
    expect(run.environment).toBe("staging");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource({ status: "CANCELED" }) }));
    expect((await run.cancel()).status).toBe("CANCELED");
  });

  test("active-record methods throw without a client", async () => {
    const job = new Job(null, {
      id: JOB_ID,
      name: "x",
      schedule: "now",
      configuration: new HttpConfig({ url: "https://e.com" }),
    });
    await expect(job.trigger()).rejects.toThrow(/cannot trigger/);
    await expect(job.listRuns()).rejects.toThrow(/cannot list runs/);
    const run = new Run(_runResource().attributes, RUN_ID); // no runs backref
    await expect(run.rerun()).rejects.toThrow(/cannot rerun/);
    await expect(run.cancel()).rejects.toThrow(/cannot cancel/);
  });
});

// ---------------------------------------------------------------------------
// Retry value types
// ---------------------------------------------------------------------------

describe("retry value types", () => {
  test("RunRetry holds the chain origin and attempt number", () => {
    const rr = new RunRetry("orig-run", 2);
    expect(rr.of).toBe("orig-run");
    expect(rr.attempt).toBe(2);
  });

  test("enum values match the wire", () => {
    expect(Backoff.EXPONENTIAL).toBe("exponential");
    expect(Backoff.FIXED).toBe("fixed");
    expect(RunTrigger.RETRY).toBe("RETRY");
  });
});

// ---------------------------------------------------------------------------
// Run.retry parsing
// ---------------------------------------------------------------------------

describe("Run.retry", () => {
  test("parses the retry chain only on a RETRY run", () => {
    const retry = new Run(
      { job: JOB_ID, trigger: "RETRY", status: "PENDING", retry: { of: RUN_ID, attempt: 3 } },
      "retry-run",
    );
    expect(retry.trigger).toBe(RunTrigger.RETRY);
    expect(retry.retry).toBeInstanceOf(RunRetry);
    expect(retry.retry?.of).toBe(RUN_ID);
    expect(retry.retry?.attempt).toBe(3);

    // a non-RETRY run carries no retry attribute → null
    const scheduled = new Run({ job: JOB_ID, trigger: "SCHEDULE", status: "SUCCEEDED" }, RUN_ID);
    expect(scheduled.retry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Job ⇄ retry policy
// ---------------------------------------------------------------------------

describe("job retry policy", () => {
  test("retryPolicy coercion holds on both the job and a per-env override", () => {
    const client = makeClient();
    const job = _newJob(client);
    const policy = client.retryPolicies.new(POLICY_ID, {
      name: "Retry on server errors",
      maxRetries: 5,
      backoff: Backoff.EXPONENTIAL,
      delaySeconds: 2,
    });
    // base: a RetryPolicy instance contributes its id
    job.retryPolicy = policy;
    expect(job.retryPolicy).toBe(POLICY_ID);
    // base: a bare id string is used as-is
    job.retryPolicy = "Default";
    expect(job.retryPolicy).toBe("Default");
    // base: null clears it
    job.retryPolicy = null;
    expect(job.retryPolicy).toBeNull();
    // per-env override (instance) creates/updates the entry
    const prod = job.environment("production");
    prod.enabled = true;
    prod.retryPolicy = policy;
    expect(job.environments.production.retryPolicy).toBe(POLICY_ID);
    expect(job.environments.production.enabled).toBe(true);
    // per-env override (bare id) on a brand-new environment entry
    job.environment("edge").retryPolicy = "Default";
    expect(job.environments.edge.retryPolicy).toBe("Default");
    expect(job.environments.edge.enabled).toBe(false);
    // per-env override cleared with null
    job.environment("edge").retryPolicy = null;
    expect(job.environments.edge.retryPolicy).toBeNull();
  });

  test("create serializes base + per-env retry_policy, omitting it when null", async () => {
    const client = makeClient();
    const job = client.newRecurringJob(JOB_ID, {
      name: "x",
      schedule: "0 2 * * *",
      timezone: "America/New_York",
      retryPolicy: POLICY_ID,
      configuration: new HttpConfig({ url: "https://api.example.com" }),
    });
    const prod = job.environment("production");
    prod.enabled = true;
    prod.retryPolicy = "Default";
    job.environment("staging").enabled = true; // no per-env retry policy
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect(sent.data.attributes.retry_policy).toBe(POLICY_ID); // base policy sent
    expect(sent.data.attributes.environments.production.retry_policy).toBe("Default");
    // staging has no override → the key is omitted entirely
    expect("retry_policy" in sent.data.attributes.environments.staging).toBe(false);
  });

  test("create omits retry_policy when the base policy is null", async () => {
    const client = makeClient();
    const job = _newJob(client); // no retryPolicy
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect("retry_policy" in sent.data.attributes).toBe(false);
  });

  test("get parses base + per-env retry_policy back from the wire", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          retry_policy: POLICY_ID,
          environments: {
            production: { enabled: true, retry_policy: "Default" },
            staging: { enabled: true }, // no per-env policy
          },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    expect(job.retryPolicy).toBe(POLICY_ID);
    expect(job.environments.production.retryPolicy).toBe("Default");
    expect(job.environments.staging.retryPolicy).toBeNull();
  });

  test("retry_policy survives a save round-trip onto the in-memory job", async () => {
    const client = makeClient();
    const job = _newJob(client);
    job.retryPolicy = POLICY_ID;
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _jobResource({ retry_policy: POLICY_ID, version: 1 }) }, 201),
    );
    await job.save();
    expect(job.retryPolicy).toBe(POLICY_ID); // _apply copied it back
  });
});

// ---------------------------------------------------------------------------
// Run-list filters: triggers + lastRunOnly
// ---------------------------------------------------------------------------

describe("run-list filters", () => {
  test("runs.list joins triggers and sends last_run_only only when true", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    await client.runs.list({
      triggers: [RunTrigger.SCHEDULE, RunTrigger.RETRY],
      lastRunOnly: true,
    });
    const url = new URL((mockFetch.mock.calls[0][0] as Request).url);
    expect(url.searchParams.get("filter[trigger]")).toBe("SCHEDULE,RETRY");
    expect(url.searchParams.get("last_run_only")).toBe("true");
  });

  test("runs.list omits both params by default (no empty triggers, no last_run_only=false)", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.runs.list({ triggers: [], lastRunOnly: false });
    const url = new URL((mockFetch.mock.calls[0][0] as Request).url);
    expect(url.searchParams.has("filter[trigger]")).toBe(false); // empty list → omitted
    expect(url.searchParams.has("last_run_only")).toBe(false); // false → omitted
  });

  test("Job.listRuns threads triggers + lastRunOnly through to the runs filter", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await client.get(JOB_ID);
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    await job.listRuns({
      environment: "production",
      triggers: [RunTrigger.RETRY],
      lastRunOnly: true,
    });
    const url = new URL((mockFetch.mock.calls[1][0] as Request).url);
    expect(url.searchParams.get("filter[job]")).toBe(JOB_ID);
    expect(url.searchParams.get("filter[environment]")).toBe("production");
    expect(url.searchParams.get("filter[trigger]")).toBe("RETRY");
    expect(url.searchParams.get("last_run_only")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// Retry policies sub-client
// ---------------------------------------------------------------------------

describe("jobs.retryPolicies", () => {
  test("retryPolicies namespace is wired", () => {
    expect(makeClient().retryPolicies).toBeInstanceOf(RetryPoliciesClient);
  });

  test("new + save creates the policy (POST) and serializes the full attributes", async () => {
    const client = makeClient();
    const policy = client.retryPolicies.new(POLICY_ID, {
      name: "Retry on server errors",
      maxRetries: 5,
      backoff: Backoff.EXPONENTIAL,
      delaySeconds: 2,
      maxDelaySeconds: 60,
      retryOnTimeout: true,
      retryOnConnectionError: true,
      retryStatuses: ["429", "5xx"],
      retryStatusesExcept: ["501"],
    });
    expect(policy).toBeInstanceOf(RetryPolicy);
    expect(policy.createdAt).toBeNull();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _retryPolicyResource() }, 201));
    await policy.save();
    expect(policy.version).toBe(1);
    expect(policy.createdAt).not.toBeNull();
    const req = mockFetch.mock.calls[0][0] as Request;
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v1/retry-policies");
    const sent = JSON.parse(await req.text());
    expect(sent.data.id).toBe(POLICY_ID);
    expect(sent.data.type).toBe("retry_policy");
    expect(sent.data.attributes).toEqual({
      name: "Retry on server errors",
      max_retries: 5,
      backoff: "exponential",
      delay_seconds: 2,
      max_delay_seconds: 60,
      retry_on_timeout: true,
      retry_on_connection_error: true,
      retry_statuses: ["429", "5xx"],
      retry_statuses_except: ["501"],
    });
  });

  test("new without maxDelaySeconds omits it and defaults retry fields to empty/false", async () => {
    const client = makeClient();
    const policy = client.retryPolicies.new("fixed-retry", {
      name: "Fixed",
      maxRetries: 3,
      backoff: Backoff.FIXED,
      delaySeconds: 5,
    });
    expect(policy.maxDelaySeconds).toBeNull();
    expect(policy.retryOnTimeout).toBe(false);
    expect(policy.retryOnConnectionError).toBe(false);
    expect(policy.retryStatuses).toEqual([]);
    expect(policy.retryStatusesExcept).toEqual([]);
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          data: _retryPolicyResource({ backoff: "fixed", max_delay_seconds: null }, "fixed-retry"),
        },
        201,
      ),
    );
    await policy.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect("max_delay_seconds" in sent.data.attributes).toBe(false); // omitted when null
    expect(sent.data.attributes.retry_on_timeout).toBe(false);
    expect(sent.data.attributes.retry_on_connection_error).toBe(false);
    expect(sent.data.attributes.retry_statuses).toEqual([]);
    expect(sent.data.attributes.retry_statuses_except).toEqual([]);
  });

  test("save on an existing policy updates it (PUT) and round-trips fields", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _retryPolicyResource() }));
    const policy = await client.retryPolicies.get(POLICY_ID);
    expect(policy.backoff).toBe(Backoff.EXPONENTIAL);
    expect(policy.maxDelaySeconds).toBe(60);
    expect(policy.retryOnTimeout).toBe(true);
    expect(policy.retryOnConnectionError).toBe(true);
    expect(policy.retryStatuses).toEqual(["429", "5xx"]);
    expect(policy.retryStatusesExcept).toEqual(["501"]);
    policy.name = "renamed";
    policy.maxRetries = 7;
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _retryPolicyResource({ name: "renamed", max_retries: 7, version: 2 }) }),
    );
    await policy.save();
    expect(policy.version).toBe(2);
    expect(policy.name).toBe("renamed");
    const req = mockFetch.mock.calls[1][0] as Request;
    expect(req.method).toBe("PUT");
    expect(req.url).toContain(`/api/v1/retry-policies/${POLICY_ID}`);
  });

  test("list with and without params", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_retryPolicyResource()] }));
    const all = await client.retryPolicies.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toBeInstanceOf(RetryPolicy);
    expect(all[0].id).toBe(POLICY_ID);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.retryPolicies.list({ name: "server", pageNumber: 2, pageSize: 10 });
    const url = new URL((mockFetch.mock.calls[1][0] as Request).url);
    expect(url.searchParams.get("filter[name]")).toBe("server");
    expect(url.searchParams.get("page[number]")).toBe("2");
    expect(url.searchParams.get("page[size]")).toBe("10");
  });

  test("list tolerates a missing data array", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await client.retryPolicies.list()).toEqual([]);
  });

  test("get applies wire fallbacks for a sparse resource", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "sparse", type: "retry_policy", attributes: {} } }),
    );
    const policy = await client.retryPolicies.get("sparse");
    expect(policy.name).toBe("");
    expect(policy.maxRetries).toBe(0);
    expect(policy.backoff).toBe(Backoff.FIXED); // default fallback
    expect(policy.delaySeconds).toBe(0);
    expect(policy.maxDelaySeconds).toBeNull();
    expect(policy.retryOnTimeout).toBe(false);
    expect(policy.retryOnConnectionError).toBe(false);
    expect(policy.retryStatuses).toEqual([]);
    expect(policy.retryStatusesExcept).toEqual([]);
    expect(policy.createdAt).toBeNull();
    expect(policy.version).toBeNull();
  });

  test("get throws on an empty body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(client.retryPolicies.get(POLICY_ID)).rejects.toThrow(SmplError);
  });

  test("get surfaces an API error", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "404" }] }, 404));
    await expect(client.retryPolicies.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  test("delete (204) succeeds; delete via RetryPolicy.delete round-trips", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _retryPolicyResource() }));
    const policy = await client.retryPolicies.get(POLICY_ID);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await policy.delete();
    const req = mockFetch.mock.calls[1][0] as Request;
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain(`/api/v1/retry-policies/${POLICY_ID}`);
  });

  test("delete surfaces a non-204 error status", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "409" }] }, 409));
    await expect(client.retryPolicies.delete(POLICY_ID)).rejects.toThrow(SmplError);
  });

  test("delete surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.retryPolicies.delete(POLICY_ID)).rejects.toThrow(SmplConnectionError);
  });

  test("list surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.retryPolicies.list()).rejects.toThrow(SmplConnectionError);
  });

  test("_createRetryPolicy throws on an empty body", async () => {
    const client = makeClient();
    const policy = client.retryPolicies.new(POLICY_ID, {
      name: "n",
      maxRetries: 1,
      backoff: Backoff.FIXED,
      delaySeconds: 1,
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 201));
    await expect(policy.save()).rejects.toThrow(SmplError);
  });

  test("_createRetryPolicy surfaces an API error (409 on duplicate id)", async () => {
    const client = makeClient();
    const policy = client.retryPolicies.new(POLICY_ID, {
      name: "n",
      maxRetries: 1,
      backoff: Backoff.FIXED,
      delaySeconds: 1,
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "409" }] }, 409));
    await expect(policy.save()).rejects.toThrow(SmplError);
  });

  test("_updateRetryPolicy throws on an empty body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _retryPolicyResource() }));
    const policy = await client.retryPolicies.get(POLICY_ID);
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(policy.save()).rejects.toThrow(SmplError);
  });

  test("_updateRetryPolicy surfaces a network error", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _retryPolicyResource() }));
    const policy = await client.retryPolicies.get(POLICY_ID);
    mockFetch.mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(policy.save()).rejects.toThrow(SmplConnectionError);
  });

  test("save / delete without a client throw", async () => {
    const policy = new RetryPolicy(null, {
      id: POLICY_ID,
      name: "n",
      maxRetries: 1,
      backoff: Backoff.FIXED,
      delaySeconds: 1,
    });
    await expect(policy.save()).rejects.toThrow("cannot save");
    await expect(policy.delete()).rejects.toThrow("cannot delete");
  });
});
