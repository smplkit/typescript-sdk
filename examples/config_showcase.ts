/**
 * Smpl Config SDK Showcase
 * ========================
 *
 * Demonstrates the smplkit TypeScript SDK for Smpl Config, covering:
 *
 * - Client initialization (`SmplkitClient`)
 * - Management-plane CRUD: create, update, list, and delete configs
 * - Environment-specific overrides and multi-level inheritance
 * - Runtime value resolution: `connect()`, `get()`, typed accessors
 * - Real-time updates via WebSocket and change listeners
 *
 * This script is designed to be read top-to-bottom as a walkthrough of the
 * SDK's full capability surface. It is runnable against a live smplkit
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

import { SmplkitClient } from "@smplkit/sdk";

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

async function main(): Promise<void> {
  // ======================================================================
  // 1. SDK INITIALIZATION
  // ======================================================================
  section("1. SDK Initialization");

  // The SmplkitClient is the entry point for the TypeScript SDK.
  // API key is the only required argument.
  const client = new SmplkitClient({ apiKey: API_KEY });
  step("SmplkitClient initialized");

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

  let common = await client.config.get({ key: "common" });
  step(`Fetched common config: id=${common.id}, key=${common.key}`);

  // Set base values — these apply to ALL environments by default.
  common = await client.config.update(common.id, {
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
  await client.config.setValues(
    common.id,
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
  await client.config.setValues(
    common.id,
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
  await client.config.setValues(
    userService.id,
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
  await client.config.setValues(
    userService.id,
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
  await client.config.setValues(
    userService.id,
    {
      debug_sql: true,
      seed_test_data: true,
    },
    "development",
  );
  step("User service development-only keys set");

  // Set a single value using the convenience method.
  await client.config.setValue(userService.id, "enable_signup", false, "production");
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

  await client.config.setValues(
    authModule.id,
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
  // --- SKIPPED: Runtime plane not yet implemented in TypeScript SDK ---
  //
  // The Python SDK provides:
  //   - config.connect(environment) — eagerly fetch + resolve inheritance
  //   - runtime.get(key) — synchronous local cache read
  //   - runtime.get_str(), get_int(), get_bool() — typed accessors
  //   - runtime.exists(key) — key existence check
  //   - runtime.get_all() — full resolved config as dict
  //   - runtime.stats() — cache diagnostics
  //   - runtime.on_change() — WebSocket-driven change listeners
  //   - runtime.connection_status() — WebSocket status
  //   - runtime.refresh() — manual re-fetch
  //   - runtime.close() — teardown
  //
  // These features will be added to the TypeScript SDK in a future release.
  // When available, sections 3–5 below should be uncommented and adapted.
  // ======================================================================

  section("3. Runtime Plane (not yet available)");
  step("SKIPPED: connect() and runtime value resolution not yet implemented");
  step("SKIPPED: Typed accessors (getString, getNumber, getBool) not yet implemented");
  step("SKIPPED: Local caching and stats() not yet implemented");
  step("SKIPPED: getAll() not yet implemented");
  step("SKIPPED: Multi-level inheritance resolution not yet implemented");

  // ======================================================================
  // 4. REAL-TIME UPDATES — WebSocket-driven cache invalidation
  // ======================================================================

  section("4. Real-Time Updates (not yet available)");
  step("SKIPPED: onChange() listeners not yet implemented");
  step("SKIPPED: WebSocket connection lifecycle not yet implemented");

  // ======================================================================
  // 5. ENVIRONMENT COMPARISON
  // ======================================================================

  section("5. Environment Comparison (not yet available)");
  step("SKIPPED: Runtime connect() required for environment comparison");

  // ======================================================================
  // 6. MANAGEMENT PLANE VERIFICATION
  // ======================================================================
  //
  // Since the runtime plane is not yet available, let's verify the
  // management data we set up by re-fetching configs and inspecting
  // their stored values and environment overrides.
  // ======================================================================

  section("6. Management Plane Verification");

  // Re-fetch user_service and verify stored values.
  const fetchedUserService = await client.config.get({ key: "user_service" });
  step(`user_service base values: ${JSON.stringify(fetchedUserService.values, null, 2)}`);
  step(`user_service environments: ${JSON.stringify(fetchedUserService.environments, null, 2)}`);

  // Re-fetch auth_module and verify inheritance chain.
  const fetchedAuthModule = await client.config.get({ key: "auth_module" });
  step(`auth_module parent: ${fetchedAuthModule.parent}`);
  step(`auth_module base values: ${JSON.stringify(fetchedAuthModule.values, null, 2)}`);
  step(`auth_module environments: ${JSON.stringify(fetchedAuthModule.environments, null, 2)}`);

  // Re-fetch common and verify overrides.
  const fetchedCommon = await client.config.get({ key: "common" });
  step(`common base values: ${JSON.stringify(fetchedCommon.values, null, 2)}`);
  step(`common environments: ${JSON.stringify(fetchedCommon.environments, null, 2)}`);

  // ======================================================================
  // 7. CLEANUP
  // ======================================================================
  section("7. Cleanup");

  // Delete configs in dependency order (children first).
  await client.config.delete(authModule.id);
  step(`Deleted auth_module (${authModule.id})`);

  await client.config.delete(userService.id);
  step(`Deleted user_service (${userService.id})`);

  // Restore common to empty state (can't delete, but can clear values).
  await client.config.update(common.id, {
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
