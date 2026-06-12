import { beforeAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the SDK's clean public identity (Surface-Quality
 * Standard, P1). The published type surface is `dist/index.d.ts` — the artifact
 * a customer's IDE and `tsc` actually read — and it must NOT expose internal
 * implementation types. `stripInternal` (set in both `tsconfig.json` and the
 * tsup dts build) keeps `@internal`-tagged declarations out of it; this test
 * locks that in so a future build-config regression can't silently re-leak an
 * internal type onto the customer surface.
 *
 * It inspects the generated artifact, not runtime reflection — per the
 * standard's cardinal rule, the surface defect is whatever the tooling shows.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const dtsPath = join(repoRoot, "dist", "index.d.ts");

// Internal implementation types / tags that must never reach the published
// `.d.ts`. `ModelClient` covers every `*ModelClient` callback interface
// (EnvironmentModelClient, JobModelClient, ForwarderModelClient, …).
const FORBIDDEN = [
  "@internal",
  "MetricsReporter",
  "ModelClient",
  "SharedWebSocket",
  "AuditEventBuffer",
  "ContextRegistrationBuffer",
] as const;

describe("published dist/index.d.ts surface (P1 regression guard)", () => {
  let dts: string;

  beforeAll(() => {
    // CI builds before testing; when run standalone, build the bundle on demand
    // so the guard always inspects a fresh artifact.
    if (!existsSync(dtsPath)) {
      execSync("npm run build", { cwd: repoRoot, stdio: "ignore" });
    }
    dts = readFileSync(dtsPath, "utf-8");
  }, 120_000);

  it("exists and declares the public entry point", () => {
    expect(dts.length).toBeGreaterThan(0);
    expect(dts).toContain("declare class SmplClient");
  });

  it.each(FORBIDDEN)("does not leak %s onto the published surface", (symbol) => {
    expect(dts).not.toContain(symbol);
  });
});
