/**
 * Demonstrates the smplkit runtime SDK for Smpl Config.
 *
 * Headline pattern: declare configurations as TypeScript object literals,
 * `bind()` them to a config id, then use the returned objects directly —
 * property access stays in sync with the server via the SDK's in-memory
 * cache and WebSocket push.
 *
 * Also demonstrates three lower-friction patterns:
 *   - `bind` with an untyped plain object
 *   - `get(id)` for dict-like lookup of an entire config
 *   - `get(id, key, default)` for one-shot value reads with fallback
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
  simulateAdminOverride,
} from "./setup/config_runtime_setup.js";

async function main(): Promise<void> {
  // create the client
  const client = new SmplClient({
    environment: "production",
    service: "showcase-billing",
  });
  try {
    await cleanupRuntimeShowcase(client.manage);

    // bind a typed object literal (TypeScript infers the shape)
    const common = await client.config.bind("showcase-common", {
      app_name: "Acme SaaS",
      support_email: "support@acme.dev",
    });

    // bind a child config — omitted keys inherit from common at the server
    // level. (Only keys present in the literal are reachable as TypeScript
    // properties on the returned object; to read inherited fields locally,
    // use client.config.get("showcase-billing").)
    const billing = await client.config.bind(
      "showcase-billing",
      {
        max_seats: 5,
        trial_days: 14,
        tier: "free",
      },
      { parent: common },
    );

    console.log(`common.app_name = ${common.app_name}`);
    console.log(`billing.max_seats = ${billing.max_seats}`);
    console.log(`billing.tier = ${billing.tier}`);
    assert.equal(common.app_name, "Acme SaaS");
    assert.equal(billing.max_seats, 5);

    // add listeners if desired
    const changes: ConfigChangeEvent[] = [];

    client.config.onChange("showcase-billing", "max_seats", (event) => {
      changes.push(event);
      console.log(
        `    [CHANGE] ${event.configId}.${event.itemKey}: ` +
          `${JSON.stringify(event.oldValue)} -> ${JSON.stringify(event.newValue)}`,
      );
    });

    // simulate someone making a change in smplkit console
    await simulateAdminOverride(client.manage);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // observe changes are automatically reflected in bound objects
    console.log(`billing.max_seats after override = ${billing.max_seats}`);
    assert.equal(billing.max_seats, 25);
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

    // or get a config by ID (raises if not found; pass a default if you
    // want a fallback)
    const commonView = await client.config.get("showcase-common");
    console.log("showcase-common (via get):");
    for (const [k, v] of commonView.items()) {
      console.log(`    ${k} = ${v}`);
    }
    assert.equal(commonView["app_name"], "Acme SaaS");

    // or skip the object/dict and just fetch specific keys directly
    const slowQueryMs = await client.config.get(
      "showcase-database",
      "slow_query_threshold_ms",
      500,
    );
    console.log(
      `showcase-database.slow_query_threshold_ms = ${slowQueryMs}  ` +
        `// default used; now registered for visibility`,
    );
    assert.equal(slowQueryMs, 500);

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
