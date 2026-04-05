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
 * Updates the common config and creates user_service + auth_module.
 * Returns `{ configs: [userService, authModule], common }` for cleanup.
 */
export async function setupDemoConfigs(
  client: SmplClient,
): Promise<{ configs: Config[]; common: Config }> {
  // 1. Update the common config with base values + environment overrides
  const common = await client.config.get({ key: "common" });
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
  await common.setValues({ max_retries: 5, request_timeout_ms: 10000 }, "production");
  await common.setValues({ max_retries: 2 }, "staging");

  // 2. Create user_service config with base values + environment overrides
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
  await userService.setValues(
    {
      database: { host: "prod-users-rds.internal.acme.dev", name: "users_prod", pool_size: 20 },
      cache_ttl_seconds: 600,
    },
    "production",
  );
  await userService.setValue("enable_signup", false, "production");

  // 3. Create auth_module config as child of user_service
  const authModule = await client.config.create({
    name: "Auth Module",
    key: "auth_module",
    description: "Authentication module within the user service.",
    parent: userService.id,
    items: { session_ttl_minutes: 60, mfa_enabled: false },
  });
  await authModule.setValues({ session_ttl_minutes: 30, mfa_enabled: true }, "production");

  return { configs: [userService, authModule], common };
}

/**
 * Delete the demo configs created by setupDemoConfigs and reset common.
 */
export async function teardownDemoConfigs(
  client: SmplClient,
  demo: { configs: Config[]; common: Config },
): Promise<void> {
  for (const cfg of demo.configs) {
    try {
      await client.config.delete(cfg.id);
    } catch {
      // ignore
    }
  }

  // Reset common config to empty.
  try {
    await demo.common.update({ description: "", items: {}, environments: {} });
  } catch {
    // ignore
  }
}
