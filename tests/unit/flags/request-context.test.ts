/**
 * Flag evaluation honours the per-request context set via `client.setContext`
 * (the AsyncLocalStorage store), and the precedence between it, an explicit
 * `get({ context })` override, and the global context provider.
 *
 * Precedence (mirrors the Python canonical): explicit context > per-request
 * setContext > context provider > none. Isolated in its own worker; each
 * mutating test restores so leakage can't shadow the provider fallback.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it } from "vitest";
import { Context } from "../../../src/flags/types.js";
import { BooleanFlag } from "../../../src/flags/models.js";
import { setContext } from "../../../src/context.js";
import { createMockContexts, makeWiredClient } from "./_helpers.js";
import type { FlagsClient } from "../../../src/flags/client.js";

function seedEnterpriseRule(client: FlagsClient): void {
  (client as any)._flagStore = {
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
  };
  (client as any)._connected = true;
}

function handle(client: FlagsClient): any {
  return new BooleanFlag(
    client as any,
    {
      id: "checkout-v2",
      name: "checkout-v2",
      type: "BOOLEAN",
      default: false,
      values: null,
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    } as any,
  );
}

describe("Flag evaluation with per-request context", () => {
  it("evaluates against the context set via setContext (no provider)", () => {
    const { client } = makeWiredClient();
    seedEnterpriseRule(client);
    const scope = setContext([new Context("user", "u-1", { plan: "enterprise" })]);
    try {
      expect(handle(client).get()).toBe(true);
    } finally {
      scope.restore();
    }
  });

  it("per-request context takes precedence over the context provider", () => {
    const { client } = makeWiredClient();
    seedEnterpriseRule(client);
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "free" })]);
    const h = handle(client);

    const scope = setContext([new Context("user", "u-1", { plan: "enterprise" })]);
    try {
      // setContext (enterprise) wins over the provider (free).
      expect(h.get()).toBe(true);
    } finally {
      scope.restore();
    }
    // With the per-request context cleared, the provider (free) is used again.
    expect(h.get()).toBe(false);
  });

  it("an explicit get({ context }) overrides the per-request context", () => {
    const { client } = makeWiredClient();
    seedEnterpriseRule(client);
    const h = handle(client);

    const scope = setContext([new Context("user", "u-1", { plan: "free" })]);
    try {
      expect(h.get({ context: [new Context("user", "u-1", { plan: "enterprise" })] })).toBe(true);
      // Without an explicit override, the per-request context (free) applies.
      expect(h.get()).toBe(false);
    } finally {
      scope.restore();
    }
  });

  it("does not re-register the per-request context during evaluation", () => {
    const contexts = createMockContexts();
    const { client } = makeWiredClient({ contexts });
    seedEnterpriseRule(client);
    const scope = setContext([new Context("user", "u-1", { plan: "enterprise" })]);
    try {
      handle(client).get();
      // Registration happens at the setContext call site, not in evaluation.
      expect(contexts.register).not.toHaveBeenCalled();
    } finally {
      scope.restore();
    }
  });
});
