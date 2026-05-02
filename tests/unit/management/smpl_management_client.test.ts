/**
 * Tests for the SmplManagementClient public surface (rules 1-2 of PR #127).
 *
 * Focuses on:
 *   - Zero construction side effects (no service registration, no metrics
 *     reporter, no WebSocket, no logger discovery).
 *   - Eight flat namespaces present and typed.
 *   - close() is idempotent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AccountSettingsClient,
  ContextTypesClient,
  ContextsClient,
  EnvironmentsClient,
  SmplManagementClient,
} from "../../../src/index.js";
import { ContextRegistrationBuffer } from "../../../src/management/client.js";

describe("SmplManagementClient", () => {
  const originalKey = process.env.SMPLKIT_API_KEY;

  beforeEach(() => {
    process.env.SMPLKIT_API_KEY = "sk_test_smpl_management_client";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SMPLKIT_API_KEY;
    else process.env.SMPLKIT_API_KEY = originalKey;
  });

  it("constructs with no construction side effects", () => {
    // No service registration, metrics, WebSocket, or logger discovery
    // should fire from constructing a management client.
    const fetchSpy: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: any) => {
      fetchSpy.push(typeof input === "string" ? input : (input.url ?? String(input)));
      return Promise.reject(new Error("no network in test"));
    }) as typeof fetch;
    try {
      const mgmt = new SmplManagementClient();
      expect(mgmt).toBeInstanceOf(SmplManagementClient);
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(fetchSpy).toEqual([]);
  });

  it("exposes eight flat namespaces", () => {
    const mgmt = new SmplManagementClient();
    expect(mgmt.contexts).toBeInstanceOf(ContextsClient);
    expect(mgmt.contextTypes).toBeInstanceOf(ContextTypesClient);
    expect(mgmt.environments).toBeInstanceOf(EnvironmentsClient);
    expect(mgmt.accountSettings).toBeInstanceOf(AccountSettingsClient);
    expect(mgmt.config).toBeDefined();
    expect(mgmt.flags).toBeDefined();
    expect(mgmt.loggers).toBeDefined();
    expect(mgmt.logGroups).toBeDefined();
  });

  it("close() is idempotent and best-effort", async () => {
    const mgmt = new SmplManagementClient();
    await expect(mgmt.close()).resolves.toBeUndefined();
    await expect(mgmt.close()).resolves.toBeUndefined();
  });

  it("_contextBuffer getter exposes the shared ContextRegistrationBuffer", () => {
    const mgmt = new SmplManagementClient();
    expect(mgmt._contextBuffer).toBeInstanceOf(ContextRegistrationBuffer);
  });

  it("close() swallows errors raised by inner flush calls (best-effort)", async () => {
    const mgmt = new SmplManagementClient();

    // Inject a flush that throws on each namespace; close() should still resolve.
    const boom = vi.fn().mockRejectedValue(new Error("boom"));
    (mgmt.contexts as unknown as { flush: typeof boom }).flush = boom;
    (mgmt.flags as unknown as { flush: typeof boom }).flush = boom;
    (mgmt.loggers as unknown as { flush: typeof boom }).flush = boom;

    await expect(mgmt.close()).resolves.toBeUndefined();
    expect(boom).toHaveBeenCalled();
  });
});
