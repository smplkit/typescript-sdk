/**
 * SmplClient.setContext — stashes the per-request evaluation context, registers
 * each context with the platform in the background, starts the deferred
 * machinery, and returns a restorable scope.
 *
 * Isolated in its own worker; `fetch` is stubbed so the fire-and-forget
 * registration never hits the network, and the client is closed after each test
 * to clear the deferred flush timer.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplClient } from "../../src/client.js";
import { ContextScope, getRequestContext } from "../../src/context.js";
import { Context } from "../../src/flags/types.js";

const OPTS = {
  apiKey: "sk_api_test",
  environment: "test",
  service: "test-svc",
  telemetry: false,
};

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ registered: 1, data: [] }), { status: 200 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SmplClient.setContext", () => {
  it("registers the contexts, makes them current, and returns a ContextScope", () => {
    const client = new SmplClient(OPTS);
    const register = vi.spyOn(client.platform.contexts, "register").mockResolvedValue(undefined);
    const contexts = [new Context("user", "u-1"), new Context("account", "acme")];

    const scope = client.setContext(contexts);
    try {
      expect(scope).toBeInstanceOf(ContextScope);
      expect(register).toHaveBeenCalledWith(contexts);
      expect(getRequestContext().map((c) => c.key)).toEqual(["u-1", "acme"]);
      // setContext starts the deferred background machinery.
      expect((client as any)._started).toBe(true);
    } finally {
      scope.restore();
      client.close();
    }
  });

  it("skips registration for an empty list but still returns a scope", () => {
    const client = new SmplClient(OPTS);
    const register = vi.spyOn(client.platform.contexts, "register").mockResolvedValue(undefined);

    const scope = client.setContext([]);
    try {
      expect(scope).toBeInstanceOf(ContextScope);
      expect(register).not.toHaveBeenCalled();
      expect(getRequestContext()).toEqual([]);
    } finally {
      scope.restore();
      client.close();
    }
  });
});
