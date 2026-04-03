/**
 * Smpl Config SDK Showcase
 * ========================
 *
 * Demonstrates the smplkit TypeScript SDK for Smpl Config, covering:
 *
 * - Client initialization (`SmplClient`)
 * - Management-plane CRUD: create, update, list, and delete configs
 * - Environment-specific overrides and multi-level inheritance
 * - Prescriptive value resolution via `client.connect()` + `client.config.getValue()`
 * - Typed accessors: `getString()`, `getInt()`, `getBool()`
 * - Manual refresh: `client.config.refresh()`
 * - Change listeners: `client.config.onChange()`
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key (set via `SMPLKIT_API_KEY` env var)
 *
 * Usage:
 *   export SMPLKIT_API_KEY="sk_api_..."
 *   export SMPLKIT_ENVIRONMENT="production"
 *   npx tsx examples/config_showcase.ts
 */

import { SmplClient } from "@smplkit/sdk";

const API_KEY = process.env.SMPLKIT_API_KEY ?? "";
const ENVIRONMENT = process.env.SMPLKIT_ENVIRONMENT ?? "production";

if (!API_KEY) {
  console.log("ERROR: Set the SMPLKIT_API_KEY environment variable before running.");
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n${"=".repeat(60)}\n  ${title}\n${"=".repeat(60)}\n`);
}

function step(description: string): void {
  console.log(`  → ${description}`);
}

async function main(): Promise<void> {
  // ======================================================================
  // 1. SDK INITIALIZATION
  // ======================================================================
  section("1. SDK Initialization");

  const client = new SmplClient({ apiKey: API_KEY, environment: ENVIRONMENT });
  step(`SmplClient initialized (environment=${ENVIRONMENT})`);

  // ======================================================================
  // 2. MANAGEMENT PLANE — Set up the configuration hierarchy
  // ======================================================================

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

  await common.setValues({ max_retries: 5, request_timeout_ms: 10000 }, "production");
  step("Common config production overrides set");

  await common.setValues({ max_retries: 2 }, "staging");
  step("Common config staging overrides set");

  section("2b. Create the User Service Config");

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

  section("2c. Create the Auth Module Config (child of User Service)");

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

  section("2d. List All Configs");

  const configs = await client.config.list();
  for (const cfg of configs) {
    const parentInfo = cfg.parent ? ` (parent: ${cfg.parent})` : " (root)";
    step(`${cfg.key}${parentInfo}`);
  }

  // ======================================================================
  // 3. PRESCRIPTIVE PLANE — Connect and read resolved values
  // ======================================================================

  section("3a. Connect and Read Resolved Values");

  await client.connect();
  step("client.connect() completed — all configs fetched and cached");

  // Prescriptive access: getValue(configKey, itemKey)
  const dbConfig = client.config.getValue("user_service", "database");
  step(`database = ${JSON.stringify(dbConfig)}`);

  const retries = client.config.getValue("user_service", "max_retries");
  step(`max_retries = ${retries}`);

  const cacheTtl = client.config.getValue("user_service", "cache_ttl_seconds");
  step(`cache_ttl_seconds = ${cacheTtl}`);

  const pageSize = client.config.getValue("user_service", "pagination_default_page_size");
  step(`pagination_default_page_size = ${pageSize}`);

  const missing = client.config.getValue("user_service", "nonexistent_key");
  step(`nonexistent key = ${missing}`);

  // Get all values for a config
  const allValues = client.config.getValue("user_service") as Record<string, unknown>;
  step(`Total resolved keys for user_service: ${Object.keys(allValues).length}`);

  // ------------------------------------------------------------------
  // 3b. Typed accessors
  // ------------------------------------------------------------------
  section("3b. Typed Accessors");

  const appName = client.config.getString("user_service", "app_name", "Unknown");
  step(`app_name (string) = ${appName}`);

  const timeoutMs = client.config.getInt("user_service", "request_timeout_ms", 3000);
  step(`request_timeout_ms (number) = ${timeoutMs}`);

  const signup = client.config.getBool("user_service", "enable_signup", true);
  step(`enable_signup (bool) = ${signup}`);

  // ------------------------------------------------------------------
  // 3c. Multi-level inheritance
  // ------------------------------------------------------------------
  section("3c. Multi-Level Inheritance (auth_module)");

  const sessionTtl = client.config.getValue("auth_module", "session_ttl_minutes");
  step(`session_ttl_minutes = ${sessionTtl}`);

  const mfa = client.config.getValue("auth_module", "mfa_enabled");
  step(`mfa_enabled = ${mfa}`);

  const inheritedApp = client.config.getValue("auth_module", "app_name");
  step(`app_name (inherited from common) = ${inheritedApp}`);

  // ======================================================================
  // 4. CHANGE LISTENERS AND REFRESH
  // ======================================================================

  section("4a. Change Listeners");

  const changes: unknown[] = [];
  client.config.onChange((event) => {
    changes.push(event);
    console.log(
      `    [CHANGE] ${event.configKey}.${event.itemKey}: ${JSON.stringify(event.oldValue)} → ${JSON.stringify(event.newValue)}`,
    );
  });
  step("Global change listener registered");

  const retriesChanges: unknown[] = [];
  client.config.onChange((e) => retriesChanges.push(e), {
    configKey: "common",
    itemKey: "max_retries",
  });
  step("Key-specific listener registered for common.max_retries");

  section("4b. Refresh After Management Change");

  await common.setValue("max_retries", 7, "production");
  step("Updated max_retries to 7 on common (production)");

  await client.config.refresh();
  step("client.config.refresh() completed");

  const newRetries = client.config.getValue("user_service", "max_retries");
  step(`max_retries after refresh = ${newRetries}`);

  step(`Global changes received: ${changes.length}`);
  step(`Retries-specific changes received: ${retriesChanges.length}`);

  // ======================================================================
  // 5. CLEANUP
  // ======================================================================
  section("5. Cleanup");

  await client.config.delete(authModule.id);
  step(`Deleted auth_module (${authModule.id})`);

  await client.config.delete(userService.id);
  step(`Deleted user_service (${userService.id})`);

  await common.update({ description: "", items: {}, environments: {} });
  step("Common config reset to empty");

  client.close();
  step("SmplClient closed");

  section("ALL DONE");
  console.log("  The Config SDK showcase completed successfully.\n");
}

main().catch(console.error);
