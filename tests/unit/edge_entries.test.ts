/**
 * The `@smplkit/sdk/<subsystem>` edge subpath entries:
 *
 * - Each entry module exposes its client plus the shared typed error
 *   surface (so edge callers can catch what the client throws).
 * - The seam modules default to their edge state in a fresh module graph:
 *   empty ambient context.
 *
 * The node-built-in-free property of the built entries is enforced at
 * build time (dist verification); these tests pin the export surface.
 */

import { describe, expect, test } from "vitest";
import { getAmbientContext } from "../../src/ambient_context.js";

describe("edge entry export surfaces", () => {
  test("audit", async () => {
    const m = await import("../../src/audit/index.js");
    expect(m.AuditClient).toBeTypeOf("function");
    expect(m.ForwarderType).toBeDefined();
    expect(m.SmplError).toBeTypeOf("function");
  });

  test("config", async () => {
    const m = await import("../../src/config/index.js");
    expect(m.ConfigClient).toBeTypeOf("function");
    expect(m.Config).toBeTypeOf("function");
    expect(m.LiveConfigProxy).toBeTypeOf("function");
    expect(m.SmplkitError).toBeTypeOf("function");
  });

  test("flags", async () => {
    const m = await import("../../src/flags/index.js");
    expect(m.FlagsClient).toBeTypeOf("function");
    expect(m.BooleanFlag).toBeTypeOf("function");
    expect(m.Context).toBeTypeOf("function");
    expect(m.FlagDeclaration).toBeTypeOf("function");
    expect(m.SmplkitError).toBeTypeOf("function");
  });

  test("logging", async () => {
    const m = await import("../../src/logging/index.js");
    expect(m.LoggingClient).toBeTypeOf("function");
    expect(m.Logger).toBeTypeOf("function");
    expect(m.LogLevel).toBeDefined();
    expect(m.SmplkitError).toBeTypeOf("function");
    // The Node framework adapters are package-root exports only.
    expect((m as Record<string, unknown>).WinstonAdapter).toBeUndefined();
    expect((m as Record<string, unknown>).PinoAdapter).toBeUndefined();
  });

  test("jobs", async () => {
    const m = await import("../../src/jobs/index.js");
    expect(m.JobsClient).toBeTypeOf("function");
    expect(m.Job).toBeTypeOf("function");
    expect(m.SmplError).toBeTypeOf("function");
  });

  test("platform", async () => {
    const m = await import("../../src/platform/index.js");
    expect(m.PlatformClient).toBeTypeOf("function");
    expect(m.Environment).toBeTypeOf("function");
    expect(m.SmplkitError).toBeTypeOf("function");
  });

  test("account", async () => {
    const m = await import("../../src/account/index.js");
    expect(m.AccountClient).toBeTypeOf("function");
    expect(m.AccountSettings).toBeTypeOf("function");
    expect(m.SmplkitError).toBeTypeOf("function");
  });
});

describe("seam defaults (edge state — package root not imported)", () => {
  test("the ambient context defaults to empty", () => {
    expect(getAmbientContext()).toEqual([]);
  });
});
