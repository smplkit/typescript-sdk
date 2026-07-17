import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // The edge/serverless subpath (`@smplkit/sdk/audit`): a Node-free,
    // ws-free graph — see src/audit/index.ts.
    audit: "src/audit/index.ts",
  },
  format: ["cjs", "esm"],
  dts: { compilerOptions: { stripInternal: true } },
  clean: true,
  sourcemap: true,
});
