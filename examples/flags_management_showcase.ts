/**
 * Smpl Flags SDK Showcase — Management API
 * ==========================================
 *
 * Demonstrates the smplkit TypeScript SDK's management plane for Smpl Flags:
 *
 * - Client initialization (`SmplClient`)
 * - Factory methods: newBooleanFlag, newStringFlag, newNumberFlag, newJsonFlag
 * - Saving flags (POST if new, PUT if existing)
 * - Retrieving and mutating flags: description, addRule, save
 * - Environment configuration: setEnvironmentEnabled, setEnvironmentDefault, clearRules
 * - Rule builder: fluent API for constructing JSON Logic rules
 * - Listing and inspecting flags
 * - Deleting flags by key
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
 *   - A valid smplkit API key, provided via one of:
 *       - SMPLKIT_API_KEY environment variable
 *       - ~/.smplkit configuration file (see SDK docs)
 *   - The smplkit Flags service running and reachable
 *   - At least two environments configured (e.g., `staging`, `production`)
 *
 * Usage:
 *   npx tsx examples/flags_management_showcase.ts
 */

import { SmplClient, Rule } from "@smplkit/sdk";

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

// Track all flag keys we create, for cleanup on error.
const createdFlagKeys: string[] = [];

async function main(): Promise<void> {
  // ======================================================================
  // 1. SDK INITIALIZATION
  // ======================================================================
  section("1. SDK Initialization");

  const client = new SmplClient({
    environment: "staging",
    service: "showcase-service",
  });
  step("SmplClient initialized (environment=staging)");

  try {
    // ==================================================================
    // 2. CREATE FLAGS WITH FACTORY METHODS
    // ==================================================================
    //
    // Factory methods return unsaved Flag instances. No HTTP call is
    // made until you call `.save()`. This lets you configure the flag
    // locally (add rules, set environment defaults, etc.) before
    // persisting everything in a single request.
    //
    // Each factory creates the correct typed subclass:
    //   newBooleanFlag → BooleanFlag
    //   newStringFlag  → StringFlag
    //   newNumberFlag  → NumberFlag
    //   newJsonFlag    → JsonFlag
    // ==================================================================

    // ----------------------------------------------------------------
    // 2a. Boolean flag
    // ----------------------------------------------------------------
    section("2a. Create a Boolean Flag");

    const checkoutFlag = client.flags.newBooleanFlag("checkout-v2", {
      default: false,
      description: "Controls rollout of the new checkout experience.",
    });
    step(`Unsaved: key=${checkoutFlag.key}, type=${checkoutFlag.type}, id=${checkoutFlag.id}`);
    step(`  default=${checkoutFlag.default}`);
    step(`  values=${JSON.stringify(checkoutFlag.values)}`);
    // Boolean flags auto-generate values: [True, False]

    await checkoutFlag.save();
    createdFlagKeys.push(checkoutFlag.key);
    step(`Saved: id=${checkoutFlag.id}`);

    // ----------------------------------------------------------------
    // 2b. String flag
    // ----------------------------------------------------------------
    section("2b. Create a String Flag");

    // The values parameter defines a closed set — this flag can only
    // serve "red", "green", or "blue". This makes it a constrained
    // flag. The Console UI shows dropdowns for value selection.
    const bannerFlag = client.flags.newStringFlag("banner-color", {
      default: "red",
      description: "Controls the banner color shown to users.",
      values: [
        { name: "Red", value: "red" },
        { name: "Green", value: "green" },
        { name: "Blue", value: "blue" },
      ],
    });
    step(
      `Unsaved: key=${bannerFlag.key}, values=${JSON.stringify(bannerFlag.values.map((v) => v.name))}`,
    );

    await bannerFlag.save();
    createdFlagKeys.push(bannerFlag.key);
    step(`Saved: id=${bannerFlag.id}`);

    // ----------------------------------------------------------------
    // 2c. Number flag
    // ----------------------------------------------------------------
    section("2c. Create a Number Flag — Unconstrained");

    // Unlike banner-color above, this flag has no predefined values.
    // Any number is valid as a default or rule serve-value. This is
    // useful for tunables like thresholds, retry counts, and timeouts
    // where the value space is open-ended.
    //
    // Omitting the values parameter creates an unconstrained flag.
    const retryFlag = client.flags.newNumberFlag("max-retries", {
      default: 3,
      description: "Maximum number of API retries before failing.",
    });
    step(`Unsaved: key=${retryFlag.key}, default=${retryFlag.default}`);

    await retryFlag.save();
    createdFlagKeys.push(retryFlag.key);
    step(`Saved: id=${retryFlag.id}`);

    // ----------------------------------------------------------------
    // 2d. JSON flag
    // ----------------------------------------------------------------
    section("2d. Create a JSON Flag");

    // Like banner-color, this JSON flag is constrained — only the
    // three declared theme objects can be served.
    const themeFlag = client.flags.newJsonFlag("ui-theme", {
      default: { mode: "light", accent: "#0066cc" },
      description: "Controls the UI theme configuration.",
      values: [
        { name: "Light", value: { mode: "light", accent: "#0066cc" } },
        { name: "Dark", value: { mode: "dark", accent: "#66ccff" } },
        { name: "High Contrast", value: { mode: "dark", accent: "#ffffff" } },
      ],
    });
    step(`Unsaved: key=${themeFlag.key}, default=${JSON.stringify(themeFlag.default)}`);

    await themeFlag.save();
    createdFlagKeys.push(themeFlag.key);
    step(`Saved: id=${themeFlag.id}`);

    // ==================================================================
    // 3. RETRIEVE, MUTATE, AND SAVE
    // ==================================================================
    //
    // Fetch an existing flag by key, mutate it locally, then save.
    // ==================================================================

    section("3. Retrieve, Mutate, and Save");

    const fetched = await client.flags.get("checkout-v2");
    step(`Fetched: key=${fetched.key}, id=${fetched.id}`);
    step(`  description: ${fetched.description}`);

    // Mutate the description locally.
    fetched.description = "Checkout V2 — phased rollout to enterprise users.";
    step(`  updated description: ${fetched.description}`);

    // Add a targeting rule using the fluent Rule builder.
    // addRule is a sync local mutation — no HTTP call.
    fetched.addRule(
      new Rule("Enable for enterprise users in US region")
        .environment("staging")
        .when("user.plan", "==", "enterprise")
        .when("account.region", "==", "us")
        .serve(true)
        .build(),
    );
    step("  added rule: 'Enable for enterprise users in US region' (staging)");

    // Persist all local changes in one PUT.
    await fetched.save();
    step("  save() completed — description + rule persisted");

    // ==================================================================
    // 4. ENVIRONMENT CONFIGURATION
    // ==================================================================
    //
    // Environment methods are sync local mutations. You accumulate
    // changes locally, then persist with a single save().
    //
    //   setEnvironmentEnabled(envKey, bool) — toggle evaluation
    //   setEnvironmentDefault(envKey, value) — env-level default
    //   clearRules(envKey) — remove all rules from an environment
    // ==================================================================

    section("4. Environment Configuration");

    // Enable the flag in staging.
    fetched.setEnvironmentEnabled("staging", true);
    step("staging: enabled = true");

    // Configure production: disabled with a safe default.
    fetched.setEnvironmentEnabled("production", false);
    fetched.setEnvironmentDefault("production", false);
    step("production: enabled = false, default = false");

    // Add another rule to staging.
    fetched.addRule(
      new Rule("Enable for beta testers")
        .environment("staging")
        .when("user.beta_tester", "==", true)
        .serve(true)
        .build(),
    );
    step("staging: added rule 'Enable for beta testers'");

    // Clear all rules from production (idempotent — it already has none).
    fetched.clearRules("production");
    step("production: rules cleared");

    // Persist all environment changes.
    await fetched.save();
    step("save() completed — environment config persisted");

    // Verify environment state.
    const stagingRules = fetched.environments?.staging?.rules ?? [];
    step(`staging rules count: ${stagingRules.length}`);
    for (let i = 0; i < stagingRules.length; i++) {
      step(`  [${i}] ${stagingRules[i].description}`);
    }
    step(`production enabled: ${fetched.environments?.production?.enabled}`);

    // ==================================================================
    // 5. RULE BUILDER EXAMPLES
    // ==================================================================
    //
    // The Rule builder constructs JSON Logic dicts. Here are examples
    // of various operator and combination patterns.
    // ==================================================================

    section("5. Rule Builder Examples");

    // Single condition.
    const singleCondition = new Rule("Blue for enterprise users")
      .environment("staging")
      .when("user.plan", "==", "enterprise")
      .serve("blue")
      .build();
    step(`Single condition: ${JSON.stringify(singleCondition.logic)}`);

    // Multiple conditions (AND'd).
    const multiCondition = new Rule("Enable for US enterprise with 100+ employees")
      .environment("production")
      .when("user.plan", "==", "enterprise")
      .when("account.region", "==", "us")
      .when("account.employee_count", ">", 100)
      .serve(true)
      .build();
    step(`Multi-condition (AND): ${JSON.stringify(multiCondition.logic)}`);

    // Comparison operators.
    const comparisonRule = new Rule("High retries for large accounts")
      .environment("staging")
      .when("account.employee_count", ">=", 500)
      .serve(10)
      .build();
    step(`Comparison (>=): ${JSON.stringify(comparisonRule.logic)}`);

    // "in" operator — value in list.
    const inRule = new Rule("Special theme for premium plans")
      .environment("staging")
      .when("user.plan", "in", ["enterprise", "business"])
      .serve({ mode: "dark", accent: "#66ccff" })
      .build();
    step(`In operator: ${JSON.stringify(inRule.logic)}`);

    // "contains" operator — array contains value.
    const containsRule = new Rule("Enable for users with admin role")
      .environment("staging")
      .when("user.roles", "contains", "admin")
      .serve(true)
      .build();
    step(`Contains operator: ${JSON.stringify(containsRule.logic)}`);

    // Apply rules to banner-color.
    bannerFlag.addRule(singleCondition);
    bannerFlag.setEnvironmentEnabled("staging", true);
    bannerFlag.setEnvironmentDefault("production", "blue");
    bannerFlag.setEnvironmentEnabled("production", true);
    await bannerFlag.save();
    step("Applied rules and environment config to banner-color");

    // ==================================================================
    // 6. LIST ALL FLAGS
    // ==================================================================

    section("6. List All Flags");

    const flags = await client.flags.list();
    step(`Total flags: ${flags.length}`);
    for (const f of flags) {
      const envKeys = f.environments ? Object.keys(f.environments) : [];
      step(
        `  ${f.key} (${f.type}) — default=${JSON.stringify(f.default)}, environments=${JSON.stringify(envKeys)}`,
      );
    }

    // ==================================================================
    // 7. DELETE A FLAG BY KEY
    // ==================================================================

    section("7. Delete a Flag by Key");

    await client.flags.delete("ui-theme");
    createdFlagKeys.splice(createdFlagKeys.indexOf("ui-theme"), 1);
    step("Deleted: ui-theme");

    // Verify it's gone.
    const remaining = await client.flags.list();
    const remainingKeys = remaining.map((f) => f.key);
    step(`Remaining flags: ${JSON.stringify(remainingKeys)}`);

    // ==================================================================
    // 8. CLEANUP
    // ==================================================================
    section("8. Cleanup");

    for (const key of [...createdFlagKeys]) {
      try {
        await client.flags.delete(key);
        step(`Deleted: ${key}`);
      } catch {
        // already deleted
      }
    }
    createdFlagKeys.length = 0;

    client.close();
    step("SmplClient closed");

    // ==================================================================
    // DONE
    // ==================================================================
    section("ALL DONE");
    console.log("  The Flags Management showcase completed successfully.");
    console.log("  All flags have been cleaned up.\n");
  } catch (error) {
    // ------------------------------------------------------------------
    // Error handler — clean up any flags we created before re-throwing.
    // ------------------------------------------------------------------
    console.error("\n  ERROR:", error);
    console.log("\n  Cleaning up flags created during this run...");
    for (const key of createdFlagKeys) {
      try {
        await client.flags.delete(key);
        step(`Deleted: ${key}`);
      } catch {
        // ignore cleanup errors
      }
    }
    client.close();
    throw error;
  }
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
