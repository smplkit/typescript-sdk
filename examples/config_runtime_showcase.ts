/**
 * Demonstrates the smplkit runtime SDK for Smpl Config.
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
 *   tsx examples/config_runtime_showcase.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { strict as assert } from "node:assert";
import { setTimeout as sleep } from "node:timers/promises";

import { SmplClient } from "../src/index.js";
import type { ConfigChangeEvent } from "../src/index.js";
import { cleanupRuntimeShowcase, setupRuntimeShowcase } from "./setup/config_runtime_setup.js";

class Database {
  host!: string;
  port!: number;
  name!: string;
  pool_size!: number;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

class CommonConfig {
  app_name?: string | null = null;
  support_email?: string | null = null;
  max_retries: number = 3;
  request_timeout_ms: number = 5000;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

class UserServiceConfig extends CommonConfig {
  database!: Database;
  cache_ttl_seconds!: number;
  enable_signup!: boolean;
  pagination_default_page_size!: number;

  constructor(data: any) {
    super(data);
    this.database = new Database(data.database ?? {});
    this.cache_ttl_seconds = data.cache_ttl_seconds;
    this.enable_signup = data.enable_signup;
    this.pagination_default_page_size = data.pagination_default_page_size;
  }
}

async function main(): Promise<void> {
  // create the client (TypeScript has a single Promise-based client)
  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  try {
    await setupRuntimeShowcase(client.manage);
    // Wait until the runtime is ready (see SmplClient.waitUntilReady on Python).
    await client.config.refresh();

    // get a config as a plain dict
    const userSvcConfigDict = await client.config.get("showcase-user-service");
    console.log(`Total resolved keys: ${Object.keys(userSvcConfigDict).length}`);
    console.log(`database.host = ${userSvcConfigDict.get("database.host")}`);
    console.log(`max_retries = ${userSvcConfigDict.get("max_retries")}`);
    console.log(`cache_ttl_seconds = ${userSvcConfigDict.get("cache_ttl_seconds")}`);
    console.log(
      `pagination_default_page_size = ${userSvcConfigDict.get("pagination_default_page_size")}`,
    );
    console.log(`enable_signup = ${userSvcConfigDict.get("enable_signup")}`);
    console.log(`nonexistent_key = ${userSvcConfigDict.get("nonexistent_key")}`);

    // production overrides resolve through the inheritance chain
    assert.equal(userSvcConfigDict.get("database.host"), "prod-users-rds.internal.acme.dev");
    assert.equal(userSvcConfigDict.get("nonexistent_key"), undefined);

    // get a config as a typed model
    const userSvcConfig = await client.config.get("showcase-user-service", UserServiceConfig);
    console.log(`cfg.database.host = ${userSvcConfig.database.host}`);
    console.log(`cfg.database.pool_size = ${userSvcConfig.database.pool_size}`);
    console.log(`cfg.cache_ttl_seconds = ${userSvcConfig.cache_ttl_seconds}`);
    console.log(`cfg.enable_signup = ${userSvcConfig.enable_signup}`);
    console.log(`cfg.max_retries = ${userSvcConfig.max_retries}`);
    console.log(`cfg.app_name = ${userSvcConfig.app_name}`);

    assert.ok(userSvcConfig.database instanceof Database);
    assert.equal(userSvcConfig.max_retries, 5);
    assert.equal(userSvcConfig.app_name, "Acme SaaS Platform");

    const changes: ConfigChangeEvent[] = [];
    const retriesChanges: ConfigChangeEvent[] = [];

    // global listener — fires when ANY config item changes
    client.config.onChange((event) => {
      changes.push(event);
      console.log(
        `    [CHANGE] ${event.configId}.${event.itemKey}: ` +
          `${JSON.stringify(event.oldValue)} -> ${JSON.stringify(event.newValue)}`,
      );
    });

    // item-scoped listener via the live-proxy handle
    const commonCfg = await client.config.get("showcase-common");

    commonCfg.onChange("max_retries", (event) => {
      retriesChanges.push(event);
    });

    // simulate someone making a change to trigger listeners
    await updateMaxRetries(client, 7);

    // wait a moment for the event to be delivered
    await sleep(200);

    // userSvcConfig always reflects the latest values
    console.log(`max_retries after update = ${userSvcConfig.max_retries}`);
    console.log(`Global changes received: ${changes.length}`);
    console.log(`Retries-specific changes received: ${retriesChanges.length}`);

    assert.equal(userSvcConfig.max_retries, 7);
    assert.ok(changes.length >= 1);
    assert.ok(retriesChanges.length >= 1);

    await cleanupRuntimeShowcase(client.manage);
    console.log("Done!");
  } finally {
    client.close();
  }
}

async function updateMaxRetries(client: SmplClient, maxRetries: number): Promise<void> {
  const commonCfg = await client.manage.config.get("showcase-common");
  commonCfg.setNumber("max_retries", maxRetries, { environment: "production" });
  await commonCfg.save();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
