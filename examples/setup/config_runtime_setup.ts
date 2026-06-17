/** Setup and simulation helpers for `config_runtime_showcase.ts`. */

import { SmplClient, SmplkitNotFoundError } from "../../src/index.js";

// Complete, dependency-ordered list of every config the config showcases
// create. Children are listed before the shared `showcase-common` parent so
// cleanup never trips the "config referenced as parent" conflict — even when
// a prior run crashed mid-way and left a sibling showcase's child orphaned.
const DEMO_CONFIG_IDS = [
  "showcase-billing", // child of showcase-common (runtime showcase)
  "showcase-user-service", // child of showcase-common (management showcase)
  "showcase-database", // root (runtime showcase)
  "showcase-common", // shared parent — must be deleted last
];

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
