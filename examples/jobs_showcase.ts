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
import { randomUUID } from "node:crypto";

import { SmplClient, SmplNotFoundError } from "../src/index.js";
import { HttpConfig, JobsHttpMethod } from "../src/index.js";

async function main(): Promise<void> {
  // Jobs has no runtime/management split — one client. Here the full surface
  // is reached as `client.jobs` on a SmplClient; it is also available via a
  // standalone JobsClient.
  const client = new SmplClient();
  const jobs = client.jobs;
  const jobId = `showcase-mgmt-${randomUUID().slice(0, 8)}`;

  try {
    // create a job
    const job = jobs.new(jobId, {
      name: "Nightly cache warm",
      description: "Warms the product cache every night at 02:00 UTC.",
      schedule: "0 2 * * *", // 5-field cron, UTC
      enabled: false,
      configuration: new HttpConfig({
        method: JobsHttpMethod.POST,
        url: "https://api.example.com/cache/warm",
        headers: [{ name: "Authorization", value: "Bearer s3cr3t" }],
        body: '{"scope": "all"}',
        timeout: 30,
      }),
    });
    await job.save();
    assert.equal(job.version, 1);
    console.log(`Created job ${job.id} (v${job.version})`);

    // get a job
    const fetched = await jobs.get(jobId);
    assert.equal(fetched.configuration.url, "https://api.example.com/cache/warm");
    console.log(`Fetched job ${jobId}`);

    // list jobs
    const listing = await jobs.list({ enabled: false });
    assert(listing.some((j) => j.id === jobId));
    console.log(`Found job ${jobId} and in the listing`);

    // update a job
    job.name = "Nightly cache warm (v2)";
    job.schedule = "30 2 * * *";
    job.enabled = true;
    await job.save();
    assert(job.version === 2 && job.enabled === true);
    console.log(`Updated job to v${job.version}: schedule=${job.schedule}`);

    // trigger an immediate run (a MANUAL run)
    const run = await jobs.run(jobId);
    assert(run.trigger === "MANUAL" && run.job === jobId);
    console.log(`Triggered run ${run.id} (trigger=${run.trigger}, status=${run.status})`);

    // read run history for this job, and fetch a single run
    const runs = await jobs.runs.list({ job: jobId });
    assert(runs.some((r) => r.id === run.id));
    const got = await jobs.runs.get(run.id);
    assert.equal(got.id, run.id);
    console.log(`Listed ${runs.length} run(s); fetched run ${got.id} (status=${got.status})`);

    // re-run from a prior run, then cancel it while it's still pending
    const rerun = await jobs.runs.rerun(run.id);
    assert(rerun.trigger === "RERUN" && rerun.rerunOf === run.id);
    const canceled = await jobs.runs.cancel(rerun.id);
    assert.equal(canceled.status, "CANCELED");
    console.log(`Re-ran (${rerun.id}) then canceled it -> ${canceled.status}`);

    // delete a job
    await job.delete();
    assert(!(await jobs.list()).some((j) => j.id === jobId));
    console.log(`Deleted job ${jobId} — jobs showcase complete.`);
  } finally {
    // tear-down: never leave the showcase job behind, even on failure
    try {
      await jobs.delete(jobId);
    } catch (err) {
      if (!(err instanceof SmplNotFoundError)) throw err;
    }
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
