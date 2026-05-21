/**
 * Demonstrates the smplkit runtime SDK for Smpl Config.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/config_runtime_showcase.ts
 */

import { strict as assert } from "node:assert";

import { SmplClient } from "../src/index.js";
import type { ConfigChangeEvent } from "../src/index.js";
import {
  cleanupRuntimeShowcase,
  setupRuntimeShowcase,
  simulateAdminOverride,
} from "./setup/config_runtime_setup.js";

async function main(): Promise<void> {

  // create the client
  const client = new SmplClient({
    environment: "production",
    service: "showcase-billing",
  });
  try {
    await setupRuntimeShowcase(client.manage);

    // declare a common/shared configuration
    const common = await client.config.getOrCreate("showcase-common", {
      description: "Shared defaults for showcase services.",
    });

    // declare a configuration that inherits from some parent
    const billing = await client.config.getOrCreate("showcase-billing", {
      parent: common,
      description: "Plan-limit configuration discovered from code.",
    });

    // get a configured value
    const appName = common.getString("app.name", "Acme SaaS");
    const supportEmail = common.getString("support.email", "support@acme.dev");
    const maxSeats = billing.getInt("plan.max_seats", 5, {
      description: "Maximum seats per organization.",
    });
    const trialDays = billing.getInt("plan.trial_days", 14);
    const tier = billing.getString("plan.tier", "free");

    console.log(`app.name = ${appName}`);
    console.log(`support.email = ${supportEmail}`);
    console.log(`plan.max_seats = ${maxSeats}`);
    console.log(`plan.trial_days = ${trialDays}`);
    console.log(`plan.tier = ${tier}`);

    // listen for changes
    const changes: ConfigChangeEvent[] = [];

    billing.onChange("plan.max_seats", (event) => {
      changes.push(event);
      console.log(
        `    [CHANGE] ${event.configId}.${event.itemKey}: ` +
          `${JSON.stringify(event.oldValue)} -> ${JSON.stringify(event.newValue)}`,
      );
    });

    // simulate someone overriding a value in the console
    await simulateAdminOverride(client.manage);

    // wait for the WebSocket push to deliver the change
    await new Promise((resolve) => setTimeout(resolve, 400));

    // get the latest value
    const updatedSeats = billing.getInt("plan.max_seats", 5);
    console.log(`plan.max_seats after override = ${updatedSeats}`);
    assert.equal(updatedSeats, 25, `Expected 25, got ${updatedSeats}`);
    assert.ok(changes.length >= 1, "Expected at least one change event");

    await cleanupRuntimeShowcase(client.manage);
    console.log("Done!");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
