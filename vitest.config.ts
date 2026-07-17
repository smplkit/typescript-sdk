import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// Mirror the tsup build's version injection (see tsup.config.ts) so tests
// exercise the same `smplkit-sdk-ts/<version>` User-Agent the built
// artifacts send.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  define: {
    __SMPLKIT_SDK_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: true,
    setupFiles: ["tests/setup.ts"],
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
