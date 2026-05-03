/**
 * Demonstrates the smplkit runtime SDK for Smpl Logging.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/logging_runtime_showcase.ts
 */

import { SmplClient } from "../src/index.js";

async function main(): Promise<void> {
  // create the client (TypeScript has a single Promise-based client)
  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  try {
    await client.logging.install();
    console.log("All loggers are now controlled by smplkit");
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
