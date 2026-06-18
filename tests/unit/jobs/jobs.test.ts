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
import { JobsClient, RunsClient } from "../../../src/jobs/client.js";
import {
  HttpConfig,
  HttpMethod,
  Job,
  JobEnvironment,
  Run,
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

function _newJob(client: JobsClient): Job {
  return client.new(JOB_ID, {
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
    expect(job.recurring).toBeNull();
    expect(job.type).toBe("http");
    expect(job.concurrencyPolicy).toBe("ALLOW");
    expect(job.createdAt).toBeNull();
    expect(job.updatedAt).toBeNull();
    expect(job.deletedAt).toBeNull();
    expect(job.version).toBeNull();
    expect(job._client).toBeNull();
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
      recurring: true,
      name: "health",
      pageNumber: 1,
      pageSize: 50,
    });
    expect(filtered).toEqual([]);
    const url = new URL((mockFetch.mock.calls[1][0] as Request).url);
    expect(url.searchParams.has("filter[enabled]")).toBe(false); // param removed from the API
    expect(url.searchParams.get("filter[recurring]")).toBe("true");
    expect(url.searchParams.get("filter[name]")).toBe("health");
    expect(url.searchParams.get("page[number]")).toBe("1");
    expect(url.searchParams.get("page[size]")).toBe("50");
  });

  test("list tolerates a missing data array", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await client.list()).toEqual([]);
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
    expect(job.recurring).toBeNull();
    expect(job.type).toBe("http");
    expect(job.schedule).toBe("");
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
    const job = client.new(JOB_ID, {
      name: "n",
      schedule: "now",
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
    expect(JobsNamespace.HttpConfig).toBe(HttpConfig);
    expect(JobsNamespace.Job).toBe(Job);
    expect(JobsNamespace.Run).toBe(Run);
    expect(JobsNamespace.Usage).toBe(Usage);
    expect(JobsNamespace.HttpMethod).toBe(HttpMethod);
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
    expect(e.configuration).toBeNull();
    expect(e.nextRunAt).toBeNull();
  });

  test("JobEnvironment keeps explicit field values", () => {
    const e = new JobEnvironment({
      enabled: true,
      schedule: "0 3 * * *",
      configuration: new HttpConfig({ url: "https://e.com" }),
      nextRunAt: "2026-06-07T03:00:00+00:00",
    });
    expect(e.enabled).toBe(true);
    expect(e.schedule).toBe("0 3 * * *");
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
    // base schedule (no environment)
    job.setSchedule("30 2 * * *");
    expect(job.schedule).toBe("30 2 * * *");
    expect(job.environments).toEqual({});
    // per-environment override creates the entry, leaving the base untouched
    job.setSchedule("0 5 * * *", "production");
    expect(job.schedule).toBe("30 2 * * *");
    expect(job.environments.production.schedule).toBe("0 5 * * *");
    // a per-env schedule override preserves an already-set enabled flag
    job.setEnabled(true, "staging");
    job.setSchedule("0 6 * * *", "staging");
    expect(job.environments.staging.enabled).toBe(true);
    expect(job.environments.staging.schedule).toBe("0 6 * * *");
  });

  test("create sends the environments map (schedule when set, never enabled/next_run_at)", async () => {
    const client = makeClient();
    const job = client.new(JOB_ID, {
      name: "x",
      schedule: "0 2 * * *",
      configuration: new HttpConfig({ url: "https://api.example.com" }),
    });
    job.setEnabled(true, "production");
    job.setSchedule("0 5 * * *", "production"); // per-env cron override
    job.setConfiguration(new HttpConfig({ url: "https://staging.example.com" }), "staging");
    job.setEnabled(false, "staging");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    const sent = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
    expect(sent.data.attributes.enabled).toBeUndefined(); // read-only roll-up not sent
    // production carries its per-environment schedule override
    expect(sent.data.attributes.environments.production).toEqual({
      enabled: true,
      configuration: null,
      schedule: "0 5 * * *",
    });
    // the read-only next_run_at is never serialized onto the wire
    expect(sent.data.attributes.environments.production.next_run_at).toBeUndefined();
    // staging has no schedule override, so the key is omitted entirely
    expect(sent.data.attributes.environments.staging.enabled).toBe(false);
    expect("schedule" in sent.data.attributes.environments.staging).toBe(false);
    expect(sent.data.attributes.environments.staging.configuration.url).toBe(
      "https://staging.example.com",
    );
  });

  test("get parses environments (schedule, config override, next_run_at) and recurring", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _jobResource({
          recurring: true,
          environments: {
            production: {
              enabled: true,
              schedule: "0 3 * * *", // per-env cron override
              next_run_at: "2026-06-07T03:00:00+00:00", // read-only
            },
            staging: {
              enabled: false,
              configuration: { method: "POST", url: "https://staging.example.com/x", headers: [] },
              // no schedule override, next_run_at null while disabled
              next_run_at: null,
            },
          },
        }),
      }),
    );
    const job = await client.get(JOB_ID);
    expect(job.recurring).toBe(true);
    expect(job.enabled).toBe(true); // derived roll-up: production is enabled
    expect(job.environments.production.enabled).toBe(true);
    expect(job.environments.production.schedule).toBe("0 3 * * *");
    expect(job.environments.production.nextRunAt).toBe("2026-06-07T03:00:00+00:00");
    expect(job.environments.production.configuration).toBeNull();
    // staging: no schedule override → null; disabled → null next_run_at
    expect(job.environments.staging.schedule).toBeNull();
    expect(job.environments.staging.nextRunAt).toBeNull();
    expect(job.environments.staging.configuration?.url).toBe("https://staging.example.com/x");
  });

  test("one-off birth environment is sent as a header on create", async () => {
    const client = makeClient();
    const job = client.new("one-off", {
      name: "x",
      schedule: "now",
      configuration: new HttpConfig({ url: "https://api.example.com" }),
      environment: "staging",
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource({}, "one-off") }, 201));
    await job.save();
    expect((mockFetch.mock.calls[0][0] as Request).headers.get("X-Smplkit-Environment")).toBe(
      "staging",
    );
  });

  test("client-level environment is the default birth header and update header", async () => {
    const client = envClient("production");
    const job = client.new(JOB_ID, {
      name: "x",
      schedule: "now",
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
