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
import { HttpConfig, JobsHttpMethod } from "../src/index.js";

import { cleanupShowcase, setupShowcase } from "./setup/jobs_setup.js";

const RECURRING_JOB_ID = "showcase-recurring";
const ONEOFF_JOB_ID = "showcase-oneoff";

async function main(): Promise<void> {
  // or reached as `client.jobs` on a SmplClient
  const jobs = new JobsClient();
  await setupShowcase(jobs);
  try {
    // create a recurring job, enabled in production with a development override
    const job = jobs.new(RECURRING_JOB_ID, {
      name: "Nightly cache warm",
      description: "Warms the product cache every night at 02:00 UTC.",
      schedule: "0 2 * * *",
      configuration: new HttpConfig({
        method: JobsHttpMethod.POST,
        url: "https://httpbin.org/post",
        headers: [{ name: "Authorization", value: "Bearer s3cr3t" }],
        body: '{"scope": "all"}',
        timeout: 30,
      }),
    });
    job.setConfiguration(
      new HttpConfig({
        method: JobsHttpMethod.POST,
        url: "https://development.example.com/cache/warm",
        headers: [{ name: "Authorization", value: "Bearer development-s3cr3t" }],
        body: '{"scope": "all"}',
      }),
      "development",
    );
    job.setEnabled(false, "development");
    job.setEnabled(true, "production");
    await job.save();
    assert.equal(job.version, 1);
    assert.equal(job.isEnabled("development"), false);
    assert.equal(job.isEnabled("production"), true);
    console.log(`Created recurring job ${job.id} (v${job.version})`);

    // get a job
    const fetched = await jobs.get(RECURRING_JOB_ID);
    assert.equal(fetched.isEnabled("development"), false);
    assert.equal(fetched.isEnabled("production"), true);
    assert.equal(
      fetched.getConfiguration("development").url,
      "https://development.example.com/cache/warm",
    );
    console.log(`Fetched job ${RECURRING_JOB_ID}`);

    // list jobs
    const listing = await jobs.list();
    assert(listing.some((j) => j.id === RECURRING_JOB_ID));
    console.log(`Found job ${RECURRING_JOB_ID} in the listing`);

    // update a job (the schedule is environment-agnostic)
    job.name = "Nightly cache warm (v2)";
    job.setSchedule("30 2 * * *");
    job.setEnabled(true, "development");
    await job.save();
    assert(job.version === 2 && job.isEnabled("development") === true);
    console.log(`Updated job to v${job.version}: now enabled in production and development`);

    // trigger an immediate run
    let run = await job.trigger("production");
    assert(run.trigger === "MANUAL" && run.environment === "production");
    console.log(`Triggered run ${run.id} (trigger=${run.trigger}, env=${run.environment})`);

    // get this job's runs
    const runs = await job.listRuns({ environment: "production" });
    assert(runs.some((r) => r.id === run.id));
    console.log(`Listed ${runs.length} production run(s)`);

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

    // create a one-off job, born in a single environment
    const oneoff = jobs.new(ONEOFF_JOB_ID, {
      name: "One-shot reindex",
      schedule: "now",
      configuration: new HttpConfig({
        method: JobsHttpMethod.POST,
        url: "https://httpbin.org/post",
      }),
      environment: "development",
    });
    await oneoff.save();
    assert(oneoff.version === 1 && oneoff.isEnabled("development") === true);
    console.log(`Created one-off job ${oneoff.id} born in development`);

    // delete a job
    await job.delete();
    assert(!(await jobs.list()).some((j) => j.id === RECURRING_JOB_ID));
    console.log(`Deleted job ${RECURRING_JOB_ID} — jobs showcase complete.`);
  } finally {
    await cleanupShowcase(jobs);
    jobs.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
