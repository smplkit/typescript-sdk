/**
 * Tests for the management jobs surface — `mgmt.jobs.*`, `mgmt.jobs.runs.*`,
 * and the active-record {@link Job} model.
 *
 * Uses SmplManagementClient with a stubbed global fetch. Coverage target is
 * 100% on the src/management/jobs.ts and src/jobs/types.ts wrapper layers.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SmplManagementClient } from "../../../src/management/client.js";
import { ManagementJobsClient, RunsClient } from "../../../src/management/jobs.js";
import { HttpConfig, HttpMethod, Job, Run, Usage } from "../../../src/jobs/types.js";
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

function makeClient(): SmplManagementClient {
  return new SmplManagementClient({
    apiKey: "sk_mgmt_test",
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
      enabled: false,
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
      next_run_at: "2026-06-06T02:00:00+00:00",
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

function _newJob(mgmt: SmplManagementClient): Job {
  return mgmt.jobs.new(JOB_ID, {
    name: "Nightly cache warm",
    schedule: "0 2 * * *",
    configuration: new HttpConfig({
      method: HttpMethod.POST,
      url: "https://api.example.com/cache/warm",
      headers: [{ name: "Authorization", value: "Bearer s3cr3t" }],
      body: '{"scope":"all"}',
    }),
    enabled: false,
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
    expect(run.startedAt).toBeNull();
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
});

describe("Job active record (client-less guards)", () => {
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

describe("mgmt.jobs CRUD", () => {
  test("new + save creates the job (POST) and refreshes fields", async () => {
    const mgmt = makeClient();
    const job = _newJob(mgmt);
    expect(job.createdAt).toBeNull();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    expect(job.version).toBe(1);
    expect(job.createdAt).not.toBeNull();
    expect(job.configuration.url).toBe("https://api.example.com/cache/warm");
    expect((mockFetch.mock.calls[0][0] as Request).method).toBe("POST");
  });

  test("save on an existing job updates it (PUT)", async () => {
    const mgmt = makeClient();
    const job = _newJob(mgmt);
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }, 201));
    await job.save();
    job.name = "renamed";
    job.enabled = true;
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _jobResource({ name: "renamed", enabled: true, version: 2 }) }),
    );
    await job.save();
    expect(job.version).toBe(2);
    expect(job.enabled).toBe(true);
    expect((mockFetch.mock.calls[1][0] as Request).method).toBe("PUT");
  });

  test("list with and without filters", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_jobResource()] }));
    const all = await mgmt.jobs.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toBeInstanceOf(Job);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const filtered = await mgmt.jobs.list({ enabled: false, pageNumber: 1, pageSize: 50 });
    expect(filtered).toEqual([]);
    const url = (mockFetch.mock.calls[1][0] as Request).url;
    expect(url).toContain("filter[enabled]=false");
    expect(url).toContain("page[number]=1");
  });

  test("list tolerates a missing data array", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await mgmt.jobs.list()).toEqual([]);
  });

  test("get returns a bound Job", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await mgmt.jobs.get(JOB_ID);
    expect(job.id).toBe(JOB_ID);
    expect(job._client).toBe(mgmt.jobs);
  });

  test("get throws on an empty body", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(mgmt.jobs.get(JOB_ID)).rejects.toThrow(SmplError);
  });

  test("delete (204) succeeds; delete via Job.delete round-trips", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await mgmt.jobs.get(JOB_ID);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await job.delete();
    const url = (mockFetch.mock.calls[1][0] as Request).url;
    expect(url).toContain(`/api/v1/jobs/${JOB_ID}`);
  });

  test("delete surfaces a non-204 error status", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "nope" }] }, 404));
    await expect(mgmt.jobs.delete(JOB_ID)).rejects.toThrow(SmplNotFoundError);
  });

  test("run triggers a MANUAL run", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource() }));
    const run = await mgmt.jobs.run(JOB_ID);
    expect(run).toBeInstanceOf(Run);
    expect(run.trigger).toBe("MANUAL");
  });

  test("run throws on an empty body", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(mgmt.jobs.run(JOB_ID)).rejects.toThrow(SmplError);
  });

  test("run surfaces an API error", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "404" }] }, 404));
    await expect(mgmt.jobs.run("missing")).rejects.toThrow(SmplNotFoundError);
  });

  test("usage returns the counters", async () => {
    const mgmt = makeClient();
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
    const usage = await mgmt.jobs.usage();
    expect(usage).toBeInstanceOf(Usage);
    expect(usage.runsUsed).toBe(7);
  });

  test("usage throws on an empty body", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(mgmt.jobs.usage()).rejects.toThrow(SmplError);
  });

  test("usage surfaces a network error", async () => {
    const mgmt = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(mgmt.jobs.usage()).rejects.toThrow(SmplConnectionError);
  });

  test("_createJob throws on an empty body", async () => {
    const mgmt = makeClient();
    const job = _newJob(mgmt);
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 201));
    await expect(job.save()).rejects.toThrow(SmplError);
  });

  test("_updateJob throws on an empty body", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await mgmt.jobs.get(JOB_ID);
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(job.save()).rejects.toThrow(SmplError);
  });

  test("_createJob surfaces an API error (409 on duplicate id)", async () => {
    const mgmt = makeClient();
    const job = _newJob(mgmt);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ errors: [{ status: "409", detail: "exists" }] }, 409),
    );
    await expect(job.save()).rejects.toThrow(SmplError);
  });

  test("_updateJob surfaces a network error", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _jobResource() }));
    const job = await mgmt.jobs.get(JOB_ID);
    mockFetch.mockRejectedValueOnce(new TypeError("connection reset"));
    await expect(job.save()).rejects.toThrow(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

describe("mgmt.jobs.runs", () => {
  test("runs namespace is wired", () => {
    const mgmt = makeClient();
    expect(mgmt.jobs.runs).toBeInstanceOf(RunsClient);
  });

  test("list with and without params", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_runResource()] }));
    const all = await mgmt.jobs.runs.list();
    expect(all).toHaveLength(1);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await mgmt.jobs.runs.list({ job: JOB_ID, pageSize: 2, after: "cursor" });
    const url = (mockFetch.mock.calls[1][0] as Request).url;
    expect(url).toContain("filter[job]=" + JOB_ID);
    expect(url).toContain("page[size]=2");
    expect(url).toContain("page[after]=cursor");
  });

  test("list tolerates a missing data array", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await mgmt.jobs.runs.list()).toEqual([]);
  });

  test("get / cancel / rerun a run", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource() }));
    expect((await mgmt.jobs.runs.get(RUN_ID)).id).toBe(RUN_ID);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _runResource({ status: "CANCELED" }) }));
    expect((await mgmt.jobs.runs.cancel(RUN_ID)).status).toBe("CANCELED");

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: _runResource(
          { trigger: "RERUN", rerun_of: RUN_ID },
          "00000000-0000-4000-8000-000000000001",
        ),
      }),
    );
    const rerun = await mgmt.jobs.runs.rerun(RUN_ID);
    expect(rerun.trigger).toBe("RERUN");
    expect(rerun.rerunOf).toBe(RUN_ID);
  });

  test("a run action throws on an empty body", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(mgmt.jobs.runs.get(RUN_ID)).rejects.toThrow(SmplError);
  });

  test("a run action surfaces an API error", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ status: "404" }] }, 404));
    await expect(mgmt.jobs.runs.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  test("runs.list surfaces a network error", async () => {
    const mgmt = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(mgmt.jobs.runs.list()).rejects.toThrow(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("error handling", () => {
  test("a 404 surfaces as SmplNotFoundError (and propagates through wrapFetchError)", async () => {
    const mgmt = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ errors: [{ status: "404", detail: "missing" }] }, 404),
    );
    await expect(mgmt.jobs.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  test("a network TypeError becomes SmplConnectionError", async () => {
    const mgmt = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(mgmt.jobs.get(JOB_ID)).rejects.toThrow(SmplConnectionError);
  });

  test("a non-Error rejection becomes SmplConnectionError", async () => {
    const mgmt = makeClient();
    mockFetch.mockRejectedValueOnce("boom");
    await expect(mgmt.jobs.list()).rejects.toThrow(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("ManagementJobsClient construction", () => {
  test("mgmt.jobs is a ManagementJobsClient", () => {
    const mgmt = makeClient();
    expect(mgmt.jobs).toBeInstanceOf(ManagementJobsClient);
  });

  test("the jobs namespace barrel re-exports the public surface", () => {
    expect(JobsNamespace.HttpConfig).toBe(HttpConfig);
    expect(JobsNamespace.Job).toBe(Job);
    expect(JobsNamespace.Run).toBe(Run);
    expect(JobsNamespace.Usage).toBe(Usage);
    expect(JobsNamespace.HttpMethod).toBe(HttpMethod);
  });
});
