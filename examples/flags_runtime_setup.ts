/**
 * Demo setup helper for the flags runtime showcase.
 *
 * Creates and configures demo flags so the runtime showcase can run
 * standalone. Imported by `flags_runtime_showcase.ts`.
 *
 * Uses the new management API: factory methods (newBooleanFlag, etc.),
 * local mutations (addRule, setEnvironmentEnabled, setEnvironmentDefault),
 * and save().
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key
 *   - The smplkit Flags service running and reachable
 *
 * Usage:
 *   Not intended to be run directly. Import from flags_runtime_showcase.ts:
 *     import { setupDemoFlags, teardownDemoFlags } from "./flags_runtime_setup.js";
 */

import { SmplClient, Rule } from "@smplkit/sdk";

/**
 * Create and configure demo flags for the runtime showcase.
 *
 * Creates four flags with environment configuration and targeting rules,
 * then returns their keys for cleanup.
 */
export async function setupDemoFlags(client: SmplClient): Promise<string[]> {
  const flagKeys: string[] = [];

  // --------------------------------------------------------------------------
  // 1. checkout-v2 — boolean flag
  // --------------------------------------------------------------------------
  const checkoutFlag = client.flags.newBooleanFlag("checkout-v2", {
    default: false,
    description: "Controls rollout of the new checkout experience.",
  });

  // Configure staging: enabled with targeting rules.
  checkoutFlag.setEnvironmentEnabled("staging", true);
  checkoutFlag.addRule(
    new Rule("Enable for enterprise users in US region")
      .environment("staging")
      .when("user.plan", "==", "enterprise")
      .when("account.region", "==", "us")
      .serve(true)
      .build(),
  );
  checkoutFlag.addRule(
    new Rule("Enable for beta testers")
      .environment("staging")
      .when("user.beta_tester", "==", true)
      .serve(true)
      .build(),
  );

  // Configure production: disabled with safe default.
  checkoutFlag.setEnvironmentEnabled("production", false);
  checkoutFlag.setEnvironmentDefault("production", false);

  await checkoutFlag.save();
  flagKeys.push(checkoutFlag.key);

  // --------------------------------------------------------------------------
  // 2. banner-color — string flag
  // --------------------------------------------------------------------------
  const bannerFlag = client.flags.newStringFlag("banner-color", {
    default: "red",
    description: "Controls the banner color shown to users.",
    values: [
      { name: "Red", value: "red" },
      { name: "Green", value: "green" },
      { name: "Blue", value: "blue" },
    ],
  });

  // Configure staging: enabled with targeting rules.
  bannerFlag.setEnvironmentEnabled("staging", true);
  bannerFlag.addRule(
    new Rule("Blue for enterprise users")
      .environment("staging")
      .when("user.plan", "==", "enterprise")
      .serve("blue")
      .build(),
  );
  bannerFlag.addRule(
    new Rule("Green for technology companies")
      .environment("staging")
      .when("account.industry", "==", "technology")
      .serve("green")
      .build(),
  );

  // Configure production: enabled with a default override.
  bannerFlag.setEnvironmentEnabled("production", true);
  bannerFlag.setEnvironmentDefault("production", "blue");

  await bannerFlag.save();
  flagKeys.push(bannerFlag.key);

  // --------------------------------------------------------------------------
  // 3. max-retries — number flag
  // --------------------------------------------------------------------------
  const retryFlag = client.flags.newNumberFlag("max-retries", {
    default: 3,
    description: "Maximum number of API retries before failing.",
    values: [
      { name: "Low (1)", value: 1 },
      { name: "Standard (3)", value: 3 },
      { name: "High (5)", value: 5 },
      { name: "Aggressive (10)", value: 10 },
    ],
  });

  // Configure staging: enabled with a rule for large accounts.
  retryFlag.setEnvironmentEnabled("staging", true);
  retryFlag.addRule(
    new Rule("High retries for large accounts")
      .environment("staging")
      .when("account.employee_count", ">", 100)
      .serve(5)
      .build(),
  );

  // Configure production: enabled, no rules (uses flag default).
  retryFlag.setEnvironmentEnabled("production", true);

  await retryFlag.save();
  flagKeys.push(retryFlag.key);

  // --------------------------------------------------------------------------
  // 4. ui-theme — JSON flag
  // --------------------------------------------------------------------------
  const themeFlag = client.flags.newJsonFlag("ui-theme", {
    default: { mode: "light", accent: "#0066cc" },
    description: "Controls the UI theme configuration.",
    values: [
      { name: "Light", value: { mode: "light", accent: "#0066cc" } },
      { name: "Dark", value: { mode: "dark", accent: "#66ccff" } },
      { name: "High Contrast", value: { mode: "dark", accent: "#ffffff" } },
    ],
  });

  // Configure staging: enabled with a rule for enterprise users.
  themeFlag.setEnvironmentEnabled("staging", true);
  themeFlag.addRule(
    new Rule("Dark theme for enterprise users")
      .environment("staging")
      .when("user.plan", "==", "enterprise")
      .serve({ mode: "dark", accent: "#66ccff" })
      .build(),
  );

  // Configure production: enabled, no rules.
  themeFlag.setEnvironmentEnabled("production", true);

  await themeFlag.save();
  flagKeys.push(themeFlag.key);

  return flagKeys;
}

/**
 * Delete the demo flags created by setupDemoFlags.
 *
 * Accepts the array of flag keys returned by setupDemoFlags.
 */
export async function teardownDemoFlags(client: SmplClient, flagKeys: string[]): Promise<void> {
  for (const key of flagKeys) {
    try {
      await client.flags.delete(key);
    } catch {
      // ignore — flag may already be deleted
    }
  }
}
