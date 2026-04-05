/**
 * Smpl Flags SDK Showcase — Runtime Evaluation
 * ==============================================
 *
 * Demonstrates the smplkit TypeScript SDK's runtime evaluation for Smpl Flags:
 *
 * - Typed flag declarations with code-level defaults
 * - Context providers and typed context entities
 * - Explicit context registration (middleware pattern)
 * - Connecting to an environment for local evaluation
 * - Evaluating flags — local JSON Logic, no network per call
 * - Resolution caching and cache stats
 * - Explicit context overrides
 * - Context registration (populates Console rule builder)
 * - Real-time updates via WebSocket and change listeners
 * - Flag-specific and global change listeners
 * - Environment comparison
 * - Tier 1 explicit evaluation (pass everything)
 *
 * This is the SDK experience that 99% of customers will use. Flags are
 * created and configured via the Console UI (or the management API shown
 * in `flags_management_showcase.ts`). This script focuses entirely on
 * the runtime: declaring, connecting, evaluating, and reacting to changes.
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

import { SmplClient, Context, Rule } from "@smplkit/sdk";

// Demo scaffolding — creates flags so this showcase can run standalone.
// In a real app, flags are created via the Console UI.
import { setupDemoFlags, teardownDemoFlags } from "./flags_demo_setup.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // The SmplClient constructor resolves three required parameters:
  //
  //   apiKey       — not passed here; resolved automatically from the
  //                  SMPLKIT_API_KEY environment variable or the
  //                  ~/.smplkit configuration file.
  //
  //   environment  — the target environment. Can also be resolved from
  //                  SMPLKIT_ENVIRONMENT if not passed.
  //
  //   service      — identifies this SDK instance. Can also be resolved
  //                  from SMPLKIT_SERVICE if not passed.
  //
  // To pass the API key explicitly:
  //
  //   const client = new SmplClient({
  //       apiKey: "sk_api_...",
  //       environment: "staging",
  //       service: "showcase-service",
  //   });
  //
  const client = new SmplClient({
    environment: "staging",
    service: "showcase-service",
  });

  // Create demo flags (normally done via Console UI).
  console.log("  Setting up demo flags...");
  const demoFlags = await setupDemoFlags(client);
  console.log("  Demo flags ready.\n");

  // ======================================================================
  // 1. TYPED FLAG DECLARATIONS
  // ======================================================================
  //
  // Flag declarations are local to the SDK. They do NOT create flags
  // on the server. They serve three purposes:
  //
  //   1. Typed handle — get() returns boolean, string, number, etc.
  //   2. Code-level default — used if the server is unreachable
  //      or the flag doesn't exist on the server
  //   3. Documentation — which flags this application depends on
  //
  // The code-level default represents "what should this code path do
  // if we can't reach smplkit?" — typically the safe/conservative value.
  // It may or may not match the server-side flag default.
  // ======================================================================

  section("1. Declare Typed Flag Handles");

  const checkoutV2 = client.flags.boolFlag("checkout-v2", false);
  const bannerColor = client.flags.stringFlag("banner-color", "red");
  const maxRetries = client.flags.numberFlag("max-retries", 3);

  // This flag doesn't exist on the server — code default will be used.
  const nonexistent = client.flags.boolFlag("feature-that-doesnt-exist", false);

  step(`checkout_v2:    key=${checkoutV2.key}, code_default=${checkoutV2.default}`);
  step(`banner_color:   key=${bannerColor.key}, code_default=${bannerColor.default}`);
  step(`max_retries:    key=${maxRetries.key}, code_default=${maxRetries.default}`);
  step(`nonexistent:    key=${nonexistent.key}, code_default=${nonexistent.default}`);

  // ======================================================================
  // 2. CONTEXT PROVIDER
  // ======================================================================
  //
  // The context provider is a function called on every flag.get().
  // It returns a list of Context objects, each describing a typed
  // entity in the evaluation context.
  //
  //   new Context(type, key, attributes, { name })
  //
  // - type: the context type ("user", "account", "device", etc.)
  // - key: the entity identifier ("user-123", "acme-corp")
  // - attributes: keyword args for any attributes to target on
  // - options.name: display name for the Console
  //
  // In a real app, this pulls from the current request, authenticated
  // user, session, etc.
  //
  // The SDK uses this for two purposes:
  //   1. Building the nested object for JSON Logic evaluation
  //   2. Registering observed contexts with the server (powers
  //      Console rule builder autocomplete)
  // ======================================================================

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
      { name: currentAccount.industry },
    ),
  ]);

  step("Context provider registered");
  step("  Returns: [Context('user', 'user-001', { plan: 'enterprise', ... }), ...]");
  step("  JSON Logic sees: { user: { key: 'user-001', plan: '...' }, account: { ... } }");

  // ======================================================================
  // 3. EXPLICIT CONTEXT REGISTRATION (Middleware Pattern)
  // ======================================================================
  //
  // In a real application, your middleware registers context on every
  // request — regardless of whether any flags are evaluated. This
  // ensures the Console rule builder always has fresh context data
  // to offer as autocomplete suggestions.
  //
  // register() accepts a single Context or an array. It queues contexts
  // for background batch registration — it never blocks the request.
  // ======================================================================

  section("3. Explicit Context Registration");

  // Single context — common in simple middleware
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

  // Multiple contexts at once — typical middleware pattern
  client.flags.register([
    new Context("user", currentUser.id, {
      first_name: currentUser.firstName,
      plan: currentUser.plan,
      beta_tester: currentUser.betaTester,
    }),
    new Context("account", currentAccount.id, {
      industry: currentAccount.industry,
      region: currentAccount.region,
      employee_count: currentAccount.employeeCount,
    }),
  ]);
  step("Registered user + account contexts");

  // register() works before connect() — contexts are queued locally
  // and flushed when the connection is established or flushContexts()
  // is called. This means your middleware can start registering
  // contexts at app startup, even before the flags environment is known.
  step("Note: register() works before connect() — contexts are queued locally");

  // ======================================================================
  // 4. CONNECT — Fetch definitions, open WebSocket, go local
  // ======================================================================

  section("4. Connect to Staging Environment");

  // connect() does three things:
  //   1. Fetches all flag definitions via GET /api/v1/flags
  //   2. Opens a shared WebSocket for live update events
  //   3. Enables local JSON Logic evaluation for all declared flags
  //
  // After connect(), get() never touches the network.

  await client.flags.connect("staging");
  step("Connected to staging — flags loaded, WebSocket open");

  // ======================================================================
  // 5. EVALUATE FLAGS — Local, typed, instant
  // ======================================================================

  // ------------------------------------------------------------------
  // 5a. Evaluate with current context (Alice, enterprise, US, tech, 500)
  // ------------------------------------------------------------------
  section("5a. Evaluate Flags (Alice — enterprise, US, tech company)");

  const checkoutResult = checkoutV2.get();
  step(`checkout-v2 = ${checkoutResult}`);
  if (checkoutResult !== true) throw new Error(`Expected true, got ${checkoutResult}`);
  if (typeof checkoutResult !== "boolean") throw new Error("Expected boolean return type");
  // Matches: enterprise + US region

  const bannerResult = bannerColor.get();
  step(`banner-color = ${bannerResult}`);
  if (bannerResult !== "blue") throw new Error(`Expected 'blue', got ${bannerResult}`);
  if (typeof bannerResult !== "string") throw new Error("Expected string return type");
  // Matches: enterprise plan (first rule)

  const retriesResult = maxRetries.get();
  step(`max-retries = ${retriesResult}`);
  if (retriesResult !== 5) throw new Error(`Expected 5, got ${retriesResult}`);
  // Matches: employee_count 500 > 100

  const nonexistentResult = nonexistent.get();
  step(`feature-that-doesnt-exist = ${nonexistentResult}`);
  if (nonexistentResult !== false) throw new Error("Expected false");
  // Flag not on server — code-level default used

  step("All assertions passed");

  // ------------------------------------------------------------------
  // 5b. Switch context — simulate a different user/request
  // ------------------------------------------------------------------
  section("5b. Evaluate Flags (Bob — free, EU, retail, 10 employees)");

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

  const checkoutResult2 = checkoutV2.get();
  step(`checkout-v2 = ${checkoutResult2}`);
  if (checkoutResult2 !== false) throw new Error("Expected false");
  // No rules match: not enterprise+US, not beta tester

  const bannerResult2 = bannerColor.get();
  step(`banner-color = ${bannerResult2}`);
  if (bannerResult2 !== "red") throw new Error(`Expected 'red', got ${bannerResult2}`);
  // No rules match: not enterprise, not technology; flag default = red

  const retriesResult2 = maxRetries.get();
  step(`max-retries = ${retriesResult2}`);
  if (retriesResult2 !== 3) throw new Error(`Expected 3, got ${retriesResult2}`);
  // No rules match: 10 employees not > 100; flag default = 3

  step("Context-dependent evaluation correct");

  // Restore Alice for subsequent sections.
  setSimulatedContext({
    user: { id: "user-001", firstName: "Alice", plan: "enterprise", betaTester: true },
    account: { id: "acme-corp", industry: "technology", region: "us", employeeCount: 500 },
  });

  // ------------------------------------------------------------------
  // 5c. Explicit context override — bypass the provider
  // ------------------------------------------------------------------
  section("5c. Explicit Context Override");

  // For edge cases (background jobs, tests), pass context directly.
  // This bypasses the registered provider for this one call.

  const explicitResult = checkoutV2.get({
    context: [
      new Context("user", "test-user", { plan: "free", beta_tester: false }),
      new Context("account", "test-account", { region: "jp" }),
    ],
  });
  step(`checkout-v2 (free, JP) = ${explicitResult}`);
  if (explicitResult !== false) throw new Error("Expected false");

  const explicitResult2 = checkoutV2.get({
    context: [
      new Context("user", "test-user", { plan: "enterprise", beta_tester: false }),
      new Context("account", "test-account", { region: "us" }),
    ],
  });
  step(`checkout-v2 (enterprise, US) = ${explicitResult2}`);
  if (explicitResult2 !== true) throw new Error("Expected true");

  step("Explicit context override works");

  // ======================================================================
  // 6. RESOLUTION CACHING
  // ======================================================================

  section("6. Resolution Caching");

  // The SDK caches resolved values by (flag_key, context_hash).
  // Repeated evaluations with identical context skip JSON Logic
  // evaluation entirely — pure hash lookup.

  const stats = client.flags.stats();
  step(`Cache hits so far: ${stats.cacheHits}`);
  step(`Cache misses so far: ${stats.cacheMisses}`);

  for (let i = 0; i < 100; i++) {
    checkoutV2.get();
  }

  const statsAfter = client.flags.stats();
  step(`Cache hits after 100 reads: ${statsAfter.cacheHits}`);
  if (statsAfter.cacheHits < stats.cacheHits + 100) {
    throw new Error("Expected at least 100 additional cache hits");
  }
  step("PASSED — repeated evaluations served from cache");

  // ======================================================================
  // 7. CONTEXT REGISTRATION
  // ======================================================================
  //
  // As a side effect of calling the context provider, the SDK batches
  // newly-observed context instances and sends them to the server in
  // the background. This populates the Console rule builder's
  // autocomplete with real context types, attributes, and values.
  //
  // Contexts may have been registered both explicitly via register()
  // (section 3) and automatically via the context provider during get() calls.
  //
  // Registration is fire-and-forget — it never blocks flag evaluation.
  // ======================================================================

  section("7. Context Registration");

  await client.flags.flushContexts();
  step("Flushed pending context registrations");

  // Verify the server now knows about our context types.
  const contextTypes = await client.flags.listContextTypes();
  step(`Context types on server: ${JSON.stringify(contextTypes.map((ct) => ct.key))}`);
  // Expected: ["user", "account"]

  for (const ct of contextTypes) {
    step(`  ${ct.key}: attributes=${JSON.stringify(Object.keys(ct.attributes))}`);
  }
  // Expected: user has first_name, plan, beta_tester
  // Expected: account has industry, region, employee_count

  step("Contexts registered via both register() and automatic get() side-effect");
  step("Context registration verified — Console rule builder has real data");

  // ======================================================================
  // 8. REAL-TIME UPDATES — WebSocket-driven cache invalidation
  // ======================================================================

  section("8. Real-Time Updates via WebSocket");

  // ------------------------------------------------------------------
  // 8a. Register change listeners
  // ------------------------------------------------------------------

  // Global listener — fires when ANY flag definition changes.
  const allChanges: Array<{ key: string; source: string }> = [];

  client.flags.onChange((event) => {
    allChanges.push({ key: event.key, source: event.source });
    console.log(`    [GLOBAL] Flag '${event.key}' updated via ${event.source}`);
  });
  step("Global change listener registered (fires for any flag)");

  // Flag-specific listener — fires only when THIS flag changes.
  const bannerChanges: unknown[] = [];

  bannerColor.onChange((event) => {
    bannerChanges.push(event);
    console.log("    [BANNER] banner-color definition changed");
  });
  step("Flag-specific listener registered for banner-color");

  const checkoutChanges: unknown[] = [];

  checkoutV2.onChange((event) => {
    checkoutChanges.push(event);
    console.log("    [CHECKOUT] checkout-v2 definition changed");
  });
  step("Flag-specific listener registered for checkout-v2");

  // ------------------------------------------------------------------
  // 8b. Simulate a change via the management API
  // ------------------------------------------------------------------
  step("Adding a rule to banner-color staging via management API...");

  // In real life this would be done via the Console UI by another
  // team member. We simulate it here with the management API.
  const currentBanner = await client.flags.get(demoFlags[1].id);
  await currentBanner.addRule(
    new Rule("Red for small companies")
      .environment("staging")
      .when("account.employee_count", "<", 50)
      .serve("red")
      .build(),
  );

  // Give the WebSocket a moment to deliver the update.
  await sleep(2000);

  step(`Global changes received: ${allChanges.length}`);
  step(`Banner-specific changes: ${bannerChanges.length}`);
  step(`Checkout-specific changes: ${checkoutChanges.length}`);
  // Expected: global=1, banner=1, checkout=0 (only banner was changed)

  // ------------------------------------------------------------------
  // 8c. Connection lifecycle
  // ------------------------------------------------------------------
  const wsStatus = client.flags.connectionStatus();
  step(`WebSocket status: ${wsStatus}`);

  // The SDK reconnects automatically if the connection drops, using
  // exponential backoff. You can also manually refresh all definitions.
  await client.flags.refresh();
  step("Manual refresh completed");

  // ======================================================================
  // 9. ENVIRONMENT COMPARISON
  // ======================================================================

  section("9. Environment Comparison");

  await client.flags.disconnect();

  for (const env of ["staging", "production"]) {
    await client.flags.connect(env);
    const c = checkoutV2.get();
    const b = bannerColor.get();
    const r = maxRetries.get();
    step(`[${env.padEnd(12)}] checkout-v2=${c}, banner-color=${b}, max-retries=${r}`);
    await client.flags.disconnect();
  }

  // Reconnect to staging for tier 1 demo.
  await client.flags.connect("staging");

  // ======================================================================
  // 10. TIER 1 — Explicit evaluation (pass everything)
  // ======================================================================

  section("10. Tier 1 — Explicit Evaluation (No Provider)");

  // The Tier 1 API is always available alongside the prescriptive tier.
  // Useful for scripts, one-off jobs, and infrastructure code.
  // Flag key is the first argument.

  const explicitValue = await client.flags.evaluate("banner-color", {
    environment: "staging",
    context: [
      new Context("user", "user-999", { plan: "enterprise" }),
      new Context("account", "corp-999", { industry: "technology" }),
    ],
  });
  step(`Tier 1 evaluate banner-color = ${explicitValue}`);
  // Expected: "blue" (enterprise plan matches first rule)

  // ======================================================================
  // 11. CLEANUP
  // ======================================================================
  section("11. Cleanup");

  await client.flags.disconnect();
  step("Disconnected from flags environment");

  await teardownDemoFlags(client, demoFlags);
  step("Demo flags and context types deleted");

  client.close();
  step("SmplClient closed");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Flags Runtime showcase completed successfully.");
  console.log("  If you got here, Smpl Flags is ready to ship.\n");
}

main().catch(console.error);
