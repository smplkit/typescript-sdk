/**
 * Demonstrates the smplkit management SDK for Smpl Logging.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/logging_management_showcase.ts
 */

import { strict as assert } from "node:assert";

import { SmplClient, LogLevel } from "../src/index.js";
import {
  cleanupManagementShowcase,
  setupManagementShowcase,
} from "./setup/logging_management_setup.js";

async function main(): Promise<void> {
  // TypeScript has a single Promise-based client
  const client = new SmplClient();
  try {
    await setupManagementShowcase(client);

    // create a parent logger with a default level
    const root = client.logging.loggers.new("showcase");
    root.setLevel(LogLevel.INFO);
    await root.save();
    console.log(`Created: ${root.id} (level=${root.level})`);
    assert.equal(root.level, LogLevel.INFO);

    // child logger with no level (inherits from parent)
    const db = client.logging.loggers.new("showcase.db");
    await db.save();
    console.log(`Created: ${db.id} (inherits)`);
    assert.equal(db.level, null);

    // child logger with explicit level (overrides parent)
    const payments = client.logging.loggers.new("showcase.payments");
    payments.setLevel(LogLevel.WARN);
    await payments.save();
    console.log(`Created: ${payments.id} (level=${payments.level})`);
    assert.equal(payments.level, LogLevel.WARN);

    // override log level for the production environment
    root.setLevel(LogLevel.ERROR, { environment: "production" });
    await root.save();
    console.log(`Set environment overrides: ${JSON.stringify(root.environments)}`);
    assert.equal(root.environments["production"]?.level, LogLevel.ERROR);

    // clear environment override (inherits from the default level again)
    root.clearLevel({ environment: "production" });
    await root.save();
    console.log(`Cleared production override: ${JSON.stringify(root.environments)}`);
    assert.equal("production" in root.environments, false);

    // get a logger
    const fetched = await client.logging.loggers.get("showcase");
    assert.equal(fetched.level, LogLevel.INFO);

    await cleanupManagementShowcase(client);
    console.log("Done!");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
