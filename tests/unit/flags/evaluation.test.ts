import { describe, expect, it } from "vitest";

// We test the internal evaluateFlag function indirectly through
// _evaluateHandle, which is @internal but accessible.

import { Context } from "../../../src/flags/types.js";
import { FlagsClient } from "../../../src/flags/client.js";
import { SmplError } from "../../../src/errors.js";

function makeFlagsClient(): FlagsClient {
  const mockWs = { on: () => {}, off: () => {}, connectionStatus: "disconnected" };
  return new FlagsClient("sk_test", () => mockWs as never, 30000);
}

function setFlagStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  (client as Record<string, unknown>)["_flagStore"] = store;
  (client as Record<string, unknown>)["_initialized"] = true;
  (client as Record<string, unknown>)["_environment"] = "staging";
}

describe("Local JSON Logic evaluation", () => {
  it("should throw SmplError when not initialized", () => {
    const client = makeFlagsClient();
    const handle = client.booleanFlag("my-flag", false);
    expect(() => handle.get()).toThrow(SmplError);
    expect(() => handle.get()).toThrow("Flags not initialized");
  });

  it("should evaluate enabled environment with matching rule", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "checkout-v2": {
        id: "checkout-v2",
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

    const handle = client.booleanFlag("checkout-v2", false);
    expect(handle.get()).toBe(true);
  });

  it("should return flag default when environment is disabled", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "my-flag": {
        id: "my-flag",
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
        id: "banner-color",
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
        id: "banner-color",
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
        id: "my-flag",
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

    const handle = client.booleanFlag("nonexistent", false);
    expect(handle.get()).toBe(false);
  });

  it("should skip rules with empty logic", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "my-flag": {
        id: "my-flag",
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

    const handle = client.booleanFlag("my-flag", false);
    // First rule has empty logic and should be skipped, second matches
    expect(handle.get()).toBe(false);
  });

  it("should handle explicit context override", () => {
    const client = makeFlagsClient();
    setFlagStore(client, {
      "checkout-v2": {
        id: "checkout-v2",
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

    const handle = client.booleanFlag("checkout-v2", false);

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
        id: "my-flag",
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

  it("should auto-inject service context from parent", () => {
    const client = makeFlagsClient();
    // Set a parent with service
    client._parent = { _environment: "staging", _service: "my-svc" };

    setFlagStore(client, {
      "svc-flag": {
        id: "svc-flag",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [
              {
                logic: { "==": [{ var: "service.key" }, "my-svc"] },
                value: true,
              },
            ],
          },
        },
      },
    });

    const handle = client.booleanFlag("svc-flag", false);
    expect(handle.get()).toBe(true);
  });

  it("should not override explicit service context", () => {
    const client = makeFlagsClient();
    client._parent = { _environment: "staging", _service: "auto-svc" };

    setFlagStore(client, {
      "svc-flag": {
        id: "svc-flag",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [
              {
                logic: { "==": [{ var: "service.key" }, "explicit-svc"] },
                value: true,
              },
            ],
          },
        },
      },
    });

    const handle = client.booleanFlag("svc-flag", false);
    // Explicit service context overrides auto-injected
    expect(handle.get({ context: [new Context("service", "explicit-svc", {})] })).toBe(true);
  });
});
