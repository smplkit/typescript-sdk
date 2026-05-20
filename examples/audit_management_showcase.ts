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
import {
  ForwarderType,
  HttpConfiguration,
  HttpMethod,
  TransformType,
} from "../src/audit/index.js";

// JSON Logic filter — only forward `invoice.*` event types.
// Events that don't match are recorded as `filtered_out` deliveries.
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
  // create the client (use SmplManagementClient for management operations)
  const manage = new SmplManagementClient();
  try {
    const forwarderName = `showcase-${randomUUID().slice(0, 6)}`;

    // create a new forwarder
    const forwarder = manage.audit.forwarders.new({
      name: forwarderName,
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({
        method: HttpMethod.POST,
        url: "https://httpbin.org/post",
        headers: [{ name: "X-Showcase", value: "ok" }],
      }),
      filter: INVOICE_FILTER,
      transformType: TransformType.JSONATA,
      transform: SIEM_TRANSFORM,
    });
    await forwarder.save();
    console.log(`Created forwarder: ${forwarder.name} (id=${forwarder.id})`);

    // list forwarders
    const listed = await manage.audit.forwarders.list();
    assert(listed.forwarders.some((f) => f.id === forwarder.id));
    console.log(`Account has ${listed.forwarders.length} forwarder(s)`);

    // get a forwarder
    const fetched = await manage.audit.forwarders.get(forwarder.id!);
    assert.equal(fetched.id, forwarder.id);
    assert.equal(fetched.enabled, true);
    console.log(`Fetched forwarder: ${fetched.name}`);

    // update a forwarder
    fetched.enabled = false;
    await fetched.save();
    assert.equal(fetched.enabled, false);
    console.log(`Disabled forwarder: ${fetched.name} (enabled=${fetched.enabled})`);

    // delete a forwarder
    await fetched.delete();
    const remaining = await manage.audit.forwarders.list();
    assert(!remaining.forwarders.some((f) => f.id === forwarder.id));
    console.log(`Deleted forwarder: ${fetched.name}`);

    console.log("Done!");
  } finally {
    await manage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
