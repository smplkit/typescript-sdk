/** Setup / cleanup helpers for `config_runtime_showcase.ts`. */

import { SmplManagementClient, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_ENVIRONMENTS = ["staging", "production"];
const DEMO_CONFIG_IDS = ["showcase-user-service", "showcase-auth-module", "showcase-common"];

export async function setupRuntimeShowcase(manage: SmplManagementClient): Promise<void> {
  const existing = new Set((await manage.environments.list()).map((env) => env.id));
  for (const envId of DEMO_ENVIRONMENTS) {
    if (!existing.has(envId)) {
      await manage.environments
        .new(envId, { name: envId.charAt(0).toUpperCase() + envId.slice(1) })
        .save();
    }
  }
  await cleanupRuntimeShowcase(manage);

  const shared = manage.config.new("showcase-common", {
    name: "Showcase Common",
    description: "Showcase-only shared configuration.",
  });
  shared.setString("app_name", "Acme SaaS Platform");
  shared.setString("support_email", "support@acme.dev");
  shared.setNumber("max_retries", 3);
  shared.setNumber("request_timeout_ms", 5000);
  shared.setNumber("pagination_default_page_size", 25);
  shared.setNumber("max_retries", 5, { environment: "production" });
  shared.setNumber("request_timeout_ms", 10000, { environment: "production" });
  shared.setNumber("max_retries", 2, { environment: "staging" });
  await shared.save();

  const userService = manage.config.new("showcase-user-service", {
    name: "Showcase User Service",
    description: "Configuration for the user microservice.",
    parent: shared,
  });
  userService.setString("database.host", "localhost");
  userService.setNumber("database.port", 5432);
  userService.setString("database.name", "users_dev");
  userService.setNumber("database.pool_size", 5);
  userService.setNumber("cache_ttl_seconds", 300);
  userService.setBoolean("enable_signup", true);
  userService.setNumber("pagination_default_page_size", 50);
  userService.setString("database.host", "prod-users-rds.internal.acme.dev", {
    environment: "production",
  });
  userService.setString("database.name", "users_prod", { environment: "production" });
  userService.setNumber("database.pool_size", 20, { environment: "production" });
  userService.setNumber("cache_ttl_seconds", 600, { environment: "production" });
  userService.setBoolean("enable_signup", false, { environment: "production" });
  await userService.save();

  const authModule = manage.config.new("showcase-auth-module", {
    name: "Showcase Auth Module",
    description: "Authentication module within the user service.",
    parent: shared,
  });
  authModule.setNumber("session_ttl_minutes", 60);
  authModule.setBoolean("mfa_enabled", false);
  authModule.setNumber("session_ttl_minutes", 30, { environment: "production" });
  authModule.setBoolean("mfa_enabled", true, { environment: "production" });
  await authModule.save();
}

export async function cleanupRuntimeShowcase(manage: SmplManagementClient): Promise<void> {
  for (const configId of DEMO_CONFIG_IDS) {
    try {
      await manage.config.delete(configId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
