/** Setup / cleanup helpers for `config_management_showcase.ts`. */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_ENVIRONMENTS = ["staging", "production"];
const DEMO_CONFIG_IDS = ["showcase-user-service", "showcase-common"];

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
  for (const configId of DEMO_CONFIG_IDS) {
    try {
      await manage.config.delete(configId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
