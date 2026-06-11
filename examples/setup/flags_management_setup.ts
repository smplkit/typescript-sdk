/** Setup / cleanup helpers for `flags_management_showcase.ts`. */

import { SmplClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_FLAG_IDS = ["checkout-v2", "banner-color", "max-retries", "ui-theme"];

export async function setupManagementShowcase(client: SmplClient): Promise<void> {
  await cleanupManagementShowcase(client);
}

export async function cleanupManagementShowcase(client: SmplClient): Promise<void> {
  for (const flagId of DEMO_FLAG_IDS) {
    try {
      await client.flags.delete(flagId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
