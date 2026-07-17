import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

// Build-time only (this config never ships): the version esbuild inlines
// into `src/user_agent.ts` as the `smplkit-sdk-ts/<version>` User-Agent.
// The release workflow stamps the release version into package.json BEFORE
// running this build, so published artifacts embed the real version; local
// and CI test builds embed the committed placeholder.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

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
  define: {
    __SMPLKIT_SDK_VERSION__: JSON.stringify(version),
  },
});
