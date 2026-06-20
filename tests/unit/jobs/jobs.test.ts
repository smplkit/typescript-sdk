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
  RetryOn,
  RetryPolicy,
  RetryReason,
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
        headers: [{ name: "Authorization", value: "<redacted>" }],
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
      retry_on: { statuses: [429, 503], reasons: ["TIMEOUT"] },
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
      headers: [{ name: "Authorization", value: "Bearer s3cr3t" }],
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
    expect(c.headers).toEqual([]);
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
      headers: [{ name: "X", value: "y" }],
      body: "hi",
      successStatus: "200",
      timeout: 5,
      tlsVerify: false,
      caCert: "PEM",
    });
    expect(c.method).toBe(HttpMethod.GET);
    expect(c.timeout).toBe(5);
    expect(c.tlsVerify).toBe(false);
    expect(c.caCert).toBe("PEM");
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
    job.setEnabled(true, "production");
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
    expect(job.isEnabled("production")).toBe(true);
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
    job.setEnabled(true, "production");
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
    expect(job.configuration.headers[0]).toEqual({
      name: "Authorization",
      value: "<redacted>",
    });
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
    expect(job.concurrencyPolicy).toBe("ALLOW");
    expect(job.createdAt).toBeNull();
    expect(job.version).toBeNull();
    expect(job.configuration.url).toBe("");
    expect(job.configuration.method).toBe(HttpMethod.POST);
    expect(job.configuration.headers).toEqual([]);
    expect(job.configuration.body).toBeNull();
    expect(job.configuration.successStatus).toBe("2xx");
    expect(job.configuration.timeout).toBe(30);
    expect(job.configuration.tlsVerify).toBe(true);
    expect(job.configuration.caCert).toBeNull();
  });

  test("get handles a configuration with sparse header objects and an explicit body", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          configuration: {
            url: "https://e.com",
            method: "GET",
            headers: [{}],
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
    expect(job.configuration.headers).toEqual([{ name: "", value: "" }]);
    expect(job.configuration.body).toBe("payload");
    expect(job.configuration.successStatus).toBe("200");
    expect(job.configuration.timeout).toBe(5);
    expect(job.configuration.tlsVerify).toBe(false);
    expect(job.configuration.caCert).toBe("PEM");
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
        headers: [{ name: "X", value: "y" }],
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
    expect(cfg.headers).toEqual([{ name: "X", value: "y" }]);
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
    expect(JobsNamespace.Job).toBe(Job);
    expect(JobsNamespace.Run).toBe(Run);
    expect(JobsNamespace.RunRetry).toBe(RunRetry);
    expect(JobsNamespace.Usage).toBe(Usage);
    expect(JobsNamespace.RetryPolicy).toBe(RetryPolicy);
    expect(JobsNamespace.RetryOn).toBe(RetryOn);
    expect(JobsNamespace.HttpMethod).toBe(HttpMethod);
    expect(JobsNamespace.JobKind).toBe(JobKind);
    expect(JobsNamespace.RunTrigger).toBe(RunTrigger);
    expect(JobsNamespace.Backoff).toBe(Backoff);
    expect(JobsNamespace.RetryReason).toBe(RetryReason);
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

  test("JobEnvironment defaults", () => {
    const e = new JobEnvironment();
    expect(e.enabled).toBe(false);
    expect(e.schedule).toBeNull();
    expect(e.timezone).toBeNull();
    expect(e.configuration).toBeNull();
    expect(e.nextRunAt).toBeNull();
  });

  test("JobEnvironment keeps explicit field values", () => {
    const e = new JobEnvironment({
      enabled: true,
      schedule: "0 3 * * *",
      timezone: "Europe/London",
      configuration: new HttpConfig({ url: "https://e.com" }),
      nextRunAt: "2026-06-07T03:00:00+00:00",
    });
    expect(e.enabled).toBe(true);
    expect(e.schedule).toBe("0 3 * * *");
    expect(e.timezone).toBe("Europe/London");
    expect(e.configuration?.url).toBe("https://e.com");
    expect(e.nextRunAt).toBe("2026-06-07T03:00:00+00:00");
  });

  test("setEnabled / isEnabled per environment and derived roll-up", () => {
    const job = _newJob(makeClient());
    expect(job.isEnabled()).toBe(false); // roll-up default (no environments)
    expect(job.enabled).toBe(false);
    job.setEnabled(true, "production");
    expect(job.isEnabled("production")).toBe(true); // per-env present
    expect(job.isEnabled("staging")).toBe(false); // env absent
    // the no-arg roll-up is derived from the environments map — enabling any
    // environment flips it to true, with nothing read from the wire
    expect(job.enabled).toBe(true);
    expect(job.isEnabled()).toBe(true);
    job.setEnabled(false, "production");
    expect(job.enabled).toBe(false); // back to false once no environment is enabled
    expect(job.isEnabled()).toBe(false);
  });

  test("setConfiguration / getConfiguration base and per environment", () => {
    const base = new HttpConfig({ url: "https://base.example.com" });
    const job = new Job(makeClient(), {
      id: JOB_ID,
      name: "x",
      schedule: "0 2 * * *",
      configuration: base,
    });
    expect(job.getConfiguration()).toBe(base);
    expect(job.getConfiguration("production")).toBe(base); // no override -> base
    const override = new HttpConfig({ url: "https://prod.example.com" });
    job.setConfiguration(override, "production");
    expect(job.getConfiguration("production")).toBe(override); // override wins
    // an env entry with no configuration falls back to base
    job.setEnabled(true, "staging");
    expect(job.getConfiguration("staging")).toBe(base);
    // base setter (no environment)
    const newBase = new HttpConfig({ url: "https://new.example.com" });
    job.setConfiguration(newBase);
    expect(job.configuration).toBe(newBase);
  });

  test("setSchedule sets the base schedule and per-environment overrides", () => {
    const job = _newJob(makeClient());
    // base schedule (no environment, no timezone)
    job.setSchedule("30 2 * * *");
    expect(job.schedule).toBe("30 2 * * *");
    expect(job.timezone).toBeNull(); // timezone untouched when omitted
    expect(job.environments).toEqual({});
    // per-environment override creates the entry, leaving the base untouched
    job.setSchedule("0 5 * * *", undefined, "production");
    expect(job.schedule).toBe("30 2 * * *");
    expect(job.environments.production.schedule).toBe("0 5 * * *");
    expect(job.environments.production.timezone).toBeNull(); // timezone omitted
    // a per-env schedule override preserves an already-set enabled flag
    job.setEnabled(true, "staging");
    job.setSchedule("0 6 * * *", undefined, "staging");
    expect(job.environments.staging.enabled).toBe(true);
    expect(job.environments.staging.schedule).toBe("0 6 * * *");
  });

  test("setSchedule with a timezone sets the same scope's timezone too", () => {
    const job = _newJob(makeClient());
    // base schedule + timezone in one call
    job.setSchedule("0 2 * * *", "America/New_York");
    expect(job.schedule).toBe("0 2 * * *");
    expect(job.timezone).toBe("America/New_York");
    expect(job.environments).toEqual({});
    // per-environment schedule + timezone in one call
    job.setSchedule("0 */6 * * *", "Europe/London", "production");
    expect(job.environments.production.schedule).toBe("0 */6 * * *");
    expect(job.environments.production.timezone).toBe("Europe/London");
    // the base scope is untouched by the per-env call
    expect(job.timezone).toBe("America/New_York");
  });

  test("setTimezone sets the base timezone and per-environment overrides", () => {
    const job = _newJob(makeClient());
    // base timezone (no environment)
    job.setTimezone("America/New_York");
    expect(job.timezone).toBe("America/New_York");
    expect(job.environments).toEqual({});
    // per-environment override creates the entry, leaving the base untouched
    job.setSchedule("0 5 * * *", undefined, "production");
    job.setTimezone("Europe/London", "production");
    expect(job.timezone).toBe("America/New_York");
    expect(job.environments.production.timezone).toBe("Europe/London");
    // setting a per-env timezone preserves the already-set schedule override
    expect(job.environments.production.schedule).toBe("0 5 * * *");
    // a brand-new environment override is created with the timezone alone
    job.setTimezone("Asia/Tokyo", "edge");
    expect(job.environments.edge.timezone).toBe("Asia/Tokyo");
    expect(job.environments.edge.enabled).toBe(false);
  });

  test("create sends the environments map (schedule when set, never enabled/next_run_at)", async () => {
    const client = makeClient();
    const job = client.newRecurringJob(JOB_ID, {
      name: "x",
      schedule: "0 2 * * *",
      configuration: new HttpConfig({ url: "https://api.example.com" }),
    });
    job.setEnabled(true, "production");
    job.setSchedule("0 5 * * *", undefined, "production"); // per-env cron override
    job.setTimezone("America/New_York"); // base timezone
    job.setTimezone("Europe/London", "production"); // per-env timezone override
    job.setConfiguration(new HttpConfig({ url: "https://staging.example.com" }), "staging");
    job.setEnabled(false, "staging");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect(sent.data.attributes.enabled).toBeUndefined(); // read-only roll-up not sent
    // the base timezone is sent when set
    expect(sent.data.attributes.timezone).toBe("America/New_York");
    // production carries its per-environment schedule + timezone overrides
    expect(sent.data.attributes.environments.production).toEqual({
      enabled: true,
      configuration: null,
      schedule: "0 5 * * *",
      timezone: "Europe/London",
    });
    // the read-only next_run_at is never serialized onto the wire
    expect(sent.data.attributes.environments.production.next_run_at).toBeUndefined();
    // staging has no schedule/timezone override, so the keys are omitted entirely
    expect(sent.data.attributes.environments.staging.enabled).toBe(false);
    expect("schedule" in sent.data.attributes.environments.staging).toBe(false);
    expect("timezone" in sent.data.attributes.environments.staging).toBe(false);
    expect(sent.data.attributes.environments.staging.configuration.url).toBe(
      "https://staging.example.com",
    );
  });

  test("get parses environments (schedule, config override, next_run_at) and kind", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          kind: "recurring",
          timezone: "America/New_York", // base timezone
          environments: {
            production: {
              enabled: true,
              schedule: "0 3 * * *", // per-env cron override
              timezone: "Europe/London", // per-env timezone override
              next_run_at: "2026-06-07T03:00:00+00:00", // read-only
            },
            staging: {
              enabled: false,
              configuration: { method: "POST", url: "https://staging.example.com/x", headers: [] },
              // no schedule/timezone override, next_run_at null while disabled
              next_run_at: null,
            },
          },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    expect(job.kind).toBe(JobKind.RECURRING);
    expect(job.isRecurring()).toBe(true);
    expect(job.enabled).toBe(true); // derived roll-up: production is enabled
    expect(job.timezone).toBe("America/New_York"); // base timezone decodes from the wire
    expect(job.environments.production.enabled).toBe(true);
    expect(job.environments.production.schedule).toBe("0 3 * * *");
    expect(job.environments.production.timezone).toBe("Europe/London");
    expect(job.environments.production.nextRunAt).toBe("2026-06-07T03:00:00+00:00");
    expect(job.environments.production.configuration).toBeNull();
    // staging: no schedule/timezone override → null; disabled → null next_run_at
    expect(job.environments.staging.schedule).toBeNull();
    expect(job.environments.staging.timezone).toBeNull();
    expect(job.environments.staging.nextRunAt).toBeNull();
    expect(job.environments.staging.configuration?.url).toBe("https://staging.example.com/x");
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
  test("RetryOn defaults to two empty lists (retries nothing)", () => {
    const r = new RetryOn();
    expect(r.statuses).toEqual([]);
    expect(r.reasons).toEqual([]);
  });

  test("RetryOn keeps explicit statuses and reasons", () => {
    const r = new RetryOn({ statuses: [429, 503], reasons: [RetryReason.TIMEOUT] });
    expect(r.statuses).toEqual([429, 503]);
    expect(r.reasons).toEqual([RetryReason.TIMEOUT]);
  });

  test("RunRetry holds the chain origin and attempt number", () => {
    const rr = new RunRetry("orig-run", 2);
    expect(rr.of).toBe("orig-run");
    expect(rr.attempt).toBe(2);
  });

  test("enum values match the wire", () => {
    expect(Backoff.EXPONENTIAL).toBe("exponential");
    expect(Backoff.FIXED).toBe("fixed");
    expect(RetryReason.CONNECTION_ERROR).toBe("CONNECTION_ERROR");
    expect(RetryReason.NON_SUCCESS_STATUS).toBe("NON_SUCCESS_STATUS");
    expect(RetryReason.TIMEOUT).toBe("TIMEOUT");
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
  test("setRetryPolicy accepts a RetryPolicy instance or a bare id, base and per-env", () => {
    const client = makeClient();
    const job = _newJob(client);
    const policy = client.retryPolicies.new(POLICY_ID, {
      name: "Retry on server errors",
      maxRetries: 5,
      backoff: Backoff.EXPONENTIAL,
      delaySeconds: 2,
    });
    // base: a RetryPolicy instance contributes its id
    job.setRetryPolicy(policy);
    expect(job.retryPolicy).toBe(POLICY_ID);
    // base: a bare id string is used as-is
    job.setRetryPolicy("Default");
    expect(job.retryPolicy).toBe("Default");
    // per-env override (object) creates the entry, preserving an enabled flag
    job.setEnabled(true, "production");
    job.setRetryPolicy(policy, "production");
    expect(job.environments.production.retryPolicy).toBe(POLICY_ID);
    expect(job.environments.production.enabled).toBe(true);
    // per-env override (bare id) on a brand-new environment entry
    job.setRetryPolicy("Default", "edge");
    expect(job.environments.edge.retryPolicy).toBe("Default");
    expect(job.environments.edge.enabled).toBe(false);
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
    job.setEnabled(true, "production");
    job.setRetryPolicy("Default", "production");
    job.setEnabled(true, "staging"); // no per-env retry policy
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
    job.setRetryPolicy(POLICY_ID);
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
      retryOn: new RetryOn({ statuses: [429, 503], reasons: [RetryReason.TIMEOUT] }),
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
      retry_on: { statuses: [429, 503], reasons: ["TIMEOUT"] },
    });
  });

  test("new without maxDelaySeconds omits it and defaults retry_on to empty", async () => {
    const client = makeClient();
    const policy = client.retryPolicies.new("fixed-retry", {
      name: "Fixed",
      maxRetries: 3,
      backoff: Backoff.FIXED,
      delaySeconds: 5,
    });
    expect(policy.maxDelaySeconds).toBeNull();
    expect(policy.retryOn).toBeInstanceOf(RetryOn);
    expect(policy.retryOn.statuses).toEqual([]);
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
    expect(sent.data.attributes.retry_on).toEqual({ statuses: [], reasons: [] });
  });

  test("save on an existing policy updates it (PUT) and round-trips fields", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _retryPolicyResource() }));
    const policy = await client.retryPolicies.get(POLICY_ID);
    expect(policy.backoff).toBe(Backoff.EXPONENTIAL);
    expect(policy.maxDelaySeconds).toBe(60);
    expect(policy.retryOn.statuses).toEqual([429, 503]);
    expect(policy.retryOn.reasons).toEqual([RetryReason.TIMEOUT]);
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
    expect(policy.retryOn.statuses).toEqual([]);
    expect(policy.retryOn.reasons).toEqual([]);
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
