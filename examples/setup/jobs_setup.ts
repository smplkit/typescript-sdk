/** Setup / cleanup helpers for `jobs_showcase.ts`. */

import { JobsClient, SmplNotFoundError } from "../../src/index.js";

// Every job and retry policy the jobs showcase creates. Start-of-run cleanup
// removes residue from a prior run; the matching `finally` cleanup tears them
// down even when it fails mid-way, so a failed run never leaves orphans behind.
const DEMO_JOB_IDS = ["showcase-recurring", "showcase-manual", "showcase-oneoff"];
const DEMO_RETRY_POLICY_IDS = ["showcase-retry"];

export async function setupShowcase(jobs: JobsClient): Promise<void> {
  await cleanupShowcase(jobs);
}

export async function cleanupShowcase(jobs: JobsClient): Promise<void> {
  // Jobs first, then the policies they reference.
  for (const jobId of DEMO_JOB_IDS) {
    try {
      await jobs.delete(jobId);
    } catch (err) {
      if (!(err instanceof SmplNotFoundError)) throw err;
    }
  }
  for (const policyId of DEMO_RETRY_POLICY_IDS) {
    try {
      await jobs.retryPolicies.delete(policyId);
    } catch (err) {
      if (!(err instanceof SmplNotFoundError)) throw err;
    }
  }
}
