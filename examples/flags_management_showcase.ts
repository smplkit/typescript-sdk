/**
 * Demonstrates the smplkit management SDK for Smpl Flags.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *     - `SMPLKIT_API_KEY` environment variable
 *     - `~/.smplkit` configuration file (see SDK docs)
 *
 * Usage:
 *
 *   tsx examples/flags_management_showcase.ts
 */

import { SmplManagementClient, FlagValue, Op, Rule } from "../src/index.js";
import {
  cleanupManagementShowcase,
  setupManagementShowcase,
} from "./setup/flags_management_setup.js";

async function main(): Promise<void> {
  // create the client (TypeScript has a single Promise-based client)
  const manage = new SmplManagementClient();
  try {
    await setupManagementShowcase(manage);

    // create a boolean flag
    const checkoutFlag = manage.flags.newBooleanFlag("checkout-v2", {
      default: false,
      description: "Controls rollout of the new checkout experience.",
    });
    await checkoutFlag.save();
    console.log(`Created flag: ${checkoutFlag.id}`);

    // create a string flag (constrained)
    const bannerFlag = manage.flags.newStringFlag("banner-color", {
      default: "red",
      name: "Banner Color",
      description: "Controls the banner color shown to users.",
      values: [
        new FlagValue({ name: "Red", value: "red" }),
        new FlagValue({ name: "Green", value: "green" }),
        new FlagValue({ name: "Blue", value: "blue" }),
      ],
    });
    await bannerFlag.save();
    console.log(`Created flag: ${bannerFlag.id}`);

    // create a numeric flag (unconstrained)
    const retryFlag = manage.flags.newNumberFlag("max-retries", {
      default: 3,
      description: "Maximum number of API retries before failing.",
    });
    await retryFlag.save();
    console.log(`Created flag: ${retryFlag.id}`);

    // create a JSON flag (constrained)
    const themeFlag = manage.flags.newJsonFlag("ui-theme", {
      default: { mode: "light", accent: "#0066cc" },
      description: "Controls the UI theme configuration.",
      values: [
        new FlagValue({ name: "Light", value: { mode: "light", accent: "#0066cc" } }),
        new FlagValue({ name: "Dark", value: { mode: "dark", accent: "#66ccff" } }),
        new FlagValue({
          name: "High Contrast",
          value: { mode: "dark", accent: "#ffffff" },
        }),
      ],
    });
    await themeFlag.save();
    console.log(`Created flag: ${themeFlag.id}`);

    // checkoutFlag (serve true in staging to enterprise US users)
    checkoutFlag.enableRules({ environment: "staging" });
    checkoutFlag.addRule(
      new Rule("Enable for enterprise users in US region", { environment: "staging" })
        .when("user.plan", Op.EQ, "enterprise")
        .when("account.region", Op.EQ, "us")
        .serve(true),
    );

    // checkoutFlag (serve true in staging for beta testers)
    checkoutFlag.addRule(
      new Rule("Enable for beta testers", { environment: "staging" })
        .when("user.beta_tester", Op.EQ, true)
        .serve(true),
    );

    // checkoutFlag (disabled rules; serve false in production)
    checkoutFlag.disableRules({ environment: "production" });
    checkoutFlag.setDefault(false, { environment: "production" });
    await checkoutFlag.save();
    console.log(`Updated flag: ${checkoutFlag.id}`);

    // list flags
    const flags = await manage.flags.list();
    console.log(`Total flags: ${flags.length}`);
    for (const f of flags) {
      const envs = f.environments ? Object.keys(f.environments) : [];
      console.log(
        `  ${f.id} (${f.type}) — default=${JSON.stringify(f.default)}, environments=${JSON.stringify(envs)}`,
      );
    }

    // get a flag
    const fetched = await manage.flags.get("checkout-v2");
    console.log(`\nFetched by id: ${fetched.id}`);
    const stagingRules = fetched.environments["staging"]?.rules.length ?? 0;
    const prodEnabled = fetched.environments["production"]?.enabled;
    console.log(`  staging rules: ${stagingRules}`);
    console.log(`  production enabled: ${prodEnabled}`);

    // update a flag
    bannerFlag.addValue("Purple", "purple");
    bannerFlag.default = "blue";
    bannerFlag.description = "Controls the banner color — updated";
    bannerFlag.addRule(
      new Rule("Purple for enterprise users", { environment: "production" })
        .when("user.plan", Op.EQ, "enterprise")
        .serve("purple"),
    );
    await bannerFlag.save();
    console.log(`Updated flag: ${bannerFlag.id}`);

    // delete all the rules of a flag
    checkoutFlag.clearRules({ environment: "staging" });
    await checkoutFlag.save();

    // revert production's default value back to the flag default
    checkoutFlag.clearDefault({ environment: "production" });
    await checkoutFlag.save();
    console.log(`Updated flag: ${checkoutFlag.id}`);

    // clear values (flag becomes unconstrained)
    bannerFlag.clearValues();
    await bannerFlag.save();
    console.log(`Updated flag: ${bannerFlag.id}`);

    // delete flags
    await manage.flags.delete("checkout-v2");
    await bannerFlag.delete();
    console.log("Deleted flags");

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
