/**
 * Smpl Config SDK Showcase — Management API
 * ============================================
 *
 * Demonstrates the smplkit TypeScript SDK's management plane for Smpl Config:
 *
 * - Client initialization (`SmplClient`)
 * - Factory method: `client.config.new()` for unsaved configs
 * - Direct mutation of items, environments, and metadata
 * - Persist via `save()` (POST if new, PUT if existing)
 * - Fetch by key: `client.config.get()`
 * - List all configs: `client.config.list()`
 * - Delete by key: `client.config.delete()`
 * - Multi-level inheritance via parent configs
 *
 * Most customers will create and configure configs via the Console UI.
 * This showcase demonstrates the programmatic equivalent — useful for
 * infrastructure-as-code, CI/CD pipelines, setup scripts, and automated
 * testing.
 *
 * For the runtime experience (resolve, subscribe, live proxy, change
 * listeners), see `config_runtime_showcase.ts`.
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
  // 2. CREATE A CONFIG WITH new() + MUTATE + save()
  // ======================================================================
  //
  // client.config.new(key, options) creates an unsaved Config object.
  // Mutate its properties directly, then call save() to POST it to
  // the server.
  //
  // This is the recommended pattern for programmatic config creation.
  // ======================================================================

  section("2. Create a Config (new → mutate → save)");

  const paymentService = client.config.new("payment-service", {
    name: "Payment Service",
  });
  step(`Created unsaved config: key=${paymentService.key}, id=${paymentService.id}`);

  // Direct mutation — set base items
  paymentService.items = {
    timeout: 30,
    retries: 3,
    currency: "USD",
    gateway: "stripe",
  };
  step(`Set items: ${JSON.stringify(paymentService.items)}`);

  // Direct mutation — set environment overrides
  paymentService.environments = {
    production: {
      values: {
        timeout: 60,
        retries: 5,
        gateway: "stripe-production",
      },
    },
    staging: {
      values: {
        timeout: 15,
      },
    },
  };
  step("Set environment overrides for production and staging");

  // Persist — POST (new config, id is null)
  await paymentService.save();
  step(`Saved: id=${paymentService.id} (POST — new config)`);

  // ======================================================================
  // 3. FETCH AND UPDATE A CONFIG
  // ======================================================================

  // ------------------------------------------------------------------
  // 3a. Get Config by Key
  // ------------------------------------------------------------------
  section("3a. Get Config by Key");

  const fetched = await client.config.get("payment-service");
  step(`Fetched: key=${fetched.key}, name=${fetched.name}`);
  step(`  id: ${fetched.id}`);
  step(`  items: ${JSON.stringify(fetched.items)}`);
  step(`  environments: ${JSON.stringify(fetched.environments)}`);

  // ------------------------------------------------------------------
  // 3b. Mutate and Save (Update)
  // ------------------------------------------------------------------
  section("3b. Update via Mutate + Save");

  // Update description
  fetched.description = "Configuration for the payment processing service.";
  step(`Updated description: ${fetched.description}`);

  // Add new items while keeping existing ones
  fetched.items = {
    ...fetched.items,
    max_amount: 10000,
    enable_3ds: true,
  };
  step(`Added new items: max_amount, enable_3ds`);

  // Add environment overrides for the new items
  const currentEnvs = fetched.environments as Record<string, { values: Record<string, unknown> }>;
  fetched.environments = {
    ...currentEnvs,
    production: {
      values: {
        ...(currentEnvs.production?.values ?? {}),
        max_amount: 50000,
        enable_3ds: true,
      },
    },
  };
  step("Added production overrides for new items");

  // Persist — PUT (existing config, id is set)
  await fetched.save();
  step(`Saved: id=${fetched.id} (PUT — existing config)`);

  // ======================================================================
  // 4. LIST ALL CONFIGS
  // ======================================================================
  section("4. List All Configs");

  const configs = await client.config.list();
  step(`Total configs: ${configs.length}`);
  for (const cfg of configs) {
    const parentInfo = cfg.parent ? ` (parent: ${cfg.parent})` : " (root)";
    step(`  ${cfg.key}${parentInfo} — ${cfg.name}`);
  }

  // ======================================================================
  // 5. PARENT-CHILD CONFIG CREATION
  // ======================================================================
  //
  // Configs can have a parent, forming a hierarchy. Child configs
  // inherit items from their parent (and grandparent, up to common).
  // Environment overrides at any level take precedence.
  // ======================================================================

  section("5a. Create Parent: User Service Config");

  const userService = client.config.new("user-service", {
    name: "User Service",
    description: "Configuration for the user microservice.",
  });
  userService.items = {
    database_host: "localhost",
    database_port: 5432,
    pool_size: 5,
    cache_ttl_seconds: 300,
  };
  userService.environments = {
    production: {
      values: {
        database_host: "prod-users-rds.internal.acme.dev",
        pool_size: 20,
        cache_ttl_seconds: 600,
      },
    },
  };
  await userService.save();
  step(`Created user-service: id=${userService.id}`);

  // ------------------------------------------------------------------
  section("5b. Create Child: Auth Module (child of User Service)");

  const authModule = client.config.new("auth-module", {
    name: "Auth Module",
    description: "Authentication module within the user service.",
  });
  // Set parent to user-service — auth-module inherits its items
  authModule.parent = userService.id;
  authModule.items = {
    session_ttl_minutes: 60,
    mfa_enabled: false,
  };
  authModule.environments = {
    production: {
      values: {
        session_ttl_minutes: 30,
        mfa_enabled: true,
      },
    },
  };
  await authModule.save();
  step(`Created auth-module: id=${authModule.id}, parent=${authModule.parent}`);

  // Verify hierarchy
  const allConfigs = await client.config.list();
  for (const cfg of allConfigs) {
    if (cfg.key === "auth-module") {
      step(`  auth-module parent: ${cfg.parent}`);
    }
  }

  // ======================================================================
  // 6. DELETE CONFIGS
  // ======================================================================
  section("6. Cleanup — Delete Configs");

  // Delete child first (children must be deleted before parents)
  await client.config.delete("auth-module");
  step("Deleted auth-module");

  await client.config.delete("user-service");
  step("Deleted user-service");

  await client.config.delete("payment-service");
  step("Deleted payment-service");

  // Verify deletion
  const remaining = await client.config.list();
  step(`Remaining configs: ${remaining.length}`);

  client.close();
  step("SmplClient closed");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Config Management showcase completed successfully.");
  console.log("  All configs have been cleaned up.\n");
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
