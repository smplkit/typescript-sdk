/**
 * Smpl Config SDK Showcase — Management API
 * ============================================
 *
 * Demonstrates the smplkit TypeScript SDK's management plane for Smpl Config:
 *
 * - Client initialization (`SmplClient`)
 * - Management-plane CRUD: create, update, list, get, and delete configs
 * - Environment-specific overrides (`setValues`, `setValue`)
 * - Multi-level inheritance via parent configs
 * - Inspecting config hierarchy
 *
 * Most customers will create and configure configs via the Console UI.
 * This showcase demonstrates the programmatic equivalent — useful for
 * infrastructure-as-code, CI/CD pipelines, setup scripts, and automated
 * testing.
 *
 * For the runtime experience (connecting, reading resolved values, typed
 * accessors, change listeners), see `config_runtime_showcase.ts`.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *       - SMPLKIT_API_KEY environment variable
 *       - ~/.smplkit configuration file (see SDK docs)
 *   - The smplkit Config service running and reachable
 *
 * Usage:
 *   npx tsx examples/config_management_showcase.ts
 */

import { SmplClient } from "@smplkit/sdk";

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
  //       environment: "production",
  //       service: "showcase-service",
  //   });
  //
  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  step("SmplClient initialized (environment=production)");

  // ======================================================================
  // 2. UPDATE THE COMMON CONFIG
  // ======================================================================

  // ------------------------------------------------------------------
  // 2a. Update Common Config base values
  // ------------------------------------------------------------------
  section("2a. Update the Common Config");

  const common = await client.config.get({ key: "common" });
  step(`Fetched common config: id=${common.id}, key=${common.key}`);

  await common.update({
    description: "Organization-wide shared configuration",
    items: {
      app_name: "Acme SaaS Platform",
      support_email: "support@acme.dev",
      max_retries: 3,
      request_timeout_ms: 5000,
      pagination_default_page_size: 25,
    },
  });
  step("Common config base values set");

  // ------------------------------------------------------------------
  // 2b. Environment Overrides
  // ------------------------------------------------------------------
  section("2b. Environment Overrides");

  await common.setValues({ max_retries: 5, request_timeout_ms: 10000 }, "production");
  step("Common config production overrides set (max_retries=5, request_timeout_ms=10000)");

  await common.setValues({ max_retries: 2 }, "staging");
  step("Common config staging overrides set (max_retries=2)");

  // ======================================================================
  // 3. CREATE CONFIGS
  // ======================================================================

  // ------------------------------------------------------------------
  // 3a. Create User Service Config
  // ------------------------------------------------------------------
  section("3a. Create the User Service Config");

  const userService = await client.config.create({
    name: "User Service",
    key: "user_service",
    description: "Configuration for the user microservice.",
    items: {
      database: { host: "localhost", port: 5432, name: "users_dev", pool_size: 5 },
      cache_ttl_seconds: 300,
      enable_signup: true,
      pagination_default_page_size: 50,
    },
  });
  step(`Created user_service config: id=${userService.id}`);

  await userService.setValues(
    {
      database: { host: "prod-users-rds.internal.acme.dev", name: "users_prod", pool_size: 20 },
      cache_ttl_seconds: 600,
    },
    "production",
  );
  step("User service production overrides set");

  await userService.setValue("enable_signup", false, "production");
  step("Disabled signup in production");

  // ------------------------------------------------------------------
  // 3b. Create Auth Module Config (child of User Service)
  // ------------------------------------------------------------------
  section("3b. Create the Auth Module Config (child of User Service)");

  const authModule = await client.config.create({
    name: "Auth Module",
    key: "auth_module",
    description: "Authentication module within the user service.",
    parent: userService.id,
    items: { session_ttl_minutes: 60, mfa_enabled: false },
  });
  step(`Created auth_module config: id=${authModule.id}`);

  await authModule.setValues({ session_ttl_minutes: 30, mfa_enabled: true }, "production");
  step("Auth module production overrides set");

  // ======================================================================
  // 4. INSPECT AND LIST CONFIGS
  // ======================================================================

  // ------------------------------------------------------------------
  // 4a. List All Configs
  // ------------------------------------------------------------------
  section("4a. List All Configs");

  const configs = await client.config.list();
  for (const cfg of configs) {
    const parentInfo = cfg.parent ? ` (parent: ${cfg.parent})` : " (root)";
    step(`${cfg.key}${parentInfo}`);
  }

  // ------------------------------------------------------------------
  // 4b. Get Config by ID
  // ------------------------------------------------------------------
  section("4b. Get Config by ID");

  const fetched = await client.config.get({ id: userService.id });
  step(`Fetched by ID: key=${fetched.key}, name=${fetched.name}`);
  step(`  description: ${fetched.description}`);
  step(`  items: ${JSON.stringify(Object.keys(fetched.items ?? {}))}`);

  // ======================================================================
  // 5. UPDATE A CONFIG
  // ======================================================================
  section("5. Update a Config");

  step("Updating user_service description...");
  await userService.update({
    description: "Configuration for the user microservice (updated).",
  });
  step(`Updated description: ${userService.description}`);

  step("Adding a new item to user_service...");
  const currentItems = { ...(userService.items ?? {}) };
  currentItems["rate_limit_rpm"] = 1000;
  await userService.update({ items: currentItems });
  step(`Items now: ${JSON.stringify(Object.keys(userService.items ?? {}))}`);

  step("Setting environment-specific override for new item...");
  await userService.setValue("rate_limit_rpm", 5000, "production");
  step("rate_limit_rpm set to 5000 in production");

  // ======================================================================
  // 6. CLEANUP
  // ======================================================================
  section("6. Cleanup");

  await client.config.delete(authModule.id);
  step(`Deleted auth_module (${authModule.id})`);

  await client.config.delete(userService.id);
  step(`Deleted user_service (${userService.id})`);

  await common.update({ description: "", items: {}, environments: {} });
  step("Common config reset to empty");

  client.close();
  step("SmplClient closed");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Config Management showcase completed successfully.");
  console.log("  All configs have been cleaned up.\n");
}

main().catch(console.error);
