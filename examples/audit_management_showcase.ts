/**
 * Demonstrates the smplkit management SDK for Smpl Audit.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/audit_management_showcase.ts
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { SmplManagementClient } from "../src/index.js";

// JSON Logic filter — only forward `invoice.*` actions.
// Events that don't match are recorded as `filtered_out` deliveries.
// See https://jsonlogic.com for the full operator reference.
const INVOICE_FILTER = { in: ["invoice.", { var: "action" }] };

// JSONata template — reshape the event payload before POSTing to the
// destination. This example flattens the event into a compact SIEM-style
// record. See https://jsonata.org for the full language reference.
const SIEM_TRANSFORM = `
{
    "event": action,
    "subject": resource_type & ":" & resource_id,
    "ts": occurred_at,
    "actor": actor_label
}
`;

async function main(): Promise<void> {
  // create the client (use SmplManagementClient for management operations)
  const manage = new SmplManagementClient();
  try {
    const forwarderName = `showcase-${randomUUID().slice(0, 6)}`;

    // create a forwarder
    const forwarder = await manage.audit.forwarders.create({
      name: forwarderName,
      description: "Showcase forwarder for the management SDK example.",
      forwarderType: "HTTP",
      configuration: {
        method: "POST",
        url: "https://httpbin.org/post",
        headers: [{ name: "X-Showcase", value: "ok" }],
        successStatus: "2xx",
      },
      filter: INVOICE_FILTER,
      transformType: "JSONATA",
      transform: SIEM_TRANSFORM,
    });
    assert.equal(forwarder.name, forwarderName);
    assert.equal(forwarder.enabled, true);
    assert.deepEqual(forwarder.filter, INVOICE_FILTER);
    assert.equal(forwarder.transformType, "JSONATA");
    assert.equal(forwarder.transform, SIEM_TRANSFORM);
    console.log(`Created forwarder: ${forwarder.id}`);

    // fetch a forwarder
    const fetched = await manage.audit.forwarders.get(forwarder.id);
    assert.equal(fetched.id, forwarder.id);
    assert.equal(fetched.name, forwarderName);
    assert.deepEqual(fetched.filter, INVOICE_FILTER);
    assert.equal(fetched.transform, SIEM_TRANSFORM);
    console.log(`Fetched forwarder: ${fetched.name}`);

    // list forwarders
    const listed = await manage.audit.forwarders.list();
    assert(
      listed.forwarders.some((f) => f.id === forwarder.id),
      `Expected forwarder ${forwarder.id} in list`,
    );
    console.log(`Account has ${listed.forwarders.length} forwarder(s)`);

    // update a forwarder (PUT — full replace, so every field is re-supplied)
    const renamed = `${forwarder.name}-renamed`;
    const updated = await manage.audit.forwarders.update(forwarder.id, {
      name: renamed,
      description: forwarder.description ?? undefined,
      forwarderType: forwarder.forwarderType,
      configuration: {
        method: "POST",
        url: "https://httpbin.org/post",
        headers: [{ name: "X-Showcase", value: "ok" }],
        successStatus: "2xx",
      },
      enabled: false,
      filter: INVOICE_FILTER,
      transformType: "JSONATA",
      transform: SIEM_TRANSFORM,
    });
    assert.equal(updated.name, renamed);
    assert.equal(updated.enabled, false);
    console.log(`Updated forwarder: ${updated.name} (enabled=${updated.enabled})`);

    // delete a forwarder
    await manage.audit.forwarders.delete(forwarder.id);
    const remaining = await manage.audit.forwarders.list();
    assert(
      !remaining.forwarders.some((f) => f.id === forwarder.id),
      `Expected forwarder ${forwarder.id} to be gone after delete`,
    );
    console.log(`Deleted forwarder: ${forwarder.id}`);

    console.log("Done!");
  } finally {
    await manage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
