/** Setup, simulation, and cleanup helpers for `config_runtime_showcase.ts`.
 *
 * The runtime showcase is intentionally runtime-only — declarations,
 * typed getters, change listeners. In a real deployment the configs
 * would either already exist (admin-curated) or be created by the
 * SDK's discovery on first run. Here we pre-create them through the
 * management API so the showcase can also demonstrate a live admin
 * override end-to-end in a single process.
 */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_CONFIG_IDS = ["showcase-billing", "showcase-common"];

export async function setupRuntimeShowcase(manage: SmplManagementClient): Promise<void> {
  await cleanupRuntimeShowcase(manage);

  const common = manage.config.new("showcase-common", {
    description: "Shared defaults for showcase services.",
  });
  common.setString("app.name", "Acme SaaS");
  common.setString("support.email", "support@acme.dev");
  await common.save();

  const billing = manage.config.new("showcase-billing", {
    description: "Plan-limit configuration for billing.",
    parent: "showcase-common",
  });
  billing.setNumber("plan.max_seats", 5, { description: "Maximum seats per organization." });
  billing.setNumber("plan.trial_days", 14);
  billing.setString("plan.tier", "free");
  await billing.save();
}

export async function simulateAdminOverride(manage: SmplManagementClient): Promise<void> {
  const billing = await manage.config.get("showcase-billing");
  billing.setNumber("plan.max_seats", 25, { environment: "production" });
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
