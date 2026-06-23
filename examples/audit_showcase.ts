/**
 * Demonstrates the smplkit SDK for Smpl Audit.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/audit_showcase.ts
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import {
  SmplClient,
  SmplNotFoundError,
  ForwarderType,
  HttpConfiguration,
  AuditHttpMethod,
  TransformType,
} from "../src/index.js";

// JSON Logic filter — only forward `invoice.*` event types. Events that don't
// match the filter aren't forwarded (and produce no delivery record).
// See https://jsonlogic.com for the full operator reference.
const INVOICE_FILTER = { in: ["invoice.", { var: "event_type" }] };

// JSONata template — reshape the event payload before POSTing to the
// destination. This example flattens the event into a compact SIEM-style
// record. See https://jsonata.org for the full language reference.
const SIEM_TRANSFORM = `
{
    "event": event_type,
    "subject": resource_type & ":" & resource_id,
    "ts": occurred_at,
    "actor": actor_label
}
`;

async function main(): Promise<void> {
  // TypeScript has a single Promise-based client
  const client = new SmplClient({ environment: "production" });
  const audit = client.audit;
  const someResourceId = `showcase-${randomUUID().slice(0, 8)}`;

  // forwarder id is referenced in the finally teardown below
  const forwarderId = `showcase-${randomUUID().slice(0, 6)}`;

  try {
    // ----- Events: record / list / get --------------------------------

    // record an event
    await audit.events.record({
      actorId: "billing-bot:42",
      actorLabel: "finance@example.com",
      actorType: "USER",
      category: "billing",
      data: {
        snapshot: { total_cents: 4900, currency: "USD" },
        request_id: "req-abc",
      },
      eventType: "invoice.created",
      flush: true, // or omit to have events flushed asynchronously
      occurredAt: new Date(),
      resourceId: someResourceId,
      resourceType: "invoice",
    });
    console.log(`Recorded event for invoice ${someResourceId}`);

    // list events
    const page = await audit.events.list({
      resourceType: "invoice",
      resourceId: someResourceId,
    });
    assert(page.events.some((e) => e.resourceId === someResourceId));
    const recordedEventId = page.events[0]!.id;
    console.log(`Listed ${page.events.length} event(s) for invoice ${someResourceId}`);

    // fetch an event
    const event = await audit.events.get(recordedEventId);
    assert.equal(event.id, recordedEventId);
    assert.equal(event.resourceId, someResourceId);
    assert.equal(event.eventType, "invoice.created");
    assert.equal(event.actorId, "billing-bot:42");
    assert.equal(event.actorLabel, "finance@example.com");
    assert.equal(event.category, "billing");
    console.log(
      `Fetched event ${event.id}: ${event.eventType} ` +
        `by ${event.actorLabel} in ${event.environment}`,
    );

    // ----- Discovery: distinct resource_types / event_types / categories

    const resourceTypes = await audit.resourceTypes.list();
    assert(resourceTypes.resourceTypes.some((rt) => rt.id === "invoice"));
    console.log(
      `Observed resource types: ${JSON.stringify(resourceTypes.resourceTypes.map((rt) => rt.id))}`,
    );

    const eventTypes = await audit.eventTypes.list();
    assert(eventTypes.eventTypes.some((et) => et.id === "invoice.created"));
    console.log(
      `Observed event types: ${JSON.stringify(eventTypes.eventTypes.map((et) => et.id))}`,
    );

    const categories = await audit.categories.list();
    assert(categories.categories.some((c) => c.id === "billing"));
    console.log(`Observed categories: ${JSON.stringify(categories.categories.map((c) => c.id))}`);

    // ----- Forwarders: SIEM streaming CRUD ----------------------------

    // create a forwarder (disabled by default)
    let forwarder = audit.forwarders.new(forwarderId, {
      configuration: new HttpConfiguration({
        headers: { "X-Showcase": "ok" },
        method: AuditHttpMethod.POST,
        url: "https://example.com",
      }),
      filter: INVOICE_FILTER,
      forwarderType: ForwarderType.HTTP,
      transform: SIEM_TRANSFORM,
      transformType: TransformType.JSONATA,
    });
    await forwarder.save();
    console.log(`Created forwarder: ${forwarder.name} (id=${forwarder.id})`);

    // list forwarders
    const listed = await audit.forwarders.list();
    assert(listed.forwarders.some((f) => f.id === forwarder.id));
    console.log(`Account has ${listed.forwarders.length} forwarder(s)`);

    // get a forwarder
    forwarder = await client.audit.forwarders.get(forwarderId);
    console.log(`Fetched forwarder: ${forwarder.name} (id=${forwarder.id})`);
    assert.equal(forwarder.id, forwarderId);

    // configure where to forward events in production
    forwarder.environment("production").url = "https://httpbin.org/post";
    forwarder.environment("production").setHeader("X-Showcase", "ok");
    await forwarder.save();
    assert.equal(forwarder.environments["production"]?.url, "https://httpbin.org/post");
    console.log(`Updated forwarder: ${forwarder.name}`);

    // start forwarding events in production
    forwarder.environment("production").enabled = true;
    await forwarder.save();
    console.log(
      `Enabled forwarder ${forwarder.name} (id=${forwarder.id}) ` +
        "to start forwarding events in production",
    );

    // delete a forwarder
    await forwarder.delete();
    const remaining = await audit.forwarders.list();
    assert(!remaining.forwarders.some((f) => f.id === forwarderId));
    console.log(`Deleted forwarder: ${forwarder.name}`);

    console.log("Done!");
  } finally {
    // tear-down: never leave the showcase forwarder behind, even on failure
    try {
      await audit.forwarders.delete(forwarderId);
    } catch (err) {
      if (!(err instanceof SmplNotFoundError)) throw err;
    }
    client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
