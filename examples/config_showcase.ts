/**
 * Smpl Config SDK Showcase
 * ========================
 *
 * Demonstrates the smplkit TypeScript SDK for Smpl Config, covering:
 *
 * - Client initialization (`SmplClient`)
 * - Management-plane CRUD: create, update, list, and delete configs
 * - Environment-specific overrides and multi-level inheritance
 * - Runtime value resolution: `connect()`, `get()`, typed accessors
 * - Real-time updates via WebSocket and change listeners
 * - Manual refresh and cache diagnostics
 *
 * This script is designed to be read top-to-bottom as a walkthrough of
 * the SDK's full capability surface. It is runnable against a live smplkit
 * environment, but is *not* a test — it creates, modifies, and deletes
 * real configs.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key (set via `SMPLKIT_API_KEY` env var)
 *   - The smplkit Config service running and reachable
 *
 * Usage:
 *   export SMPLKIT_API_KEY="sk_api_..."
 *   npx tsx examples/config_showcase.ts
 */

import { SmplClient } from "@smplkit/sdk";

// ---------------------------------------------------------------------------
// Configuration — set your API key via the SMPLKIT_API_KEY env var
// ---------------------------------------------------------------------------

const API_KEY = process.env.SMPLKIT_API_KEY ?? "";

if (!API_KEY) {
  console.log("ERROR: Set the SMPLKIT_API_KEY environment variable before running.");
  console.log("  export SMPLKIT_API_KEY='sk_api_...'");
  process.exit(1);
}

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

async function main(): Promise<void> {
  // ======================================================================
  // 1. SDK INITIALIZATION
  // ======================================================================
  section("1. SDK Initialization");

  // SmplClient is the entry point for the TypeScript SDK.
  // API key is the only required argument.
  const client = new SmplClient({ apiKey: API_KEY });
  step("SmplClient initialized");

  // ======================================================================
  // 2. MANAGEMENT PLANE — Set up the configuration hierarchy
  // ======================================================================
  //
  // This section uses the management API to create and populate configs.
  // In real life, a customer might do this via the console UI, Terraform,
  // or a setup script. The SDK supports all of it programmatically.
  // ======================================================================

  // ------------------------------------------------------------------
  // 2a. Update the built-in common config
  // ------------------------------------------------------------------
  section("2a. Update the Common Config");

  // Every account has a 'common' config auto-created at provisioning.
  // It serves as the default parent for all other configs. Let's populate
  // it with shared baseline values that every service in our org needs.

  const common = await client.config.get({ key: "common" });
  step(`Fetched common config: id=${common.id}, key=${common.key}`);

  // Set base values — these apply to ALL environments by default.
  // update() sends a full PUT with all fields; mutates the Config object
  // in place and returns void (mirrors Python's AsyncConfig.update).
  await common.update({
    description: "Organization-wide shared configuration",
    values: {
      app_name: "Acme SaaS Platform",
      support_email: "support@acme.dev",
      max_retries: 3,
      request_timeout_ms: 5000,
      pagination_default_page_size: 25,
      credentials: {
        oauth_provider: "https://auth.acme.dev",
        client_id: "acme_default_client",
        scopes: ["read"],
      },
      feature_flags: {
        provider: "smplkit",
        endpoint: "https://flags.smplkit.com",
        refresh_interval_seconds: 30,
      },
    },
  });
  step("Common config base values set");

  // Override specific values for production — these flow through to every
  // config that inherits from common, unless overridden further down.
  // setValues() replaces the target environment's values sub-dict entirely
  // while preserving other environments.
  await common.setValues(
    {
      max_retries: 5,
      request_timeout_ms: 10000,
      credentials: {
        scopes: ["read", "write", "admin"],
      },
    },
    "production",
  );
  step("Common config production overrides set");

  // Staging gets its own tweaks.
  await common.setValues(
    {
      max_retries: 2,
      credentials: {
        scopes: ["read", "write"],
      },
    },
    "staging",
  );
  step("Common config staging overrides set");

  // ------------------------------------------------------------------
  // 2b. Create a service-specific config (inherits from common)
  // ------------------------------------------------------------------
  section("2b. Create the User Service Config");

  // When we don't specify a parent, the API defaults to common.
  // This config adds service-specific keys and overrides a few common ones.
  const userService = await client.config.create({
    name: "User Service",
    key: "user_service",
    description: "Configuration for the user microservice and its dependencies.",
    values: {
      database: {
        host: "localhost",
        port: 5432,
        name: "users_dev",
        pool_size: 5,
        ssl_mode: "prefer",
      },
      cache_ttl_seconds: 300,
      enable_signup: true,
      allowed_email_domains: ["acme.dev", "acme.com"],
      // Override the common pagination default for this service
      pagination_default_page_size: 50,
    },
  });
  step(`Created user_service config: id=${userService.id}`);

  // Production overrides for the user service.
  await userService.setValues(
    {
      database: {
        host: "prod-users-rds.internal.acme.dev",
        name: "users_prod",
        pool_size: 20,
        ssl_mode: "require",
      },
      cache_ttl_seconds: 600,
    },
    "production",
  );
  step("User service production overrides set");

  // Staging overrides.
  await userService.setValues(
    {
      database: {
        host: "staging-users-rds.internal.acme.dev",
        name: "users_staging",
        pool_size: 10,
      },
    },
    "staging",
  );
  step("User service staging overrides set");

  // Add keys that only exist in the development environment.
  await userService.setValues(
    {
      debug_sql: true,
      seed_test_data: true,
    },
    "development",
  );
  step("User service development-only keys set");

  // Set a single value using the convenience method.
  await userService.setValue("enable_signup", false, "production");
  step("Disabled signup in production via setValue");

  // ------------------------------------------------------------------
  // 2c. Create a second config to show multi-level inheritance
  // ------------------------------------------------------------------
  section("2c. Create the Auth Module Config (child of User Service)");

  // This config's parent is user_service (not common), demonstrating
  // multi-level inheritance: auth_module → user_service → common.
  const authModule = await client.config.create({
    name: "Auth Module",
    key: "auth_module",
    description: "Authentication module within the user service.",
    parent: userService.id,
    values: {
      session_ttl_minutes: 60,
      max_failed_attempts: 5,
      lockout_duration_minutes: 15,
      mfa_enabled: false,
    },
  });
  step(`Created auth_module config: id=${authModule.id}, parent=${userService.id}`);

  await authModule.setValues(
    {
      session_ttl_minutes: 30,
      mfa_enabled: true,
      max_failed_attempts: 3,
    },
    "production",
  );
  step("Auth module production overrides set");

  // ------------------------------------------------------------------
  // 2d. List all configs — verify hierarchy
  // ------------------------------------------------------------------
  section("2d. List All Configs");

  const configs = await client.config.list();
  for (const cfg of configs) {
    const parentInfo = cfg.parent ? ` (parent: ${cfg.parent})` : " (root)";
    step(`${cfg.key}${parentInfo}`);
  }

  // ======================================================================
  // 3. RUNTIME PLANE — Resolve configuration in a running application
  // ======================================================================
  //
  // This is the heart of the SDK experience. A customer's application
  // connects to a config for a specific environment, and the SDK:
  //
  //   - Eagerly fetches the config and its entire parent chain
  //   - Resolves values via deep merge (inheritance + env overrides)
  //   - Caches everything in-process — get() is a local dict read
  //   - Maintains a WebSocket for real-time server-pushed updates
  //   - Notifies registered listeners when values change
  //
  // get() and all value-access methods are SYNCHRONOUS. They never
  // touch the network. The only async operations are connect(),
  // refresh(), and close().
  //
  // ======================================================================

  // ------------------------------------------------------------------
  // 3a. Connect to a config for runtime use
  // ------------------------------------------------------------------
  section("3a. Connect to Runtime Config");

  // connect() eagerly fetches the config and its full parent chain,
  // resolves all values for the given environment, and establishes
  // a WebSocket connection for real-time updates. When it returns,
  // the cache is fully populated and ready.
  const runtime = await userService.connect("production", { timeout: 10_000 });
  step("Runtime config connected and fully loaded");

  // ------------------------------------------------------------------
  // 3b. Read resolved values — all synchronous, all from local cache
  // ------------------------------------------------------------------
  section("3b. Read Resolved Values");

  const dbConfig = runtime.get("database");
  step(`database = ${JSON.stringify(dbConfig)}`);
  // Expected (deep-merged): user_service prod override + user_service base
  // { host: "prod-users-rds...", port: 5432, name: "users_prod",
  //   pool_size: 20, ssl_mode: "require" }

  const retries = runtime.get("max_retries");
  step(`max_retries = ${retries}`);
  // Expected: 5 (from common's production override — inherited through)

  const creds = runtime.get("credentials");
  step(`credentials = ${JSON.stringify(creds)}`);

  const cacheTtl = runtime.get("cache_ttl_seconds");
  step(`cache_ttl_seconds = ${cacheTtl}`);
  // Expected: 600 (user_service production override)

  const pageSize = runtime.get("pagination_default_page_size");
  step(`pagination_default_page_size = ${pageSize}`);
  // Expected: 50 (user_service base overrides common's 25)

  const supportEmail = runtime.get("support_email");
  step(`support_email = ${supportEmail}`);
  // Expected: "support@acme.dev" (inherited all the way from common base)

  const missing = runtime.get("this_key_does_not_exist");
  step(`nonexistent key = ${missing}`);
  // Expected: null

  const withDefault = runtime.get("this_key_does_not_exist", "fallback");
  step(`nonexistent key with default = ${withDefault}`);
  // Expected: "fallback"

  // Typed convenience accessors for common JSON types.
  const signupEnabled = runtime.getBool("enable_signup", false);
  step(`enable_signup (bool) = ${signupEnabled}`);
  // Expected: false (user_service production override via setValue)

  const timeoutMs = runtime.getInt("request_timeout_ms", 3000);
  step(`request_timeout_ms (number) = ${timeoutMs}`);
  // Expected: 10000 (common production override)

  const appName = runtime.getString("app_name", "Unknown");
  step(`app_name (string) = ${appName}`);
  // Expected: "Acme SaaS Platform" (common base)

  // Check whether a key exists (regardless of its value).
  step(`'database' exists = ${runtime.exists("database")}`);
  // Expected: true
  step(`'ghost_key' exists = ${runtime.exists("ghost_key")}`);
  // Expected: false

  // ------------------------------------------------------------------
  // 3c. Verify local caching — no network requests on repeated reads
  // ------------------------------------------------------------------
  section("3c. Verify Local Caching");

  // connect() fetched everything eagerly. All get() calls are pure
  // local dict reads with zero network overhead. The stats object
  // lets us verify this.
  const stats = runtime.stats();
  step(`Network fetches so far: ${stats.fetchCount}`);
  // Expected: 2 (user_service + common, fetched during connect)

  // Read a bunch of keys — none should trigger a fetch.
  for (let i = 0; i < 100; i++) {
    runtime.get("max_retries");
    runtime.get("database");
    runtime.get("credentials");
  }

  const statsAfter = runtime.stats();
  step(`Network fetches after 300 reads: ${statsAfter.fetchCount}`);
  // Expected: still the same — all reads served from local cache
  if (statsAfter.fetchCount !== stats.fetchCount) {
    throw new Error(
      `SDK made unexpected network calls! Before: ${stats.fetchCount}, After: ${statsAfter.fetchCount}`,
    );
  }
  step("PASSED — all reads served from local cache");

  // ------------------------------------------------------------------
  // 3d. Get ALL resolved values as a dictionary
  // ------------------------------------------------------------------
  section("3d. Get Full Resolved Configuration");

  // Sometimes you want the entire resolved config as a dict — for
  // logging at startup, passing to a framework, or debugging.
  const allValues = runtime.getAll();
  step(`Total resolved keys: ${Object.keys(allValues).length}`);
  for (const key of Object.keys(allValues).sort()) {
    step(`  ${key} = ${JSON.stringify(allValues[key])}`);
  }

  // ------------------------------------------------------------------
  // 3e. Multi-level inheritance — connect to auth_module in production
  // ------------------------------------------------------------------
  section("3e. Multi-Level Inheritance (auth_module)");

  const authRuntime = await authModule.connect("production", { timeout: 10_000 });
  try {
    const sessionTtl = authRuntime.get("session_ttl_minutes");
    step(`session_ttl_minutes = ${sessionTtl}`);
    // Expected: 30 (auth_module production override)

    const mfa = authRuntime.get("mfa_enabled");
    step(`mfa_enabled = ${mfa}`);
    // Expected: true (auth_module production override)

    // Keys inherited from user_service:
    const db = authRuntime.get("database");
    step(`database (inherited from user_service) = ${JSON.stringify(db)}`);

    // Keys inherited all the way from common:
    const app = authRuntime.get("app_name");
    step(`app_name (inherited from common) = ${app}`);
  } finally {
    await authRuntime.close();
    step("auth_runtime closed via try/finally");
  }

  // ======================================================================
  // 4. REAL-TIME UPDATES — WebSocket-driven cache invalidation
  // ======================================================================
  //
  // The SDK maintains a WebSocket connection to the config service. When
  // a config value is changed (via the console, API, or another SDK
  // instance), the server pushes an update and the SDK refreshes its
  // local cache. The application can register listeners to react to
  // changes without polling.
  // ======================================================================

  section("4. Real-Time Updates via WebSocket");

  // ------------------------------------------------------------------
  // 4a. Register a change listener
  // ------------------------------------------------------------------

  const changesReceived: Array<{ key: string; oldValue: unknown; newValue: unknown; source: string }> = [];

  runtime.onChange((event) => {
    changesReceived.push({
      key: event.key,
      oldValue: event.oldValue,
      newValue: event.newValue,
      source: event.source,
    });
    console.log(`    [CHANGE] ${event.key}: ${JSON.stringify(event.oldValue)} → ${JSON.stringify(event.newValue)}`);
  });
  step("Change listener registered");

  // You can also listen for changes to a specific key.
  const retryChanges: unknown[] = [];
  runtime.onChange((e) => retryChanges.push(e), { key: "max_retries" });
  step("Key-specific listener registered for 'max_retries'");

  // ------------------------------------------------------------------
  // 4b. Simulate a config change via the management API
  // ------------------------------------------------------------------
  step("Updating max_retries on common (production) via management API...");

  await common.setValue("max_retries", 7, "production");

  // Give the WebSocket a moment to deliver the update.
  await sleep(2000);

  // The runtime cache should now reflect the new value WITHOUT us
  // having to do anything — the WebSocket pushed the update.
  const newRetries = runtime.get("max_retries");
  step(`max_retries after live update = ${newRetries}`);
  // Expected: 7

  step(`Changes received by listener: ${changesReceived.length}`);
  step(`Retry-specific changes received: ${retryChanges.length}`);

  // ------------------------------------------------------------------
  // 4c. Connection lifecycle
  // ------------------------------------------------------------------
  section("4c. WebSocket Connection Lifecycle");

  const wsStatus = runtime.connectionStatus();
  step(`WebSocket status: ${wsStatus}`);
  // Expected: "connected"

  // The SDK reconnects automatically if the connection drops, using
  // exponential backoff (1s, 2s, 4s, ... capped at 60s, retries forever).
  // You can also manually force a refresh if needed.
  await runtime.refresh();
  step("Manual refresh completed");

  const statsAfterRefresh = runtime.stats();
  step(`Network fetches after manual refresh: ${statsAfterRefresh.fetchCount}`);

  // ======================================================================
  // 5. ENVIRONMENT COMPARISON
  // ======================================================================

  section("5. Environment Comparison");

  // A developer might want to see how the same config resolves across
  // environments — useful for debugging "works in staging but not prod."

  for (const env of ["development", "staging", "production"]) {
    const envRuntime = await userService.connect(env, { timeout: 10_000 });
    try {
      const dbHost = (envRuntime.get("database") as Record<string, unknown> | null)?.host ?? "N/A";
      const envRetries = envRuntime.get("max_retries");
      step(`[${env.padEnd(12)}] db.host=${dbHost}, retries=${envRetries}`);
    } finally {
      await envRuntime.close();
    }
  }

  // ======================================================================
  // 6. CLEANUP
  // ======================================================================
  section("6. Cleanup");

  // Close the runtime connection (WebSocket teardown).
  await runtime.close();
  step("Runtime connection closed");

  // Delete configs in dependency order (children first).
  await client.config.delete(authModule.id);
  step(`Deleted auth_module (${authModule.id})`);

  await client.config.delete(userService.id);
  step(`Deleted user_service (${userService.id})`);

  // Restore common to empty state (can't delete, but can clear values).
  await common.update({
    description: "",
    values: {},
    environments: {},
  });
  step("Common config reset to empty");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Config SDK showcase completed successfully.");
  console.log("  If you got here, Smpl Config is ready to ship.\n");
}

main().catch(console.error);
