/** Setup / cleanup helpers for `flags_management_showcase.ts`. */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_ENVIRONMENTS = ["staging", "production"];
const DEMO_FLAG_IDS = ["checkout-v2", "banner-color", "max-retries", "ui-theme"];

export async function setupManagementShowcase(manage: SmplManagementClient): Promise<void> {
  const existing = new Set((await manage.environments.list()).map((env) => env.id));
  for (const envId of DEMO_ENVIRONMENTS) {
    if (!existing.has(envId)) {
      await manage.environments
        .new(envId, { name: envId.charAt(0).toUpperCase() + envId.slice(1) })
        .save();
    }
  }
  await cleanupManagementShowcase(manage);
}

export async function cleanupManagementShowcase(manage: SmplManagementClient): Promise<void> {
  for (const flagId of DEMO_FLAG_IDS) {
    try {
      await manage.flags.delete(flagId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
