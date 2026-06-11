/**
 * Local JSON Logic evaluation via the synchronous `_evaluateHandle` path.
 *
 * Follows ADR-022 §2.6: environment lookup → disabled short-circuit →
 * first-matching-rule → env default → flag default. The store is seeded
 * directly so these tests stay focused on evaluation semantics.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it } from "vitest";
import { Context } from "../../../src/flags/types.js";
import { BooleanFlag, StringFlag, NumberFlag } from "../../../src/flags/models.js";
import { makeWiredClient } from "./_helpers.js";
import type { FlagsClient } from "../../../src/flags/client.js";

function seedStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  (client as any)._flagStore = store;
  (client as any)._connected = true;
}

function handle(client: FlagsClient, type: string, id: string, def: unknown): any {
  const fields = {
    id,
    name: id,
    type,
    default: def,
    values: null,
    description: null,
    environments: {},
    createdAt: null,
    updatedAt: null,
  };
  if (type === "STRING") return new StringFlag(client as any, fields as any);
  if (type === "NUMERIC") return new NumberFlag(client as any, fields as any);
  return new BooleanFlag(client as any, fields as any);
}

describe("Local JSON Logic evaluation", () => {
  it("returns the code default when the flag is not in the store", () => {
    const { client } = makeWiredClient();
    seedStore(client, {});
    expect(handle(client, "BOOLEAN", "my-flag", false).get()).toBe(false);
  });

  it("evaluates an enabled environment with a matching rule", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "checkout-v2": {
        id: "checkout-v2",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: true }],
          },
        },
      },
    });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);
    expect(handle(client, "BOOLEAN", "checkout-v2", false).get()).toBe(true);
  });

  it("returns the flag default when the environment is disabled", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "my-flag": {
        id: "my-flag",
        default: "red",
        environments: {
          staging: {
            enabled: false,
            rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: "blue" }],
          },
        },
      },
    });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);
    expect(handle(client, "STRING", "my-flag", "green").get()).toBe("red");
  });

  it("returns the env default when no rules match", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "banner-color": {
        id: "banner-color",
        default: "red",
        environments: {
          staging: {
            enabled: true,
            default: "blue",
            rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: "green" }],
          },
        },
      },
    });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "free" })]);
    expect(handle(client, "STRING", "banner-color", "yellow").get()).toBe("blue");
  });

  it("uses first-match-wins semantics", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "banner-color": {
        id: "banner-color",
        default: "red",
        environments: {
          staging: {
            enabled: true,
            rules: [
              { logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: "blue" },
              { logic: { "==": [{ var: "account.industry" }, "technology"] }, value: "green" },
            ],
          },
        },
      },
    });
    client.setContextProvider(() => [
      new Context("user", "u-1", { plan: "enterprise" }),
      new Context("account", "a-1", { industry: "technology" }),
    ]);
    expect(handle(client, "STRING", "banner-color", "red").get()).toBe("blue");
  });

  it("returns the flag default when the environment is not configured", () => {
    const { client } = makeWiredClient();
    seedStore(client, { "my-flag": { id: "my-flag", default: 42, environments: {} } });
    expect(handle(client, "NUMERIC", "my-flag", 0).get()).toBe(42);
  });

  it("skips rules with empty logic", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "my-flag": {
        id: "my-flag",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [
              { logic: {}, value: true },
              { logic: { "==": [{ var: "user.plan" }, "free"] }, value: false },
            ],
          },
        },
      },
    });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "free" })]);
    expect(handle(client, "BOOLEAN", "my-flag", false).get()).toBe(false);
  });

  it("honours an explicit context override over the provider", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "checkout-v2": {
        id: "checkout-v2",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: true }],
          },
        },
      },
    });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "free" })]);
    const h = handle(client, "BOOLEAN", "checkout-v2", false);

    expect(h.get({ context: [new Context("user", "u-1", { plan: "enterprise" })] })).toBe(true);
    expect(h.get()).toBe(false); // provider context (free) used when no override
  });

  it("skips rules whose json-logic throws", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "my-flag": {
        id: "my-flag",
        default: "fallback",
        environments: {
          staging: {
            enabled: true,
            default: "env-default",
            rules: [
              {
                logic: { invalid_op_that_does_not_exist: [{ var: "user.plan" }] },
                value: "should-not-be-returned",
              },
            ],
          },
        },
      },
    });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);
    expect(handle(client, "STRING", "my-flag", "code-default").get()).toBe("env-default");
  });

  it("auto-injects the service context from the parent", () => {
    const { client } = makeWiredClient({ service: "my-svc" });
    seedStore(client, {
      "svc-flag": {
        id: "svc-flag",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [{ logic: { "==": [{ var: "service.key" }, "my-svc"] }, value: true }],
          },
        },
      },
    });
    expect(handle(client, "BOOLEAN", "svc-flag", false).get()).toBe(true);
  });

  it("does not override an explicit service context", () => {
    const { client } = makeWiredClient({ service: "auto-svc" });
    seedStore(client, {
      "svc-flag": {
        id: "svc-flag",
        default: false,
        environments: {
          staging: {
            enabled: true,
            rules: [{ logic: { "==": [{ var: "service.key" }, "explicit-svc"] }, value: true }],
          },
        },
      },
    });
    const h = handle(client, "BOOLEAN", "svc-flag", false);
    expect(h.get({ context: [new Context("service", "explicit-svc", {})] })).toBe(true);
  });
});
