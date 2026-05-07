/**
 * Demonstrates the smplkit runtime SDK for Smpl Audit.
 *
 * Audit is a fire-and-forget event-recording surface. `create` enqueues
 * the event onto an in-memory bounded buffer and returns immediately;
 * the buffer worker retries with exponential backoff on transient
 * failures and drops oldest under back-pressure (ADR-047 §2.6).
 * Reads (`get`, `list`) are async and synchronous on the wire.
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
  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  try {
    // unique resource id so we can find back exactly the events this
    // showcase wrote, regardless of what other history exists.
    const resourceId = `showcase-${randomUUID().slice(0, 8)}`;

    // 1) fire-and-forget create — returns immediately. The actual POST
    //    happens on the buffer worker. Customer events must NOT use a
    //    resource_type beginning with "smpl." (reserved for smplkit-
    //    emitted events; the server returns 403).
    client.audit.events.create({
      action: "invoice.created",
      resourceType: "invoice",
      resourceId,
      occurredAt: new Date(),
      snapshot: { total_cents: 4900, currency: "USD" },
      data: { request_id: "req-abc" },
    });

    // 2) caller-supplied idempotency key — replaying with the same key
    //    returns the original event (server dedupes on
    //    account_id + idempotency_key).
    const idempotencyKey = `showcase-${randomUUID()}`;
    client.audit.events.create({
      action: "invoice.updated",
      resourceType: "invoice",
      resourceId,
      snapshot: { total_cents: 5400 },
      idempotencyKey,
    });
    // safe replay — same key, same event id server-side.
    client.audit.events.create({
      action: "invoice.updated",
      resourceType: "invoice",
      resourceId,
      snapshot: { total_cents: 5400 },
      idempotencyKey,
    });

    // 3) flush — block until the in-memory buffer drains so that the
    //    events we just wrote are durable before we read them.
    await client.audit.events.flush(5_000);

    // 4) list — server-side filters per ADR-047 §4.  Cursor pagination
    //    via pageSize / pageAfter; page.nextCursor is non-null when
    //    more pages exist.
    const page = await client.audit.events.list({
      resourceType: "invoice",
      resourceId,
      pageSize: 10,
    });
    console.log(`Found ${page.events.length} events for ${resourceId}:`);
    for (const event of page.events) {
      console.log(`  ${event.action}  id=${event.id}  actor=${event.actorType}`);
    }

    // idempotency dedupe check — 3 creates (1 distinct + 2 with the
    // same idempotency key) so we expect exactly 2 events.
    assert.equal(
      page.events.length,
      2,
      `Expected 2 events (idempotency dedup), got ${page.events.length}`,
    );

    // 5) get — read a single event by id.
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
