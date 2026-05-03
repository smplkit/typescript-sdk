/** Setup / cleanup helpers for `logging_management_showcase.ts`. */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_ENVIRONMENTS = ["staging", "production"];
const DEMO_LOGGER_IDS = ["showcase", "showcase.db", "showcase.payments"];

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
  for (const loggerId of DEMO_LOGGER_IDS) {
    try {
      await manage.loggers.delete(loggerId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
