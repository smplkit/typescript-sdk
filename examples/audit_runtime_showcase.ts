/**
 * Demonstrates the smplkit runtime SDK for Smpl Audit.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/audit_runtime_showcase.ts
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { SmplClient } from "../src/index.js";

async function main(): Promise<void> {

  // create the client
  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  try {

    // record an event
    const someResourceId = `showcase-${randomUUID().slice(0, 8)}`;
    client.audit.events.record({
      action: "invoice.created",
      resourceType: "invoice",
      resourceId: someResourceId,
      occurredAt: new Date(),
      snapshot: { total_cents: 4900, currency: "USD" },
      data: { request_id: "req-abc" },
    });

    // force the event to be posted (normally happens automatically, in the
    // background, but we want to force it to be written now for this demo)
    await client.audit.events.flush(200);

    // list events
    const page = await client.audit.events.list({
      resourceType: "invoice",
      resourceId: someResourceId,
      pageSize: 10,
    });
    console.log(`Found ${page.events.length} events for ${someResourceId}:`);
    for (const event of page.events) {
      console.log(`  ${event.action}  id=${event.id}  actor=${event.actorType}`);
    }

    assert.equal(
      page.events.length,
      1,
      `Expected 1 event, got ${page.events.length}`,
    );

    // fetch an event by ID
    const first = await client.audit.events.get(page.events[0]!.id);
    console.log(`Round-tripped: ${first.action} at ${first.occurredAt}`);

    console.log("Done!");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
