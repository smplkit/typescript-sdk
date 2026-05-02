/**
 * Demonstrates the smplkit management SDK for Smpl Config.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *   - The smplkit Config service running and reachable
 *
 * Usage:
 *
 *   tsx examples/config_management_showcase.ts
 */

import { SmplManagementClient } from "../src/index.js";
import {
  cleanupManagementShowcase,
  setupManagementShowcase,
} from "./setup/config_management_setup.js";

async function main(): Promise<void> {
  // create the client (TypeScript has a single Promise-based client)
  const manage = new SmplManagementClient();
  try {
    await setupManagementShowcase(manage);

    // create a "parent" configuration that all other configs inherit from
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
    console.log(`Created config: ${shared.id}`);

    // create a config (inherits from showcase-common)
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
    await userService.save();

    // update a config
    userService.setString("database.host", "prod-users-rds.internal.acme.dev", {
      environment: "production",
    });
    userService.setString("database.name", "users_prod", { environment: "production" });
    userService.setNumber("database.pool_size", 20, { environment: "production" });
    userService.setNumber("cache_ttl_seconds", 600, { environment: "production" });
    userService.setBoolean("enable_signup", false, { environment: "production" });
    await userService.save();
    console.log(`Updated config: ${userService.id}`);

    // list configs
    const configs = await manage.config.list();
    for (const cfg of configs) {
      const parentInfo = cfg.parent ? ` (parent: ${cfg.parent})` : " (root)";
      console.log(`  ${cfg.id}${parentInfo}`);
    }

    // get a config
    const fetched = await manage.config.get("showcase-user-service");
    console.log(`Fetched: id=${fetched.id}, name=${fetched.name}`);
    console.log(`  description=${fetched.description}`);
    console.log(`  parent=${fetched.parent ?? "(none)"}`);
    console.log(`  items: ${Object.keys(fetched.items).join(", ")}`);

    // delete configs
    await userService.delete();
    await shared.delete();
    console.log("Deleted configs");

    // cleanup
    await cleanupManagementShowcase(manage);
    console.log("Done!");
  } finally {
    await manage.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
