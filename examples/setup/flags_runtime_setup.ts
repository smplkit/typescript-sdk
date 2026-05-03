/** Setup / cleanup helpers for `flags_runtime_showcase.ts`. */

import {
  SmplManagementClient,
  FlagValue,
  Op,
  Rule,
  SmplkitNotFoundError,
} from "../../src/index.js";

const DEMO_ENVIRONMENTS = ["staging", "production"];
const DEMO_FLAG_IDS = ["checkout-v2", "banner-color", "max-retries"];

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

  const checkout = manage.flags.newBooleanFlag("checkout-v2", {
    default: false,
    description: "Controls rollout of the new checkout experience.",
  });
  checkout.enableRules({ environment: "staging" });
  checkout.addRule(
    new Rule("Enable for enterprise users in US region", { environment: "staging" })
      .when("user.plan", Op.EQ, "enterprise")
      .when("account.region", Op.EQ, "us")
      .serve(true),
  );
  checkout.addRule(
    new Rule("Enable for beta testers", { environment: "staging" })
      .when("user.beta_tester", Op.EQ, true)
      .serve(true),
  );
  checkout.disableRules({ environment: "production" });
  checkout.setDefault(false, { environment: "production" });
  await checkout.save();

  const banner = manage.flags.newStringFlag("banner-color", {
    default: "red",
    name: "Banner Color",
    description: "Controls the banner color shown to users.",
    values: [
      new FlagValue({ name: "Red", value: "red" }),
      new FlagValue({ name: "Green", value: "green" }),
      new FlagValue({ name: "Blue", value: "blue" }),
    ],
  });
  banner.enableRules({ environment: "staging" });
  banner.addRule(
    new Rule("Blue for enterprise users", { environment: "staging" })
      .when("user.plan", Op.EQ, "enterprise")
      .serve("blue"),
  );
  banner.addRule(
    new Rule("Green for technology companies", { environment: "staging" })
      .when("account.industry", Op.EQ, "technology")
      .serve("green"),
  );
  banner.enableRules({ environment: "production" });
  banner.setDefault("blue", { environment: "production" });
  await banner.save();

  const retries = manage.flags.newNumberFlag("max-retries", {
    default: 3,
    description: "Maximum number of API retries before failing.",
  });
  retries.enableRules({ environment: "staging" });
  retries.addRule(
    new Rule("High retries for large accounts", { environment: "staging" })
      .when("account.employee_count", Op.GT, 100)
      .serve(5),
  );
  retries.enableRules({ environment: "production" });
  await retries.save();
}

export async function cleanupRuntimeShowcase(manage: SmplManagementClient): Promise<void> {
  for (const flagId of DEMO_FLAG_IDS) {
    try {
      await manage.flags.delete(flagId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
