/** Setup / cleanup helpers for `flags_runtime_showcase.ts`. */

import { SmplClient, FlagValue, Op, Rule, SmplkitNotFoundError } from "../../src/index.js";

const DEMO_FLAG_IDS = ["checkout-v2", "banner-color", "max-retries"];

export async function setupRuntimeShowcase(client: SmplClient): Promise<void> {
  await cleanupRuntimeShowcase(client);

  const checkout = client.flags.newBooleanFlag("checkout-v2", {
    default: false,
    description: "Controls rollout of the new checkout experience.",
  });
  checkout.enableRules({ environment: "production" });
  checkout.addRule(
    new Rule("Enable for enterprise users in US region", { environment: "production" })
      .when("user.plan", Op.EQ, "enterprise")
      .when("account.region", Op.EQ, "us")
      .serve(true),
  );
  checkout.addRule(
    new Rule("Enable for beta testers", { environment: "production" })
      .when("user.beta_tester", Op.EQ, true)
      .serve(true),
  );
  await checkout.save();

  const banner = client.flags.newStringFlag("banner-color", {
    default: "red",
    name: "Banner Color",
    description: "Controls the banner color shown to users.",
    values: [
      new FlagValue({ name: "Red", value: "red" }),
      new FlagValue({ name: "Green", value: "green" }),
      new FlagValue({ name: "Blue", value: "blue" }),
    ],
  });
  banner.enableRules({ environment: "production" });
  banner.addRule(
    new Rule("Blue for enterprise users", { environment: "production" })
      .when("user.plan", Op.EQ, "enterprise")
      .serve("blue"),
  );
  banner.addRule(
    new Rule("Green for technology companies", { environment: "production" })
      .when("account.industry", Op.EQ, "technology")
      .serve("green"),
  );
  await banner.save();

  const retries = client.flags.newNumberFlag("max-retries", {
    default: 3,
    description: "Maximum number of API retries before failing.",
  });
  retries.enableRules({ environment: "production" });
  retries.addRule(
    new Rule("High retries for large accounts", { environment: "production" })
      .when("account.employee_count", Op.GT, 100)
      .serve(5),
  );
  await retries.save();
}

export async function cleanupRuntimeShowcase(client: SmplClient): Promise<void> {
  for (const flagId of DEMO_FLAG_IDS) {
    try {
      await client.flags.delete(flagId);
    } catch (err) {
      if (!(err instanceof SmplkitNotFoundError)) throw err;
    }
  }
}
