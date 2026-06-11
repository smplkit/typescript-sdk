/** Setup / cleanup helpers for `logging_management_showcase.ts`. */

import { SmplClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_LOGGER_IDS = ["showcase", "showcase.db", "showcase.payments"];

export async function setupManagementShowcase(client: SmplClient): Promise<void> {
  await cleanupManagementShowcase(client);
}

export async function cleanupManagementShowcase(client: SmplClient): Promise<void> {
  for (const loggerId of DEMO_LOGGER_IDS) {
    try {
      await client.logging.loggers.delete(loggerId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
