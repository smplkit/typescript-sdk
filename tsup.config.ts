import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The edge/serverless subpaths (`@smplkit/sdk/<subsystem>`): Node-free,
    // ws-free graphs — see src/<subsystem>/index.ts for each entry's
    // contract and limitations.
    audit: "src/audit/index.ts",
    config: "src/config/index.ts",
    flags: "src/flags/index.ts",
    logging: "src/logging/index.ts",
    jobs: "src/jobs/index.ts",
    platform: "src/platform/index.ts",
    account: "src/account/index.ts",
  },
  format: ["cjs", "esm"],
  dts: { compilerOptions: { stripInternal: true } },
  clean: true,
  sourcemap: true,
});
