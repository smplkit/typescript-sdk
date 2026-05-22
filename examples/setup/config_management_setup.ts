/** Setup / cleanup helpers for `config_management_showcase.ts`. */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_CONFIG_IDS = ["showcase-user-service", "showcase-common"];

export async function setupManagementShowcase(manage: SmplManagementClient): Promise<void> {
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
