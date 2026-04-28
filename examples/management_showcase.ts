/**
 * Smpl Management SDK Showcase
 * =============================
 *
 * Demonstrates `client.management.*` — the management plane for
 * app-service-owned resources that are not tied to a specific microservice:
 * environments, contexts, context types, and per-account settings.
 *
 * For runtime experiences (resolving configs, evaluating flags, controlling
 * log levels) see the per-service runtime showcases.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *       - SMPLKIT_API_KEY environment variable
 *       - ~/.smplkit configuration file (see SDK docs)
 *   - The smplkit app service running and reachable
 *
 * Usage:
 *   npx tsx examples/management_showcase.ts
 */

import { SmplClient, Context, EnvironmentClassification } from "@smplkit/sdk";

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

  const client = new SmplClient({
    environment: "production",
    service: "management-showcase",
  });
  step("SmplClient initialized (environment=production)");

  // Best-effort cleanup of leftovers from previous runs.
  for (const envId of ["ts_preview"]) {
    try { await client.management.environments.delete(envId); } catch { /* not present — ignore */ }
  }
  for (const ctId of ["user", "account", "device"]) {
    try { await client.management.context_types.delete(ctId); } catch { /* not present — ignore */ }
  }

  // ======================================================================
  // 2. ENVIRONMENTS — client.management.environments
  // ======================================================================
  //
  // Active record: new() / save() / get(id) / list() / delete(id).
  // Built-ins (production/staging/development) ship STANDARD;
  // add AD_HOC for transient targets like preview branches.
  // ======================================================================

  section("2a. List built-in environments");

  const envs = await client.management.environments.list();
  for (const e of envs) {
    step(`id=${e.id} name=${e.name} classification=${e.classification}`);
  }

  section("2b. Create an AD_HOC environment");

  const preview = client.management.environments.new("ts_preview", {
    name: "Preview — Acme branch",
    color: "#8b5cf6",
  });
  await preview.save();
  step(`Created: id=${preview.id}`);

  section("2c. Update an environment in place");

  const prod = await client.management.environments.get("production");
  prod.color = "#ef4444";
  await prod.save();
  step(`Updated: id=${prod.id} color=${prod.color}`);

  // ======================================================================
  // 3. CONTEXT TYPES — client.management.context_types
  // ======================================================================
  //
  // Targeting-rule entity schemas. Use addAttribute / removeAttribute /
  // updateAttribute — never by reassigning the dict — so the diff against
  // the server stays clean.
  // ======================================================================

  section("3a. Create context types");

  const userCt = client.management.context_types.new("user", { name: "User" });
  userCt.addAttribute("plan");
  userCt.addAttribute("region");
  userCt.addAttribute("beta_tester");
  userCt.addAttribute("signup_date");
  userCt.addAttribute("account_age_days");
  await userCt.save();
  step(`user: attributes=${Object.keys(userCt.attributes).join(", ")}`);

  const accountCt = client.management.context_types.new("account", { name: "Account" });
  for (const attr of ["tier", "industry", "region", "employee_count", "annual_revenue"]) {
    accountCt.addAttribute(attr);
  }
  await accountCt.save();

  const deviceCt = client.management.context_types.new("device", { name: "Device" });
  for (const attr of ["os", "version", "type"]) {
    deviceCt.addAttribute(attr);
  }
  await deviceCt.save();
  step("account, device created");

  section("3b. List + mutate an existing context type");

  const ctList = await client.management.context_types.list();
  for (const t of ctList) {
    step(`id=${t.id} name=${t.name}`);
  }

  const existing = await client.management.context_types.get("user");
  existing.addAttribute("lifetime_value");
  existing.removeAttribute("account_age_days");
  await existing.save();
  step(`user attributes now: ${Object.keys(existing.attributes).join(", ")}`);

  // ======================================================================
  // 4. CONTEXTS — client.management.contexts
  // ======================================================================
  //
  // Write side: register(items, { flush: false }). flush=false (default)
  // buffers for background flush — right for high-frequency runtime
  // observation. flush=true awaits the round-trip — right for IaC scripts.
  //
  // Read side: list(type), get(id), delete(id). id is the colon-delimited
  // "type:key" form; get(type, key) and delete(type, key) also accepted.
  // ======================================================================

  section("4a. Register contexts (immediate flush)");

  await client.management.contexts.register(
    [
      new Context("user", "usr_a1b2c3", { plan: "free", region: "us" }),
      new Context("user", "usr_d4e5f6", { plan: "enterprise", region: "eu" }),
      new Context("account", "acct_acme_inc", { tier: "enterprise", industry: "retail" }),
    ],
    { flush: true },
  );
  step("3 contexts registered + flushed");

  section("4b. List contexts of a single type");

  for (const c of await client.management.contexts.list("user")) {
    step(`  type=${c.type} key=${c.key} attributes=${JSON.stringify(c.attributes)}`);
  }

  section("4c. Get + delete by composite id (or by (type, key))");

  const one = await client.management.contexts.get("user:usr_a1b2c3");
  step(`got: ${one.type}:${one.key}`);

  const same = await client.management.contexts.get("user", "usr_a1b2c3");
  step(`got via (type, key): ${same.type}:${same.key}`);

  await client.management.contexts.delete("user:usr_a1b2c3");
  step("deleted user:usr_a1b2c3");

  // ======================================================================
  // 5. ACCOUNT SETTINGS — client.management.account_settings
  // ======================================================================
  //
  // Wire format is opaque JSON. The SDK exposes typed properties for
  // documented keys; unknown keys are preserved through .raw.
  // ======================================================================

  section("5a. Read settings");

  const settings = await client.management.account_settings.get();
  step(`environmentOrder=${JSON.stringify(settings.environmentOrder)}`);
  step(`raw=${JSON.stringify(settings.raw)}`);

  section("5b. Mutate + save (active record)");

  settings.environmentOrder = ["production", "staging", "development"];
  await settings.save();
  step(`saved: environmentOrder=${JSON.stringify(settings.environmentOrder)}`);

  // ======================================================================
  // 6. CLEANUP
  // ======================================================================
  section("6. Cleanup");

  for (const c of await client.management.contexts.list("user")) {
    await client.management.contexts.delete(c.type, c.key);
  }
  for (const c of await client.management.contexts.list("account")) {
    await client.management.contexts.delete(c.type, c.key);
  }

  for (const ctId of ["user", "account", "device"]) {
    try { await client.management.context_types.delete(ctId); } catch { /* ignore */ }
  }

  try { await client.management.environments.delete("ts_preview"); } catch { /* ignore */ }

  client.close();
  step("SmplClient closed");

  section("ALL DONE");
  console.log("  The Management showcase completed successfully.");
  console.log("  All resources have been cleaned up.\n");
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
