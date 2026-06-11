/** Setup / cleanup helpers for `config_management_showcase.ts`. */

import { SmplClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_CONFIG_IDS = ["showcase-user-service", "showcase-common"];

export async function setupManagementShowcase(client: SmplClient): Promise<void> {
  await cleanupManagementShowcase(client);
}

export async function cleanupManagementShowcase(client: SmplClient): Promise<void> {
  for (const configId of DEMO_CONFIG_IDS) {
    try {
      await client.config.delete(configId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
