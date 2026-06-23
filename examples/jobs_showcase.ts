/**
 * Demonstrates the smplkit SDK for Smpl Jobs.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/jobs_showcase.ts
 */

import { strict as assert } from "node:assert";

import { JobsClient, SmplConflictError } from "../src/index.js";
import {
  Backoff,
  HttpConfig,
  JobKind,
  JobsHttpMethod,
  RunTrigger,
} from "../src/index.js";

import { cleanupShowcase, setupShowcase } from "./setup/jobs_setup.js";

const RECURRING_JOB_ID = "showcase-recurring";
const MANUAL_JOB_ID = "showcase-manual";
const ONEOFF_JOB_ID = "showcase-oneoff";
const RETRY_POLICY_ID = "showcase-retry";

async function main(): Promise<void> {
  // or reached as `client.jobs` on a SmplClient
  const jobs = new JobsClient();
  await setupShowcase(jobs);
  try {
    // create a retry policy
    const retryPolicy = jobs.retryPolicies.new(RETRY_POLICY_ID, {
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
    await retryPolicy.save();
    assert((await jobs.retryPolicies.list()).some((p) => p.id === RETRY_POLICY_ID));
    console.log(`Created retry policy ${retryPolicy.id}`);

    // create a recurring job
    const job = jobs.newRecurringJob(RECURRING_JOB_ID, {
      name: "Nightly cache warm",
      description: "Warms the product cache nightly.",
      schedule: "0 2 * * *",
      configuration: new HttpConfig({
        method: JobsHttpMethod.POST,
        url: "https://httpbin.org/post",
        headers: { Authorization: "Bearer s3cr3t" },
        body: '{"scope": "all"}',
        timeout: 30,
      }),
    });

    // enable the job to run in various environments
    job.environment("development").enabled = true;
    job.environment("production").enabled = true;

    // change how the job runs in production
    const prod = job.environment("production");
    prod.schedule = "0 */6 * * *";
    prod.timezone = "America/New_York";
    prod.url = "https://production.example.com/cache/warm";
    prod.setHeader("Authorization", "Bearer production-s3cr3t");
    await job.save();
    assert.equal(job.isRecurring(), true);
    assert.equal(job.environment("production").schedule, "0 */6 * * *");
    assert.equal(
      job.environment("production").url,
      "https://production.example.com/cache/warm",
    );
    console.log(`Created recurring job ${job.id} (v${job.version})`);

    // get a job
    const fetched = await jobs.get(RECURRING_JOB_ID);
    assert.equal(fetched.environments["production"].schedule, "0 */6 * * *");
    console.log(`Fetched job ${RECURRING_JOB_ID}`);

    // list jobs, filtered to recurring jobs
    const listing = await jobs.list({ kind: JobKind.RECURRING });
    assert(listing.some((j) => j.id === RECURRING_JOB_ID));
    console.log(`Found job ${RECURRING_JOB_ID} in the listing`);

    // update a job
    job.name = "Nightly cache warm (v2)";
    job.environment("production").retryPolicy = retryPolicy;
    await job.save();
    assert.equal(job.version, 2);
    console.log(`Updated job to v${job.version}`);

    // trigger an immediate run
    let run = await job.trigger("production");
    assert(run.trigger === "MANUAL" && run.environment === "production");
    console.log(`Triggered run ${run.id} (trigger=${run.trigger}, env=${run.environment})`);

    // get this job's runs
    const runs = await job.listRuns({ environment: "production" });
    assert(runs.some((r) => r.id === run.id));
    console.log(`Listed ${runs.length} production run(s)`);

    // get the last completed run in production
    const recent = await job.listRuns({ environment: "production", lastRunOnly: true });
    console.log(`Last completed production run(s): ${recent.length}`);

    // get a run
    run = await jobs.runs.get(run.id);
    assert.equal(run.environment, "production");
    console.log(`Fetched run ${run.id} (env=${run.environment})`);

    // re-run a prior run (inherits its environment)
    const rerun = await run.rerun();
    assert(rerun.trigger === "RERUN" && rerun.environment === run.environment);
    console.log(`Re-ran ${run.id} -> ${rerun.id} (env=${rerun.environment})`);

    // cancel a run (best-effort: a finished run can no longer be canceled)
    try {
      const canceled = await rerun.cancel();
      console.log(`Canceled run ${canceled.id} -> ${canceled.status}`);
    } catch (err) {
      if (!(err instanceof SmplConflictError)) throw err;
      console.log(`Run ${rerun.id} already finished before it could be canceled`);
    }

    // create a manual job (no schedule, runs only when triggered)
    const manual = jobs.newManualJob(MANUAL_JOB_ID, {
      name: "On-demand reindex",
      configuration: new HttpConfig({
        method: JobsHttpMethod.POST,
        url: "https://httpbin.org/post",
      }),
    });
    manual.environment("production").enabled = true;
    await manual.save();
    assert.equal(manual.isManual(), true);
    const manualRun = await manual.trigger("production");
    assert.equal(manualRun.trigger, RunTrigger.MANUAL);
    console.log(`Created manual job ${manual.id} and triggered it on demand`);

    // schedule a one-off job to run tomorrow
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const oneoff = jobs.schedule(ONEOFF_JOB_ID, {
      name: "One-shot reindex",
      schedule: tomorrow,
      configuration: new HttpConfig({
        method: JobsHttpMethod.POST,
        url: "https://httpbin.org/post",
      }),
      environment: "development",
    });
    await oneoff.save();
    assert.equal(oneoff.isOneOff(), true);
    assert.equal(oneoff.environment("development").enabled, true);
    assert(oneoff.environments["development"].nextRunAt !== null);
    console.log(`Created one-off job ${oneoff.id} to run in development`);

    // delete a job
    await job.delete();
    assert(!(await jobs.list()).some((j) => j.id === RECURRING_JOB_ID));

    // delete the retry policy
    await retryPolicy.delete();
    console.log(`Deleted job ${RECURRING_JOB_ID} and retry policy — jobs showcase complete.`);
  } finally {
    await cleanupShowcase(jobs);
    jobs.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
