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

import { SmplManagementClient, LogLevel } from "../src/index.js";
import {
  cleanupManagementShowcase,
  setupManagementShowcase,
} from "./setup/logging_management_setup.js";

async function main(): Promise<void> {
  // create the client (TypeScript has a single Promise-based client)
  const manage = new SmplManagementClient();
  try {
    await setupManagementShowcase(manage);

    // create a parent logger with a default level
    const root = manage.loggers.new("showcase");
    root.setLevel(LogLevel.INFO);
    await root.save();
    console.log(`Created: ${root.id} (level=${root.level})`);
    assert.equal(root.level, LogLevel.INFO);

    // child logger with no level (inherits from parent)
    const db = manage.loggers.new("showcase.db");
    await db.save();
    console.log(`Created: ${db.id} (inherits)`);
    assert.equal(db.level, null);

    // child logger with explicit level (overrides parent)
    const payments = manage.loggers.new("showcase.payments");
    payments.setLevel(LogLevel.WARN);
    await payments.save();
    console.log(`Created: ${payments.id} (level=${payments.level})`);
    assert.equal(payments.level, LogLevel.WARN);

    // override log level for different environments
    root.setLevel(LogLevel.ERROR, { environment: "production" });
    root.setLevel(LogLevel.DEBUG, { environment: "staging" });
    await root.save();
    console.log(`Set environment overrides: ${JSON.stringify(root.environments)}`);
    assert.equal(root.environments["production"]?.level, LogLevel.ERROR);
    assert.equal(root.environments["staging"]?.level, LogLevel.DEBUG);

    // clear environment override (inherits from the default level again)
    root.clearLevel({ environment: "staging" });
    await root.save();
    console.log(`Cleared staging override: ${JSON.stringify(root.environments)}`);
    assert.equal("staging" in root.environments, false);
    assert.equal(root.environments["production"]?.level, LogLevel.ERROR);

    // fetch a logger by id
    const fetched = await manage.loggers.get("showcase");
    assert.equal(fetched.level, LogLevel.INFO);

    await cleanupManagementShowcase(manage);
    console.log("Done!");
  } finally {
    await manage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
