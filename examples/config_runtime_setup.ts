/**
 * Demo setup helper for the config runtime showcase.
 *
 * Creates and configures demo configs so the runtime showcase can run
 * standalone.  Imported by `config_runtime_showcase.ts`.
 */

import { SmplClient } from "@smplkit/sdk";
import type { Config } from "@smplkit/sdk";

/**
 * Create and configure demo configs for the runtime showcase.
 *
 * Creates: common (updated), user-service, auth-module (child of user-service).
 * Returns `{ configs: [userService, authModule], common }` for cleanup.
 */
export async function setupDemoConfigs(
  client: SmplClient,
): Promise<{ configs: Config[]; common: Config }> {
  // Pre-cleanup: delete any configs left over from a previous run.
  // Children must be deleted before parents.
  for (const id of ["auth_module", "user_service"]) {
    try { await client.config.management.delete(id); } catch { /* not present — ignore */ }
  }

  // 1. Update the common config with base values + environment overrides
  const common = await client.config.management.get("common");
  common.description = "Organization-wide shared configuration";
  common.items = {
    app_name: "Acme SaaS Platform",
    support_email: "support@acme.dev",
    max_retries: 3,
    request_timeout_ms: 5000,
    pagination_default_page_size: 25,
  };
  common.environments = {
    production: { values: { max_retries: 5, request_timeout_ms: 10000 } },
    staging: { values: { max_retries: 2 } },
  };
  await common.save();

  // 2. Create user-service config
  const userService = client.config.management.new("user_service", {
    name: "User Service",
    description: "Configuration for the user microservice.",
  });
  userService.items = {
    database_host: "localhost",
    database_port: 5432,
    pool_size: 5,
    cache_ttl_seconds: 300,
    enable_signup: true,
    pagination_default_page_size: 50,
  };
  userService.environments = {
    production: {
      values: {
        database_host: "prod-users-rds.internal.acme.dev",
        pool_size: 20,
        cache_ttl_seconds: 600,
        enable_signup: false,
      },
    },
  };
  await userService.save();

  // 3. Create auth-module config as child of user-service
  const authModule = client.config.management.new("auth_module", {
    name: "Auth Module",
    description: "Authentication module within the user service.",
  });
  authModule.parent = userService.id;
  authModule.items = { session_ttl_minutes: 60, mfa_enabled: false };
  authModule.environments = {
    production: { values: { session_ttl_minutes: 30, mfa_enabled: true } },
  };
  await authModule.save();

  return { configs: [userService, authModule], common };
}

/**
 * Delete the demo configs created by setupDemoConfigs and reset common.
 */
export async function teardownDemoConfigs(
  client: SmplClient,
  demo: { configs: Config[]; common: Config },
): Promise<void> {
  // Delete child configs (order matters — children before parents)
  for (const cfg of demo.configs.reverse()) {
    try {
      await client.config.management.delete(cfg.id);
    } catch {
      // ignore
    }
  }

  // Reset common config to empty.
  try {
    demo.common.description = "";
    demo.common.items = {};
    demo.common.environments = {};
    await demo.common.save();
  } catch {
    // ignore
  }
}
