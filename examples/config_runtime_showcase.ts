/**
 * Smpl Config SDK Showcase — Runtime
 * ====================================
 *
 * Demonstrates the smplkit TypeScript SDK's runtime experience for Smpl Config:
 *
 * - Client initialization (`SmplClient`)
 * - Value resolution: `client.config.resolve()` for flat dict
 * - Typed resolution: `client.config.resolve()` with a model class
 * - Live proxy: `client.config.subscribe()` for auto-updating access
 * - Change listeners at three levels: global, config-scoped, item-scoped
 * - Manual refresh: `client.config.refresh()`
 *
 * This is the SDK experience that 99% of customers will use. Configs are
 * created and configured via the Console UI (or the management API shown
 * in `config_management_showcase.ts`). This script focuses entirely on
 * the runtime: resolving values, subscribing to live updates, and
 * reacting to changes.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *       - SMPLKIT_API_KEY environment variable
 *       - ~/.smplkit configuration file (see SDK docs)
 *   - The smplkit Config service running and reachable
 *
 * Usage:
 *   npx tsx examples/config_runtime_showcase.ts
 */

import { SmplClient } from "@smplkit/sdk";

// Demo scaffolding — creates configs so this showcase can run standalone.
// In a real app, configs are created via the Console UI.
import { setupDemoConfigs, teardownDemoConfigs } from "./config_runtime_setup.js";

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
// Typed model for resolve() demonstration
// ---------------------------------------------------------------------------

/**
 * A simple model class that maps resolved config values to typed
 * properties. Pass this to resolve() or subscribe() to get a typed
 * object instead of a plain dict.
 */
class UserServiceConfig {
  database_host: string;
  database_port: number;
  pool_size: number;
  cache_ttl_seconds: number;
  enable_signup: boolean;
  pagination_default_page_size: number;

  constructor(data: Record<string, unknown>) {
    this.database_host = data.database_host as string;
    this.database_port = data.database_port as number;
    this.pool_size = data.pool_size as number;
    this.cache_ttl_seconds = data.cache_ttl_seconds as number;
    this.enable_signup = data.enable_signup as boolean;
    this.pagination_default_page_size = data.pagination_default_page_size as number;
  }
}

async function main(): Promise<void> {
  // ======================================================================
  // 1. SDK INITIALIZATION + SETUP
  // ======================================================================
  section("1. SDK Initialization + Setup");

  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  step("SmplClient initialized (environment=production)");

  // Create demo configs (normally done via Console UI).
  console.log("  Setting up demo configs...");
  const demo = await setupDemoConfigs(client);
  console.log("  Demo configs ready.\n");

  // ======================================================================
  // 2. RESOLVE — Flat Dict
  // ======================================================================
  //
  // resolve() fetches all configs, walks the parent chain, applies
  // environment overrides, and returns a flat dict of resolved values.
  //
  // The first call initializes the config cache. Subsequent calls use
  // the cache and return instantly.
  // ======================================================================

  section("2. Resolve — Flat Dict");

  const values = await client.config.resolve("user-service");
  step(`Resolved user-service: ${JSON.stringify(values)}`);
  step(`  database_host = ${values.database_host}`);
  step(`  pool_size = ${values.pool_size}`);
  step(`  cache_ttl_seconds = ${values.cache_ttl_seconds}`);
  step(`  max_retries = ${values.max_retries} (inherited from common)`);
  step(`  app_name = ${values.app_name} (inherited from common)`);

  // ======================================================================
  // 3. RESOLVE — Typed Model
  // ======================================================================
  //
  // Pass a class constructor as the second argument. The class receives
  // the resolved dict and maps it to typed properties.
  // ======================================================================

  section("3. Resolve — Typed Model");

  const typed = await client.config.resolve("user-service", UserServiceConfig);
  step(`Typed resolve: database_host=${typed.database_host}`);
  step(`  pool_size=${typed.pool_size} (type: ${typeof typed.pool_size})`);
  step(`  cache_ttl_seconds=${typed.cache_ttl_seconds} (type: ${typeof typed.cache_ttl_seconds})`);
  step(`  enable_signup=${typed.enable_signup} (type: ${typeof typed.enable_signup})`);

  // ======================================================================
  // 4. SUBSCRIBE — Live Proxy
  // ======================================================================
  //
  // subscribe() returns a LiveConfigProxy — an ES6 Proxy that delegates
  // property reads to the live cache. When the cache updates (via
  // WebSocket or manual refresh), subsequent reads automatically reflect
  // the new values. No polling, no callbacks needed for reads.
  // ======================================================================

  section("4. Subscribe — Live Proxy");

  const proxy = await client.config.subscribe("user-service");

  // Property reads go through the proxy to the live cache
  step(`proxy.database_host = ${(proxy as Record<string, unknown>).database_host}`);
  step(`proxy.pool_size = ${(proxy as Record<string, unknown>).pool_size}`);
  step(`proxy.cache_ttl_seconds = ${(proxy as Record<string, unknown>).cache_ttl_seconds}`);

  // You can also subscribe with a model class for typed access
  const typedProxy = await client.config.subscribe("user-service", UserServiceConfig);
  step(`typedProxy.pool_size = ${typedProxy.pool_size} (type: ${typeof typedProxy.pool_size})`);

  // ======================================================================
  // 5. CHANGE LISTENERS — Three Levels
  // ======================================================================
  //
  // onChange supports three scoping levels:
  //
  //   1. Global:       onChange(callback)
  //   2. Config-scoped: onChange(configKey, callback)
  //   3. Item-scoped:   onChange(configKey, itemKey, callback)
  //
  // Listeners fire when the config cache is updated (via refresh() or
  // WebSocket push).
  // ======================================================================

  // ------------------------------------------------------------------
  // 5a. Global Listener — fires for ANY config change
  // ------------------------------------------------------------------
  section("5a. Global Change Listener");

  const globalChanges: unknown[] = [];
  client.config.onChange((event) => {
    globalChanges.push(event);
    console.log(
      `    [GLOBAL] ${event.configKey}.${event.itemKey}: ${JSON.stringify(event.oldValue)} → ${JSON.stringify(event.newValue)}`,
    );
  });
  step("Global change listener registered");

  // ------------------------------------------------------------------
  // 5b. Config-Scoped Listener — fires only for common config changes
  // ------------------------------------------------------------------
  section("5b. Config-Scoped Change Listener");

  const commonChanges: unknown[] = [];
  client.config.onChange("common", (event) => {
    commonChanges.push(event);
    console.log(
      `    [COMMON] ${event.itemKey}: ${JSON.stringify(event.oldValue)} → ${JSON.stringify(event.newValue)}`,
    );
  });
  step("Config-scoped listener registered for 'common'");

  // ------------------------------------------------------------------
  // 5c. Item-Scoped Listener — fires only for max_retries on common
  // ------------------------------------------------------------------
  section("5c. Item-Scoped Change Listener");

  const retriesChanges: unknown[] = [];
  client.config.onChange("common", "max_retries", (event) => {
    retriesChanges.push(event);
    console.log(
      `    [RETRIES] max_retries: ${JSON.stringify(event.oldValue)} → ${JSON.stringify(event.newValue)}`,
    );
  });
  step("Item-scoped listener registered for common.max_retries");

  // ======================================================================
  // 6. REFRESH — Manual Cache Update
  // ======================================================================
  //
  // refresh() re-fetches all configs, re-resolves values, and fires
  // change listeners for any values that differ from the previous cache.
  //
  // In production, WebSocket events trigger refresh automatically. This
  // manual call is for demos, scripts, and edge cases.
  // ======================================================================

  section("6. Refresh After Management Change");

  // Simulate a management-side change
  demo.common.items = { ...demo.common.items, max_retries: 7 };
  demo.common.environments = {
    ...demo.common.environments,
    production: { values: { max_retries: 7, request_timeout_ms: 10000 } },
  };
  await demo.common.save();
  step("Updated max_retries to 7 on common (production override)");

  // Refresh the runtime cache — this detects the change and fires listeners
  await client.config.refresh();
  step("client.config.refresh() completed");

  // Verify the proxy reflects the new value
  const newRetries = (proxy as Record<string, unknown>).max_retries;
  step(`proxy.max_retries after refresh = ${newRetries}`);

  step(`Global changes received: ${globalChanges.length}`);
  step(`Common-scoped changes received: ${commonChanges.length}`);
  step(`Retries-specific changes received: ${retriesChanges.length}`);

  // ======================================================================
  // 7. CLEANUP
  // ======================================================================
  section("7. Cleanup");

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
process.exit(0);
