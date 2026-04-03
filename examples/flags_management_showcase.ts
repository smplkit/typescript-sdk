/**
 * Smpl Flags SDK Showcase — Management API
 * ==========================================
 *
 * Demonstrates the smplkit TypeScript SDK's management plane for Smpl Flags:
 *
 * - Client initialization
 * - Creating flags (BOOLEAN, STRING, NUMERIC, JSON) via FlagType
 * - Rule builder: fluent API for constructing JSON Logic rules
 * - Configuring values, environments, and rules
 * - Convenience methods (addRule)
 * - Updating flag definitions
 * - Listing and inspecting flags
 * - Deleting flags
 * - Managing context types
 *
 * Most customers will create and configure flags via the Console UI.
 * This showcase demonstrates the programmatic equivalent — useful for
 * infrastructure-as-code, CI/CD pipelines, setup scripts, and automated
 * testing.
 *
 * For the runtime evaluation experience (declaring flags in code,
 * evaluating them, context providers, caching, live updates), see
 * `flags_runtime_showcase.ts`.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key (set via `SMPLKIT_API_KEY` env var)
 *   - The smplkit Flags service running and reachable
 *   - At least two environments configured (e.g., `staging`, `production`)
 *
 * Usage:
 *   export SMPLKIT_API_KEY="sk_api_..."
 *   npx tsx examples/flags_management_showcase.ts
 */

import { SmplClient, Rule } from "@smplkit/sdk";
import type { FlagType } from "@smplkit/sdk";

// ---------------------------------------------------------------------------
// Configuration — set your API key via the SMPLKIT_API_KEY env var
// ---------------------------------------------------------------------------

const API_KEY = process.env.SMPLKIT_API_KEY ?? "";

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
  // 1. SDK INITIALIZATION
  // ======================================================================
  section("1. SDK Initialization");

  const client = new SmplClient({ apiKey: API_KEY });
  step("SmplClient initialized");

  // ======================================================================
  // 2. CREATE FLAGS
  // ======================================================================
  //
  // Flags are created with a key, name, type, default value, and an
  // optional values array. The key is the first argument; everything
  // else is in the options object.
  //
  // FlagType: "BOOLEAN", "STRING", "NUMERIC", "JSON"
  //
  // For BOOLEAN flags, the values array is auto-generated if not
  // provided: [{"name": "True", "value": true}, {"name": "False", "value": false}].
  //
  // For STRING, NUMERIC, and JSON flags, the values array defines the
  // closed set of legal values the flag can serve. The default must
  // reference a value in this set.
  // ======================================================================

  // ------------------------------------------------------------------
  // 2a. BOOLEAN flag
  // ------------------------------------------------------------------
  section("2a. Create a Boolean Flag");

  const checkoutFlag = await client.flags.create("checkout-v2", {
    name: "Checkout V2",
    type: "BOOLEAN" as FlagType,
    default: false,
    description: "Controls rollout of the new checkout experience.",
  });
  step(`Created: key=${checkoutFlag.key}, type=${checkoutFlag.type}`);
  step(`  id=${checkoutFlag.id}`);
  step(`  values=${JSON.stringify(checkoutFlag.values)}`);
  step(`  default=${checkoutFlag.default}`);
  // values auto-generated: [{"name": "True", "value": true}, {"name": "False", "value": false}]

  // ------------------------------------------------------------------
  // 2b. STRING flag
  // ------------------------------------------------------------------
  section("2b. Create a String Flag");

  const bannerFlag = await client.flags.create("banner-color", {
    name: "Banner Color",
    type: "STRING" as FlagType,
    default: "red",
    description: "Controls the banner color shown to users.",
    values: [
      { name: "Red", value: "red" },
      { name: "Green", value: "green" },
      { name: "Blue", value: "blue" },
    ],
  });
  step(`Created: key=${bannerFlag.key}, type=${bannerFlag.type}`);
  step(`  values=${JSON.stringify(bannerFlag.values)}`);

  // ------------------------------------------------------------------
  // 2c. NUMERIC flag
  // ------------------------------------------------------------------
  section("2c. Create a Numeric Flag");

  const retryFlag = await client.flags.create("max-retries", {
    name: "Max Retries",
    type: "NUMERIC" as FlagType,
    default: 3,
    description: "Maximum number of API retries before failing.",
    values: [
      { name: "Low (1)", value: 1 },
      { name: "Standard (3)", value: 3 },
      { name: "High (5)", value: 5 },
      { name: "Aggressive (10)", value: 10 },
    ],
  });
  step(`Created: key=${retryFlag.key}, type=${retryFlag.type}`);

  // ------------------------------------------------------------------
  // 2d. JSON flag
  // ------------------------------------------------------------------
  section("2d. Create a JSON Flag");

  const themeFlag = await client.flags.create("ui-theme", {
    name: "UI Theme",
    type: "JSON" as FlagType,
    default: { mode: "light", accent: "#0066cc" },
    description: "Controls the UI theme configuration.",
    values: [
      { name: "Light", value: { mode: "light", accent: "#0066cc" } },
      { name: "Dark", value: { mode: "dark", accent: "#66ccff" } },
      { name: "High Contrast", value: { mode: "dark", accent: "#ffffff" } },
    ],
  });
  step(`Created: key=${themeFlag.key}, type=${themeFlag.type}`);

  // ======================================================================
  // 3. CONFIGURE ENVIRONMENTS AND RULES
  // ======================================================================
  //
  // Each flag can be independently configured per environment. An
  // environment entry includes:
  //   - enabled (bool): whether rules are evaluated
  //   - default (optional): environment-level override of the flag default
  //   - rules (array): ordered list of rules (first match wins)
  //
  // Rules can be built using the Rule builder (recommended) or as raw
  // JSON Logic dicts. The Rule builder provides a fluent API:
  //
  //   new Rule("description")
  //       .when("user.plan", "==", "enterprise")
  //       .serve(true)
  //       .build()
  //
  // Multiple .when() calls are AND'd. .serve() sets the value.
  // .build() finalizes the rule as a dict ready for the API.
  // .environment() is optional — used with addRule (see section 5).
  //
  // Supported operators: ==, !=, >, <, >=, <=, in, contains
  // ======================================================================

  // ------------------------------------------------------------------
  // 3a. Configure checkout-v2 environments
  // ------------------------------------------------------------------
  section("3a. Configure checkout-v2 Environments");

  await checkoutFlag.update({
    environments: {
      staging: {
        enabled: true,
        rules: [
          new Rule("Enable for enterprise users in US region")
            .when("user.plan", "==", "enterprise")
            .when("account.region", "==", "us")
            .serve(true)
            .build(),
          new Rule("Enable for beta testers")
            .when("user.beta_tester", "==", true)
            .serve(true)
            .build(),
        ],
      },
      production: {
        enabled: false,
        default: false,
        rules: [],
      },
    },
  });
  step("staging: enabled with 2 targeting rules");
  step("production: disabled, default=false");

  // ------------------------------------------------------------------
  // 3b. Configure banner-color environments
  // ------------------------------------------------------------------
  section("3b. Configure banner-color Environments");

  await bannerFlag.update({
    environments: {
      staging: {
        enabled: true,
        rules: [
          new Rule("Blue for enterprise users")
            .when("user.plan", "==", "enterprise")
            .serve("blue")
            .build(),
          new Rule("Green for technology companies")
            .when("account.industry", "==", "technology")
            .serve("green")
            .build(),
        ],
      },
      production: {
        enabled: true,
        default: "blue",
        rules: [],
      },
    },
  });
  step("staging: enabled with 2 rules");
  step("production: enabled, no rules, default override = blue");

  // ------------------------------------------------------------------
  // 3c. Configure max-retries environments
  // ------------------------------------------------------------------
  section("3c. Configure max-retries Environments");

  await retryFlag.update({
    environments: {
      staging: {
        enabled: true,
        rules: [
          new Rule("High retries for large accounts")
            .when("account.employee_count", ">", 100)
            .serve(5)
            .build(),
        ],
      },
      production: {
        enabled: true,
        rules: [],
      },
    },
  });
  step("staging: enabled with 1 rule");
  step("production: enabled, no rules");

  // ======================================================================
  // 4. INSPECT AND LIST FLAGS
  // ======================================================================

  section("4. List and Inspect Flags");

  // List all flags.
  const flags = await client.flags.list();
  step(`Total flags: ${flags.length}`);
  for (const f of flags) {
    const envKeys = f.environments ? Object.keys(f.environments) : [];
    step(`  ${f.key} (${f.type}) — default=${JSON.stringify(f.default)}, environments=${JSON.stringify(envKeys)}`);
  }

  // Fetch a single flag by ID.
  const fetched = await client.flags.get(checkoutFlag.id);
  step(`\nFetched by ID: ${fetched.key}`);
  step(`  staging rules: ${(fetched.environments?.staging?.rules ?? []).length}`);
  step(`  production enabled: ${fetched.environments?.production?.enabled}`);

  // ======================================================================
  // 5. UPDATE A FLAG
  // ======================================================================

  section("5. Update a Flag");

  // Add a new value to banner-color.
  step("Adding 'Purple' to banner-color values...");
  const currentValues = [...bannerFlag.values];
  currentValues.push({ name: "Purple", value: "purple" });
  await bannerFlag.update({ values: currentValues });
  step(`Updated values: ${JSON.stringify(bannerFlag.values.map((v) => v.name))}`);

  // Change the flag-level default.
  step("Changing banner-color default to 'blue'...");
  await bannerFlag.update({ default: "blue" });
  step(`Updated default: ${bannerFlag.default}`);

  // Add a rule to an existing environment — the hard way (raw JSON Logic).
  // You have to fetch current state, build the dict, append, and send
  // the whole environments object.
  step("Adding a rule to banner-color production (raw JSON Logic)...");
  const currentEnvs = { ...(bannerFlag.environments ?? {}) };
  const prod = { ...(currentEnvs.production ?? { enabled: true, rules: [] }) };
  const prodRules = [...(prod.rules ?? [])];
  prodRules.push({
    description: "Purple for enterprise users",
    logic: { "==": [{ var: "user.plan" }, "enterprise"] },
    value: "purple",
  });
  prod.rules = prodRules;
  currentEnvs.production = prod;
  await bannerFlag.update({ environments: currentEnvs });
  step(`Production now has ${prodRules.length} rule(s)`);

  // Add a rule — the easy way. addRule takes a single built Rule.
  // The Rule's .environment() tells addRule where to insert it.
  step("Adding another rule to banner-color production (addRule + Rule)...");
  await bannerFlag.addRule(
    new Rule("Green for retail companies")
      .environment("production")
      .when("account.industry", "==", "retail")
      .serve("green")
      .build(),
  );
  step("Rule added — no manual environment juggling, no raw JSON Logic");

  // Verify both rules are there.
  const refreshed = await client.flags.get(bannerFlag.id);
  const refreshedProdRules = refreshed.environments?.production?.rules ?? [];
  step(`Production rules after both additions: ${refreshedProdRules.length}`);
  for (let i = 0; i < refreshedProdRules.length; i++) {
    step(`  [${i}] ${refreshedProdRules[i].description ?? "no description"}`);
  }

  // ======================================================================
  // 6. CONTEXT TYPE MANAGEMENT
  // ======================================================================
  //
  // Context types define the shape of data that rules can target. They
  // are typically auto-created by the SDK during runtime context
  // registration, but can also be managed explicitly via the API —
  // useful for setting up the Console rule builder before any SDK is
  // deployed.
  // ======================================================================

  section("6. Context Type Management");

  // Create context types that the Console rule builder will use.
  const userCt = await client.flags.createContextType("user", {
    name: "User",
  });
  step(`Created context type: key=${userCt.key}, name=${userCt.name}`);

  // Add known attributes.
  await client.flags.updateContextType(userCt.id, {
    attributes: {
      first_name: {},
      plan: {},
      beta_tester: {},
    },
  });
  step(`Added attributes: ${JSON.stringify(Object.keys(userCt.attributes))}`);

  const accountCt = await client.flags.createContextType("account", {
    name: "Account",
  });
  await client.flags.updateContextType(accountCt.id, {
    attributes: {
      industry: {},
      region: {},
      employee_count: {},
    },
  });
  step(`Created context type: key=${accountCt.key}`);

  // List context types.
  const contextTypes = await client.flags.listContextTypes();
  for (const ct of contextTypes) {
    const attrs = ct.attributes ? Object.keys(ct.attributes) : [];
    step(`  ${ct.key}: attributes=${JSON.stringify(attrs)}`);
  }

  // ======================================================================
  // 7. CLEANUP
  // ======================================================================
  section("7. Cleanup");

  // Delete flags.
  for (const flag of [checkoutFlag, bannerFlag, retryFlag, themeFlag]) {
    await client.flags.delete(flag.id);
    step(`Deleted flag: ${flag.key}`);
  }

  // Delete context types.
  for (const ct of [userCt, accountCt]) {
    await client.flags.deleteContextType(ct.id);
    step(`Deleted context type: ${ct.key}`);
  }

  // Close the client.
  client.close();
  step("SmplClient closed");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Flags Management showcase completed successfully.");
  console.log("  All flags and context types have been cleaned up.\n");
}

main().catch(console.error);
