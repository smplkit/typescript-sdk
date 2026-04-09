import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/generated/**", "src/index.ts", "src/logging/adapters/index.ts"],
      thresholds: {
        lines: 100,
      },
    },
  },
});
