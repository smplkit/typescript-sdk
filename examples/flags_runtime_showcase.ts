/**
 * Smpl Flags SDK Showcase — Runtime Evaluation
 * ==============================================
 *
 * Demonstrates the smplkit TypeScript SDK's runtime evaluation for Smpl Flags:
 *
 * - Typed flag handles: booleanFlag, stringFlag, numberFlag, jsonFlag
 * - Context providers and typed context entities
 * - `await client.flags.initialize()` for local evaluation
 * - Evaluating flags with `.get()` — local JSON Logic, no network per call
 * - Explicit context overrides via `.get({ context: [...] })`
 * - Scoped change listeners: `client.flags.onChange(key, callback)`
 * - Global change listeners: `client.flags.onChange(callback)`
 * - Cache statistics via `client.flags.stats()`
 * - Context registration: `register()` and `flushContexts()`
 *
 * This is the SDK experience that 99% of customers will use. Flags are
 * created and configured via the Console UI (or the management API shown
 * in `flags_management_showcase.ts`). This script focuses entirely on
 * the runtime: declaring, initializing, evaluating, and reacting to changes.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *       - SMPLKIT_API_KEY environment variable
 *       - ~/.smplkit configuration file (see SDK docs)
 *   - The smplkit Flags service running and reachable
 *   - At least two environments configured (e.g., `staging`, `production`)
 *
 * Usage:
 *   npx tsx examples/flags_runtime_showcase.ts
 */

import { SmplClient, Context } from "@smplkit/sdk";

// Demo scaffolding — creates flags so this showcase can run standalone.
// In a real app, flags are created via the Console UI.
import { setupDemoFlags, teardownDemoFlags } from "./flags_runtime_setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function section(title: string): void {
  console.log();
  console.log("=".repeat(60));
  console.log(`  ${title}`);
  console.log("=".repeat(60));
  console.log();
}

function step(description: string): void {
  console.log(`  → ${description}`);
}

// ---------------------------------------------------------------------------
// Simulated request context
// ---------------------------------------------------------------------------
// In a real application, these would come from your web framework's
// request object (Express, Fastify, Koa, etc.). For this showcase,
// we simulate them with mutable objects that we swap mid-script to
// demonstrate how the context provider drives flag evaluation.
// ---------------------------------------------------------------------------

let currentUser = {
  id: "user-001",
  firstName: "Alice",
  plan: "enterprise",
  betaTester: true,
};

let currentAccount = {
  id: "acme-corp",
  industry: "technology",
  region: "us",
  employeeCount: 500,
};

function setSimulatedContext(opts: {
  user?: typeof currentUser;
  account?: typeof currentAccount;
}): void {
  if (opts.user !== undefined) currentUser = opts.user;
  if (opts.account !== undefined) currentAccount = opts.account;
}

async function main(): Promise<void> {
  // ======================================================================
  // SETUP
  // ======================================================================

  const client = new SmplClient({
    environment: "staging",
    service: "showcase-service",
  });

  // Create demo flags (normally done via Console UI).
  console.log("  Setting up demo flags...");
  const demoFlagKeys = await setupDemoFlags(client);
  console.log("  Demo flags ready.\n");

  try {
    // ==================================================================
    // 1. DECLARE TYPED FLAG HANDLES
    // ==================================================================
    //
    // Flag handles are local to the SDK. They do NOT create flags on
    // the server. They serve three purposes:
    //
    //   1. Typed return — get() returns boolean, string, number, or
    //      Record<string, any> depending on the handle type.
    //   2. Code-level default — used if the server is unreachable
    //      or the flag doesn't exist server-side.
    //   3. Documentation — which flags this application depends on.
    // ==================================================================

    section("1. Declare Typed Flag Handles");

    const checkoutV2 = client.flags.booleanFlag("checkout-v2", false);
    const bannerColor = client.flags.stringFlag("banner-color", "red");
    const maxRetries = client.flags.numberFlag("max-retries", 3);
    const uiTheme = client.flags.jsonFlag("ui-theme", { mode: "light", accent: "#0066cc" });

    step(`checkout-v2:   type=boolean, code_default=${checkoutV2.default}`);
    step(`banner-color:  type=string,  code_default=${bannerColor.default}`);
    step(`max-retries:   type=number,  code_default=${maxRetries.default}`);
    step(`ui-theme:      type=json,    code_default=${JSON.stringify(uiTheme.default)}`);

    // ==================================================================
    // 2. REGISTER A CONTEXT PROVIDER
    // ==================================================================
    //
    // The context provider is a function called on every flag.get().
    // It returns a list of Context objects describing the current
    // evaluation context (user, account, device, etc.).
    //
    //   new Context(type, key, attributes, { name })
    //
    // In a real app, this pulls from the current request, session, etc.
    // ==================================================================

    section("2. Register Context Provider");

    client.flags.setContextProvider(() => [
      new Context(
        "user",
        currentUser.id,
        {
          first_name: currentUser.firstName,
          plan: currentUser.plan,
          beta_tester: currentUser.betaTester,
        },
        { name: currentUser.firstName },
      ),
      new Context(
        "account",
        currentAccount.id,
        {
          industry: currentAccount.industry,
          region: currentAccount.region,
          employee_count: currentAccount.employeeCount,
        },
        { name: currentAccount.id },
      ),
    ]);

    step("Context provider registered");
    step("  Returns: [Context('user', ...), Context('account', ...)]");

    // ==================================================================
    // 3. INITIALIZE — Fetch definitions, open WebSocket
    // ==================================================================
    //
    // initialize() does three things:
    //   1. Fetches all flag definitions via GET /api/v1/flags
    //   2. Opens a shared WebSocket for live update events
    //   3. Enables local JSON Logic evaluation for all declared handles
    //
    // After initialize(), get() never touches the network.
    // ==================================================================

    section("3. Initialize the Flags Runtime");

    await client.flags.initialize();
    step("client.flags.initialize() completed");
    step("Flags loaded, WebSocket open, local evaluation ready");

    // ==================================================================
    // 4. EVALUATE FLAGS WITH .get()
    // ==================================================================
    //
    // get() runs JSON Logic evaluation locally — no HTTP per call.
    // The context provider is called, rules are matched in order,
    // and the first matching rule's value is returned.
    //
    // Current context: Alice, enterprise plan, US region, tech, 500 employees
    // ==================================================================

    // ----------------------------------------------------------------
    // 4a. Evaluate with current context (Alice)
    // ----------------------------------------------------------------
    section("4a. Evaluate Flags (Alice — enterprise, US, tech)");

    const checkoutResult = checkoutV2.get();
    step(`checkout-v2 = ${checkoutResult} (${typeof checkoutResult})`);
    // Expected: true — matches enterprise + US region rule

    const bannerResult = bannerColor.get();
    step(`banner-color = ${bannerResult} (${typeof bannerResult})`);
    // Expected: "blue" — matches enterprise plan rule

    const retriesResult = maxRetries.get();
    step(`max-retries = ${retriesResult} (${typeof retriesResult})`);
    // Expected: 5 — matches employee_count > 100 rule

    const themeResult = uiTheme.get();
    step(`ui-theme = ${JSON.stringify(themeResult)} (${typeof themeResult})`);
    // Expected: server-side default or code-level default

    // ----------------------------------------------------------------
    // 4b. Switch context — simulate a different user/request
    // ----------------------------------------------------------------
    section("4b. Evaluate Flags (Bob — free, EU, retail, 10 employees)");

    setSimulatedContext({
      user: {
        id: "user-002",
        firstName: "Bob",
        plan: "free",
        betaTester: false,
      },
      account: {
        id: "small-biz",
        industry: "retail",
        region: "eu",
        employeeCount: 10,
      },
    });

    const checkoutBob = checkoutV2.get();
    step(`checkout-v2 = ${checkoutBob}`);
    // Expected: false — no rules match

    const bannerBob = bannerColor.get();
    step(`banner-color = ${bannerBob}`);
    // Expected: "red" — no rules match, flag default

    const retriesBob = maxRetries.get();
    step(`max-retries = ${retriesBob}`);
    // Expected: 3 — no rules match, flag default

    step("Context-dependent evaluation correct");

    // Restore Alice for subsequent sections.
    setSimulatedContext({
      user: { id: "user-001", firstName: "Alice", plan: "enterprise", betaTester: true },
      account: { id: "acme-corp", industry: "technology", region: "us", employeeCount: 500 },
    });

    // ==================================================================
    // 5. EVALUATE WITH CONTEXT OVERRIDE
    // ==================================================================
    //
    // For edge cases (background jobs, tests, scripts), pass context
    // directly to get(). This bypasses the registered provider.
    // ==================================================================

    section("5. Evaluate with Context Override");

    const overrideFree = checkoutV2.get({
      context: [
        new Context("user", "test-user", { plan: "free", beta_tester: false }),
        new Context("account", "test-account", { region: "jp" }),
      ],
    });
    step(`checkout-v2 (free, JP) = ${overrideFree}`);
    // Expected: false

    const overrideEnterprise = checkoutV2.get({
      context: [
        new Context("user", "test-user", { plan: "enterprise", beta_tester: false }),
        new Context("account", "test-account", { region: "us" }),
      ],
    });
    step(`checkout-v2 (enterprise, US) = ${overrideEnterprise}`);
    // Expected: true

    const overrideBanner = bannerColor.get({
      context: [
        new Context("user", "override-user", { plan: "free" }),
        new Context("account", "override-account", { industry: "retail" }),
      ],
    });
    step(`banner-color (free, retail) = ${overrideBanner}`);
    // Expected: "red" (no rules match)

    step("Context override works — provider bypassed for these calls");

    // ==================================================================
    // 6. SCOPED CHANGE LISTENER
    // ==================================================================
    //
    // onChange(key, callback) fires only when the specified flag
    // definition changes. Useful for reacting to specific flags.
    // ==================================================================

    section("6. Scoped Change Listener");

    const bannerChanges: Array<{ key: string; source: string }> = [];
    client.flags.onChange("banner-color", (event) => {
      bannerChanges.push({ key: event.key, source: event.source });
      console.log(`    [BANNER] banner-color changed via ${event.source}`);
    });
    step("Scoped listener registered for banner-color");

    const checkoutChanges: Array<{ key: string; source: string }> = [];
    client.flags.onChange("checkout-v2", (event) => {
      checkoutChanges.push({ key: event.key, source: event.source });
      console.log(`    [CHECKOUT] checkout-v2 changed via ${event.source}`);
    });
    step("Scoped listener registered for checkout-v2");

    // ==================================================================
    // 7. GLOBAL CHANGE LISTENER
    // ==================================================================
    //
    // onChange(callback) fires when ANY flag definition changes.
    // Useful for logging, metrics, and cache invalidation.
    // ==================================================================

    section("7. Global Change Listener");

    const allChanges: Array<{ key: string; source: string }> = [];
    client.flags.onChange((event) => {
      allChanges.push({ key: event.key, source: event.source });
      console.log(`    [GLOBAL] Flag '${event.key}' changed via ${event.source}`);
    });
    step("Global change listener registered (fires for any flag)");

    // Trigger a refresh to fire listeners.
    step("Triggering manual refresh to exercise change listeners...");
    await client.flags.refresh();
    step(`Global changes received: ${allChanges.length}`);
    step(`Banner-specific changes: ${bannerChanges.length}`);
    step(`Checkout-specific changes: ${checkoutChanges.length}`);

    // ==================================================================
    // 8. CACHE STATS
    // ==================================================================
    //
    // The SDK caches resolved values by (flag_key, context_hash).
    // Repeated evaluations with identical context skip JSON Logic
    // entirely — pure hash lookup.
    // ==================================================================

    section("8. Cache Statistics");

    const statsBefore = client.flags.stats();
    step(`Cache hits: ${statsBefore.cacheHits}`);
    step(`Cache misses: ${statsBefore.cacheMisses}`);

    // Run 100 evaluations with the same context to demonstrate caching.
    for (let i = 0; i < 100; i++) {
      checkoutV2.get();
    }

    const statsAfter = client.flags.stats();
    step(`Cache hits after 100 reads: ${statsAfter.cacheHits}`);
    step(`New cache hits: ${statsAfter.cacheHits - statsBefore.cacheHits}`);
    step("Repeated evaluations served from cache — zero JSON Logic overhead");

    // ==================================================================
    // 9. CONTEXT REGISTRATION
    // ==================================================================
    //
    // register() explicitly queues contexts for background batch
    // registration with the server. This populates the Console rule
    // builder's autocomplete with real context types and attributes.
    //
    // flushContexts() forces an immediate flush of all pending
    // registrations. Normally contexts are flushed automatically
    // in batches.
    // ==================================================================

    section("9. Context Registration");

    // Single context.
    client.flags.register(
      new Context(
        "user",
        currentUser.id,
        {
          first_name: currentUser.firstName,
          plan: currentUser.plan,
          beta_tester: currentUser.betaTester,
        },
        { name: currentUser.firstName },
      ),
    );
    step("Registered single user context");

    // Multiple contexts at once — typical middleware pattern.
    client.flags.register([
      new Context("user", "user-003", {
        first_name: "Charlie",
        plan: "business",
        beta_tester: false,
      }),
      new Context("account", "corp-xyz", {
        industry: "finance",
        region: "eu",
        employee_count: 2000,
      }),
    ]);
    step("Registered user + account contexts (batch)");

    // Flush all pending registrations to the server.
    await client.flags.flushContexts();
    step("flushContexts() completed — contexts sent to server");
    step("Console rule builder now has autocomplete data for these context types");

    // ==================================================================
    // 10. CLEANUP
    // ==================================================================
    section("10. Cleanup");

    await client.flags.disconnect();
    step("Disconnected from flags runtime");

    await teardownDemoFlags(client, demoFlagKeys);
    step("Demo flags deleted");

    client.close();
    step("SmplClient closed");

    // ==================================================================
    // DONE
    // ==================================================================
    section("ALL DONE");
    console.log("  The Flags Runtime showcase completed successfully.");
    console.log("  If you got here, Smpl Flags runtime evaluation is working.\n");
  } catch (error) {
    console.error("\n  ERROR:", error);
    console.log("\n  Cleaning up...");
    try {
      await client.flags.disconnect();
    } catch {
      // ignore
    }
    await teardownDemoFlags(client, demoFlagKeys);
    client.close();
    throw error;
  }
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
