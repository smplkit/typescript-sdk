/**
 * Smpl Config SDK Showcase — Runtime
 * ====================================
 *
 * Demonstrates the smplkit TypeScript SDK's runtime experience for Smpl Config:
 *
 * - Client initialization (`SmplClient`)
 * - Prescriptive value resolution via `client.connect()` + `client.config.getValue()`
 * - Typed accessors: `getString()`, `getInt()`, `getBool()`
 * - Multi-level inheritance (child configs inherit from parents and common)
 * - Change listeners: `client.config.onChange()`
 * - Manual refresh: `client.config.refresh()`
 *
 * This is the SDK experience that 99% of customers will use. Configs are
 * created and configured via the Console UI (or the management API shown
 * in `config_management_showcase.ts`). This script focuses entirely on
 * the runtime: connecting, reading resolved values, and reacting to changes.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key (set via `SMPLKIT_API_KEY` env var)
 *
 * Usage:
 *   export SMPLKIT_API_KEY="sk_api_..."
 *   export SMPLKIT_ENVIRONMENT="production"
 *   npx tsx examples/config_runtime_showcase.ts
 */

import { SmplClient } from "@smplkit/sdk";

// Demo scaffolding — creates configs so this showcase can run standalone.
// In a real app, configs are created via the Console UI.
import { setupDemoConfigs, teardownDemoConfigs } from "./config_runtime_setup.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_KEY = process.env.SMPLKIT_API_KEY ?? "";
const ENVIRONMENT = process.env.SMPLKIT_ENVIRONMENT ?? "production";

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
  // 1. SDK INITIALIZATION + SETUP
  // ======================================================================
  section("1. SDK Initialization + Setup");

  const client = new SmplClient({ apiKey: API_KEY, environment: ENVIRONMENT });
  step(`SmplClient initialized (environment=${ENVIRONMENT})`);

  // Create demo configs (normally done via Console UI).
  console.log("  Setting up demo configs...");
  const demo = await setupDemoConfigs(client);
  console.log("  Demo configs ready.\n");

  // ======================================================================
  // 2. CONNECT AND READ RESOLVED VALUES
  // ======================================================================

  section("2. Connect and Read Resolved Values");

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

  // ======================================================================
  // 3. TYPED ACCESSORS
  // ======================================================================

  section("3. Typed Accessors");

  const appName = client.config.getString("user_service", "app_name", "Unknown");
  step(`app_name (string) = ${appName}`);

  const timeoutMs = client.config.getInt("user_service", "request_timeout_ms", 3000);
  step(`request_timeout_ms (number) = ${timeoutMs}`);

  const signup = client.config.getBool("user_service", "enable_signup", true);
  step(`enable_signup (bool) = ${signup}`);

  // ======================================================================
  // 4. MULTI-LEVEL INHERITANCE
  // ======================================================================

  section("4. Multi-Level Inheritance (auth_module)");

  const sessionTtl = client.config.getValue("auth_module", "session_ttl_minutes");
  step(`session_ttl_minutes = ${sessionTtl}`);

  const mfa = client.config.getValue("auth_module", "mfa_enabled");
  step(`mfa_enabled = ${mfa}`);

  const inheritedApp = client.config.getValue("auth_module", "app_name");
  step(`app_name (inherited from common) = ${inheritedApp}`);

  // ======================================================================
  // 5. CHANGE LISTENERS AND REFRESH
  // ======================================================================

  // ------------------------------------------------------------------
  // 5a. Change Listeners
  // ------------------------------------------------------------------
  section("5a. Change Listeners");

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

  // ------------------------------------------------------------------
  // 5b. Refresh After Management Change
  // ------------------------------------------------------------------
  section("5b. Refresh After Management Change");

  await demo.common.setValue("max_retries", 7, "production");
  step("Updated max_retries to 7 on common (production)");

  await client.config.refresh();
  step("client.config.refresh() completed");

  const newRetries = client.config.getValue("user_service", "max_retries");
  step(`max_retries after refresh = ${newRetries}`);

  step(`Global changes received: ${changes.length}`);
  step(`Retries-specific changes received: ${retriesChanges.length}`);

  // ======================================================================
  // 6. CLEANUP
  // ======================================================================
  section("6. Cleanup");

  await teardownDemoConfigs(client, demo);
  step("Demo configs deleted and common reset");

  client.close();
  step("SmplClient closed");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Config Runtime showcase completed successfully.\n");
}

main().catch(console.error);
