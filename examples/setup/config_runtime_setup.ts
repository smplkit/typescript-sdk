/** Setup and simulation helpers for `config_runtime_showcase.ts`.
 *
 * The runtime showcase declares its own configs via `client.config.bind()`,
 * so this helper only handles cleanup and the live admin-override
 * simulation that stands in for an operator editing values in the smplkit
 * console.
 */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_CONFIG_IDS = [
  "showcase-billing",
  "showcase-common",
  "showcase-database",
];

export async function simulateAdminOverride(manage: SmplManagementClient): Promise<void> {
  // Real customers never read back through the management API immediately
  // after binding via the runtime client — this is a simulation-only step.
  // Push pending runtime-side registrations through so the lookup below
  // can find the freshly-declared config.
  await manage.config.flush();
  const billing = await manage.config.get("showcase-billing");
  billing.setNumber("max_seats", 25, { environment: "production" });
  await billing.save();
}

export async function cleanupRuntimeShowcase(manage: SmplManagementClient): Promise<void> {
  for (const configId of DEMO_CONFIG_IDS) {
    try {
      await manage.config.delete(configId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
