/**
 * Demo setup helper for the flags runtime showcase.
 *
 * Creates and configures demo flags so the runtime showcase can run
 * standalone.  Imported by `flags_runtime_showcase.ts`.
 */

import { SmplClient, FlagType, Rule } from "@smplkit/sdk";
import type { Flag, ContextType } from "@smplkit/sdk";

/**
 * Create and configure three demo flags for the runtime showcase.
 *
 * Returns [checkoutFlag, bannerFlag, retryFlag].
 */
export async function setupDemoFlags(client: SmplClient): Promise<Flag[]> {
  // 1. checkout-v2 — boolean
  const checkoutFlag = await client.flags.create("checkout-v2", {
    name: "Checkout V2",
    type: "BOOLEAN" as FlagType,
    default: false,
    description: "Controls rollout of the new checkout experience.",
  });
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

  // 2. banner-color — string
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

  // 3. max-retries — numeric
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

  return [checkoutFlag, bannerFlag, retryFlag];
}

/**
 * Delete the demo flags created by setupDemoFlags.
 */
export async function teardownDemoFlags(client: SmplClient, flags: Flag[]): Promise<void> {
  for (const flag of flags) {
    try {
      await client.flags.delete(flag.id);
    } catch {
      // ignore
    }
  }

  // Clean up any context types that were auto-created.
  try {
    const contextTypes: ContextType[] = await client.flags.listContextTypes();
    for (const ct of contextTypes) {
      try {
        await client.flags.deleteContextType(ct.id);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}
