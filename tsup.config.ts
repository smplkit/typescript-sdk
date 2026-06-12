import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: { compilerOptions: { stripInternal: true } },
  clean: true,
  sourcemap: true,
});
