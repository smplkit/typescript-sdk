import { describe, expect, it } from "vitest";

// We need to test the internal evaluateFlag function. We'll test it
// through the FlagsClient._evaluateHandle by constructing a minimal client.
// However, the evaluation function is private. Instead, we'll test it
// indirectly through the flag handles.

// For direct evaluation testing, we import the module and access the
// internal function through the handle's get() behavior.

import { Context } from "../../../src/flags/types.js";

// We'll create a minimal FlagsClient to test evaluation logic.
// Since we can't call the private evaluateFlag directly, we test
// through _evaluateHandle which is @internal but accessible.

import { FlagsClient } from "../../../src/flags/client.js";

function makeFlagsClient(): FlagsClient {
  // Create with a dummy ensureWs that returns a mock
  const mockWs = { on: () => {}, off: () => {}, connectionStatus: "disconnected" };
  return new FlagsClient("sk_test", () => mockWs as never, 30000);
}

function setFlagStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  // Access private _flagStore and _connected via bracket notation
  (client as Record<string, unknown>)["_flagStore"] = store;
  (client as Record<string, unknown>)["_connected"] = true;
  (client as Record<string, unknown>)["_environment"] = "staging";
}

describe("Local JSON Logic evaluation", () => {
  it("should return code default when not connected", () => {
    const client = makeFlagsClient();
    const handle = client.boolFlag("my-flag", false);
    expect(handle.get()).toBe(false);
  });

  it("should evaluate enabled environment with matching rule", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "checkout-v2": {
        key: "checkout-v2",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [
              {
                logic: { "==": [{ var: "user.plan" }, "enterprise"] },
                value: true,
              },
            ],
          },
        },
      },
    });

    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);

    const handle = client.boolFlag("checkout-v2", false);
    expect(handle.get()).toBe(true);
  });

  it("should return flag default when environment is disabled", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "my-flag": {
        key: "my-flag",
        default: "red",
        environments: {
          staging: {
            enabled: false,
            rules: [
              {
                logic: { "==": [{ var: "user.plan" }, "enterprise"] },
                value: "blue",
              },
            ],
          },
        },
      },
    });

    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);

    const handle = client.stringFlag("my-flag", "green");
    expect(handle.get()).toBe("red");
  });

  it("should return env default when no rules match", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "banner-color": {
        key: "banner-color",
        default: "red",
        environments: {
          staging: {
            enabled: true,
            default: "blue",
            rules: [
              {
                logic: { "==": [{ var: "user.plan" }, "enterprise"] },
                value: "green",
              },
            ],
          },
        },
      },
    });

    client.setContextProvider(() => [new Context("user", "u-1", { plan: "free" })]);

    const handle = client.stringFlag("banner-color", "yellow");
    // No rule matches, env default is "blue"
    expect(handle.get()).toBe("blue");
  });

  it("should use first-match-wins semantics", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "banner-color": {
        key: "banner-color",
        default: "red",
        environments: {
          staging: {
            enabled: true,
            rules: [
              {
                logic: { "==": [{ var: "user.plan" }, "enterprise"] },
                value: "blue",
              },
              {
                logic: { "==": [{ var: "account.industry" }, "technology"] },
                value: "green",
              },
            ],
          },
        },
      },
    });

    // Both rules match, but first should win
    client.setContextProvider(() => [
      new Context("user", "u-1", { plan: "enterprise" }),
      new Context("account", "a-1", { industry: "technology" }),
    ]);

    const handle = client.stringFlag("banner-color", "red");
    expect(handle.get()).toBe("blue");
  });

  it("should return flag default when environment not configured", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "my-flag": {
        key: "my-flag",
        default: 42,
        environments: {},
      },
    });

    const handle = client.numberFlag("my-flag", 0);
    expect(handle.get()).toBe(42);
  });

  it("should return code default when flag not in store", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {});

    const handle = client.boolFlag("nonexistent", false);
    expect(handle.get()).toBe(false);
  });

  it("should skip rules with empty logic", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "my-flag": {
        key: "my-flag",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [
              { logic: {}, value: true },
              {
                logic: { "==": [{ var: "user.plan" }, "free"] },
                value: false,
              },
            ],
          },
        },
      },
    });

    client.setContextProvider(() => [new Context("user", "u-1", { plan: "free" })]);

    const handle = client.boolFlag("my-flag", false);
    // First rule has empty logic and should be skipped, second matches
    expect(handle.get()).toBe(false);
  });

  it("should handle explicit context override", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "checkout-v2": {
        key: "checkout-v2",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [
              {
                logic: { "==": [{ var: "user.plan" }, "enterprise"] },
                value: true,
              },
            ],
          },
        },
      },
    });

    // Provider returns free user
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "free" })]);

    const handle = client.boolFlag("checkout-v2", false);

    // Override with enterprise user
    const result = handle.get({
      context: [new Context("user", "u-1", { plan: "enterprise" })],
    });
    expect(result).toBe(true);

    // Without override, provider context is used (free user)
    expect(handle.get()).toBe(false);
  });

  it("should skip rules with invalid json-logic that throws", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "my-flag": {
        key: "my-flag",
        default: "fallback",
        environments: {
          staging: {
            enabled: true,
            default: "env-default",
            rules: [
              {
                // Invalid logic that will cause json-logic-js to throw
                logic: { invalid_op_that_does_not_exist: [{ var: "user.plan" }] },
                value: "should-not-be-returned",
              },
            ],
          },
        },
      },
    });

    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);

    const handle = client.stringFlag("my-flag", "code-default");
    // Invalid rule is caught and skipped, falls through to env default
    expect(handle.get()).toBe("env-default");
  });
});
