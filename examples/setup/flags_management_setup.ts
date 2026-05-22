/** Setup / cleanup helpers for `flags_management_showcase.ts`. */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_FLAG_IDS = ["checkout-v2", "banner-color", "max-retries", "ui-theme"];

export async function setupManagementShowcase(manage: SmplManagementClient): Promise<void> {
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
