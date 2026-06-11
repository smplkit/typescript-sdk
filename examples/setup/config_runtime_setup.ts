/** Setup and simulation helpers for `config_runtime_showcase.ts`. */

import { SmplClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_CONFIG_IDS = ["showcase-billing", "showcase-common", "showcase-database"];

export async function simulateAdminOverride(client: SmplClient): Promise<void> {
  await client.config.flush();
  const billing = await client.config.get("showcase-billing");
  billing.setNumber("plan.max_seats", 25, { environment: "production" });
  await billing.save();
}

export async function cleanupRuntimeShowcase(client: SmplClient): Promise<void> {
  for (const configId of DEMO_CONFIG_IDS) {
    try {
      await client.config.delete(configId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
