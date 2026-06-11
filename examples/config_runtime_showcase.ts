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
import { setTimeout as sleep } from "node:timers/promises";

import { SmplClient } from "../src/index.js";
import type { ConfigChangeEvent } from "../src/index.js";
import { cleanupRuntimeShowcase, simulateAdminOverride } from "./setup/config_runtime_setup.js";

// Example object-literal shapes to showcase how "code-first" configuration
// management works. Nested objects flatten to dotted item keys
// (`app.name`, `plan.max_seats`, ...).
const common = {
  app: { name: "Acme SaaS" },
  support: { email: "support@acme.dev" },
};

const billing = {
  app: { name: "Acme SaaS" },
  support: { email: "support@acme.dev" },
  plan: { max_seats: 5, trial_days: 14, tier: "free" },
};

async function main(): Promise<void> {
  // create the client
  const client = new SmplClient({ environment: "production" });
  try {
    await cleanupRuntimeShowcase(client);

    // bind object literals
    const commonCfg = await client.config.bind("showcase-common", common);
    const billingCfg = await client.config.bind("showcase-billing", billing, {
      parent: commonCfg,
    });
    console.log(`common.app.name = ${commonCfg.app.name}`);
    console.log(`billing.app.name = ${billingCfg.app.name}  // inherited from common`);
    console.log(`billing.plan.max_seats = ${billingCfg.plan.max_seats}`);

    // add listeners if desired
    const changes: ConfigChangeEvent[] = [];

    client.config.onChange("showcase-billing", "plan.max_seats", (event) => {
      changes.push(event);
      console.log(
        `    [CHANGE] ${event.configId}.${event.itemKey}: ` +
          `${JSON.stringify(event.oldValue)} -> ${JSON.stringify(event.newValue)}`,
      );
    });

    await client.waitUntilReady();

    // simulate someone making a change in smplkit console
    await simulateAdminOverride(client);
    await sleep(400);

    // observe changes are automatically reflected in bound objects
    console.log(`billing.plan.max_seats after override = ${billingCfg.plan.max_seats}`);
    assert.equal(billingCfg.plan.max_seats, 25, `Expected 25, got ${billingCfg.plan.max_seats}`);
    assert.ok(changes.length >= 1);

    // you can also bind plain-old dictionaries
    const db = await client.config.bind("showcase-database", {
      primary: { host: "db.acme.example", port: 5432 },
      pool_size: 10,
      statement_timeout_ms: 30000,
    });
    console.log(`db.primary.host = ${db.primary.host}`);
    console.log(`db.pool_size = ${db.pool_size}`);
    assert.equal(db.primary.host, "db.acme.example");
    assert.equal(db.pool_size, 10);

    // or read live values via subscribe(id)
    const commonView = await client.config.subscribe("showcase-common");
    console.log("showcase-common (via subscribe):");
    for (const [k, v] of commonView.items()) {
      console.log(`    ${k} = ${v}`);
    }
    assert.equal(commonView.get("app.name"), "Acme SaaS");

    // or skip the model/dict and just fetch specific keys directly
    const slowQueryMs = await client.config.getValue(
      "showcase-database",
      "slow_query_threshold_ms",
      500,
    );
    console.log(
      `showcase-database.slow_query_threshold_ms = ${slowQueryMs}  ` +
        `// default used (key absent)`,
    );
    assert.equal(slowQueryMs, 500);

    await cleanupRuntimeShowcase(client);
    console.log("Done!");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
