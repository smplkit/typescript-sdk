/**
 * Demonstrates the smplkit runtime SDK for Smpl Flags.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/flags_runtime_showcase.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

import { SmplClient, Context, Op, Rule } from "../src/index.js";
import { cleanupRuntimeShowcase, setupRuntimeShowcase } from "./setup/flags_runtime_setup.js";

// ---------------------------------------------------------------------------
// Note: this showcase calls client.setContext(...) inline to demonstrate
// context-driven flag evaluation.  In a real app (Express, Fastify, etc.),
// setContext is called once per request from middleware — not scattered
// through your handlers.
// ---------------------------------------------------------------------------

const alice = {
  beta_tester: true,
  email: "alice.adams@acme.com",
  first_name: "Alice",
  last_name: "Adams",
  plan: "enterprise",
};

const bob = {
  beta_tester: false,
  email: "bob.jones@acme.com",
  first_name: "Bob",
  last_name: "Jones",
  plan: "free",
};

const largeTechnologyAccount = {
  employee_count: 500,
  id: 1234,
  industry: "technology",
  region: "us",
};

const smallRetailAccount = {
  employee_count: 10,
  id: 5678,
  industry: "retail",
  region: "eu",
};

function createContext(user: any, account: any): Context[] {
  // Create context within which flags will be evaluated.
  return [
    new Context("user", user.email, {
      beta_tester: user.beta_tester,
      first_name: user.first_name,
      last_name: user.last_name,
      plan: user.plan,
    }),
    new Context("account", String(account.id), {
      industry: account.industry,
      region: account.region,
      employee_count: account.employee_count,
    }),
  ];
}

async function main(): Promise<void> {
  // create the client (TypeScript has a single Promise-based client)
  const client = new SmplClient({
    environment: "staging",
    service: "showcase-service",
  });
  try {
    await setupRuntimeShowcase(client.manage);
    await client.flags.initialize();

    // declare flags - default values will be used if the flag does not
    // exist or smplkit is unreachable
    const checkoutV2 = client.flags.booleanFlag("checkout-v2", false);
    const bannerColor = client.flags.stringFlag("banner-color", "red");
    const maxRetries = client.flags.numberFlag("max-retries", 3);

    const allChanges: Array<{ id: string; source: string }> = [];
    const bannerChanges: any[] = [];

    // global listener — fires when ANY flag definition changes
    client.flags.onChange((event) => {
      allChanges.push({ id: event.id, source: event.source });
      console.log(`    Global flag listener: '${event.id}' updated via ${event.source}`);
    });

    // flag listener — fires only when a specific flag changes
    client.flags.onChange("banner-color", (event) => {
      bannerChanges.push(event);
      console.log("    banner-color flag changed!");
    });

    // request 1 — Alice from a large tech account
    {
      client.flags.setContextProvider(() => createContext(alice, largeTechnologyAccount));
      const checkoutResult = checkoutV2.get();
      console.log(`checkout-v2 = ${checkoutResult}`);
      assert.equal(checkoutResult, true);

      const bannerResult = bannerColor.get();
      console.log(`banner-color = ${bannerResult}`);
      assert.equal(bannerResult, "blue");

      const retriesResult = maxRetries.get();
      console.log(`max-retries = ${retriesResult}`);
      assert.equal(retriesResult, 5);
    }

    // request 2 — Bob from a small retail account
    {
      client.flags.setContextProvider(() => createContext(bob, smallRetailAccount));
      const checkoutResult2 = checkoutV2.get();
      console.log(`checkout-v2 = ${checkoutResult2}`);
      assert.equal(checkoutResult2, false);

      const bannerResult2 = bannerColor.get();
      console.log(`banner-color = ${bannerResult2}`);
      assert.equal(bannerResult2, "red");

      const retriesResult2 = maxRetries.get();
      console.log(`max-retries = ${retriesResult2}`);
      assert.equal(retriesResult2, 3);
    }

    // get a flag's value (explicitly pass context)
    const explicitResult = checkoutV2.get({
      context: [
        new Context("user", "john.smith@acme.com", { plan: "free", beta_tester: false }),
        new Context("account", "1111", { region: "jp" }),
      ],
    });
    console.log(`checkout-v2 (free, JP) = ${explicitResult}`);
    assert.equal(explicitResult, false);

    // simulate someone making changes to a flag to trigger listeners
    await updateRules(client);

    // wait a moment for the event to be delivered
    await sleep(200);

    // verify both listeners fired
    assert.ok(
      allChanges.length >= 1,
      `Expected at least one global change, got ${allChanges.length}`,
    );
    assert.ok(
      bannerChanges.length >= 1,
      `Expected at least one banner change, got ${bannerChanges.length}`,
    );

    await cleanupRuntimeShowcase(client.manage);
    console.log("Done!");
  } finally {
    client.close();
  }
}

async function updateRules(client: SmplClient): Promise<void> {
  const currentBanner = await client.manage.flags.get("banner-color");
  currentBanner.addRule(
    new Rule("Red for small companies", { environment: "staging" })
      .when("account.employee_count", Op.LT, 50)
      .serve("red"),
  );
  await currentBanner.save();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
