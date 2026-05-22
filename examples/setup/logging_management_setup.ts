/** Setup / cleanup helpers for `logging_management_showcase.ts`. */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_LOGGER_IDS = ["showcase", "showcase.db", "showcase.payments"];

export async function setupManagementShowcase(manage: SmplManagementClient): Promise<void> {
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
