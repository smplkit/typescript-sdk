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
  // create the client (use SmplClient for synchronous use)
  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  try {
    const someResourceId = `showcase-${randomUUID().slice(0, 8)}`;

    // record an event
    client.audit.events.record({
      action: "invoice.created",
      resourceType: "invoice",
      resourceId: someResourceId,
      occurredAt: new Date(),
      data: {
        snapshot: { total_cents: 4900, currency: "USD" },
        request_id: "req-abc",
      },
      // or omit to have events flushed asynchronously
    });
    await client.audit.events.flush(2000);
    console.log(`Recorded events for invoice ${someResourceId}`);

    // list events
    const page = await client.audit.events.list({
      resourceType: "invoice",
      resourceId: someResourceId,
    });
    assert(
      page.events.some((e) => e.resourceId === someResourceId),
      `Expected event with resourceId ${someResourceId} in list`,
    );
    const recordedEventId = page.events[0]!.id;
    console.log(`Listed ${page.events.length} event(s) for invoice ${someResourceId}`);

    // fetch an event
    const event = await client.audit.events.get(recordedEventId);
    assert.equal(event.id, recordedEventId);
    assert.equal(event.resourceId, someResourceId);
    assert.equal(event.action, "invoice.created");
    console.log(`Fetched event ${event.id}: ${event.action}`);

    // list resource types observed
    const resourceTypesPage = await client.audit.resourceTypes.list();
    assert(
      resourceTypesPage.resourceTypes.some((rt) => rt.id === "invoice"),
      `Expected "invoice" in resource types`,
    );
    console.log(
      `Observed resource types: ${resourceTypesPage.resourceTypes.map((rt) => rt.id).join(", ")}`,
    );

    // list actions observed
    const actionsPage = await client.audit.actions.list();
    assert(
      actionsPage.actions.some((a) => a.id === "invoice.created"),
      `Expected "invoice.created" in actions`,
    );
    console.log(`Observed actions: ${actionsPage.actions.map((a) => a.id).join(", ")}`);

    console.log("Done!");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
