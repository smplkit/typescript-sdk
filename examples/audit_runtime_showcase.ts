/**
 * Demonstrates the smplkit runtime SDK for Smpl Audit.
 *
 * Covers: event record / list / get, plus the SIEM forwarders surface
 * (create / list / delete + the test_forwarder/execute proxy + a
 * doNotForward event flow).
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *   - The Pro tier is required for the forwarders portion. The
 *     showcase gracefully skips those steps on a 402 (free / standard
 *     tier) so it stays runnable in any environment.
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
      data: {
        snapshot: { total_cents: 4900, currency: "USD" },
        request_id: "req-abc",
      },
    });

    // force the event to be posted (normally happens automatically, in the
    // background, but we want to force it to be written now for this demo)
    await client.audit.events.flush(2000);

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

    assert.equal(page.events.length, 1, `Expected 1 event, got ${page.events.length}`);

    // fetch an event by ID
    const first = await client.audit.events.get(page.events[0]!.id);
    console.log(`Round-tripped: ${first.action} at ${first.occurredAt}`);

    // ----------------------------------------------------------------
    // Forwarders (Pro tier — gracefully skip on 402)
    // ----------------------------------------------------------------
    let fwdId: string | null = null;
    try {
      const fwd = await client.audit.forwarders.create({
        name: `showcase-${randomUUID().slice(0, 6)}`,
        forwarderType: "http",
        http: {
          method: "POST",
          url: "https://httpbin.org/post",
          headers: [{ name: "X-Showcase", value: "ok" }],
          body: null,
          successStatus: "2xx",
        },
      });
      fwdId = fwd.id;
      console.log(`Created forwarder: ${fwd.slug}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("402")) {
        console.log("Skipping forwarder showcase — account is not Pro tier");
        console.log("Done!");
        return;
      }
      throw err;
    }

    try {
      // doNotForward suppresses the forward but still records the
      // skip in the delivery log.
      client.audit.events.record({
        action: "invoice.created",
        resourceType: "invoice",
        resourceId: `${someResourceId}-skipped`,
        doNotForward: true,
      });
      await client.audit.events.flush(2000);

      // Test the destination via the proxy.
      const test = await client.audit.functions.test_forwarder.actions.execute({
        url: "https://httpbin.org/post",
        body: '{"hello":"world"}',
        successStatus: "2xx",
        timeoutMs: 5000,
      });
      console.log(
        `test_forwarder: succeeded=${test.succeeded} status=${test.responseStatus}`,
      );

      const listed = await client.audit.forwarders.list({ pageSize: 5 });
      console.log(`Account has ${listed.forwarders.length} active forwarders`);
    } finally {
      if (fwdId !== null) {
        await client.audit.forwarders.delete(fwdId);
        console.log(`Deleted forwarder ${fwdId}`);
      }
    }

    console.log("Done!");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
