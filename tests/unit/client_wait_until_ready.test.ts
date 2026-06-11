/**
 * Tests for SmplClient.waitUntilReady().
 *
 * Validates:
 *   - flags._ensureConnected() and config._ensureConnected() are awaited.
 *   - Returns once the WebSocket reaches "connected".
 *   - Throws SmplTimeoutError if the WebSocket never connects.
 *
 * Also covers the shared-buffer wiring between platform.contexts and the
 * runtime flags client.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SmplClient, SmplTimeoutError } from "../../src/index.js";

describe("SmplClient.waitUntilReady", () => {
  const originalKey = process.env.SMPLKIT_API_KEY;
  const originalEnv = process.env.SMPLKIT_ENVIRONMENT;
  const originalSvc = process.env.SMPLKIT_SERVICE;
  const originalDisable = process.env.SMPLKIT_DISABLE_TELEMETRY;

  beforeEach(() => {
    process.env.SMPLKIT_API_KEY = "sk_test_wait_until_ready";
    process.env.SMPLKIT_ENVIRONMENT = "production";
    process.env.SMPLKIT_SERVICE = "test-service";
    process.env.SMPLKIT_DISABLE_TELEMETRY = "true";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SMPLKIT_API_KEY;
    else process.env.SMPLKIT_API_KEY = originalKey;
    if (originalEnv === undefined) delete process.env.SMPLKIT_ENVIRONMENT;
    else process.env.SMPLKIT_ENVIRONMENT = originalEnv;
    if (originalSvc === undefined) delete process.env.SMPLKIT_SERVICE;
    else process.env.SMPLKIT_SERVICE = originalSvc;
    if (originalDisable === undefined) delete process.env.SMPLKIT_DISABLE_TELEMETRY;
    else process.env.SMPLKIT_DISABLE_TELEMETRY = originalDisable;
  });

  it("awaits flags + config connect and resolves when the WS reports connected", async () => {
    const client = new SmplClient();
    const flagsConnect = vi.fn().mockResolvedValue(undefined);
    const configConnect = vi.fn().mockResolvedValue(undefined);
    (client.flags as unknown as { _ensureConnected: typeof flagsConnect })._ensureConnected =
      flagsConnect;
    (client.config as unknown as { _ensureConnected: typeof configConnect })._ensureConnected =
      configConnect;
    // Pretend the WS is already connected so the loop exits immediately.
    (client as unknown as { _ensureWs: () => unknown })._ensureWs = () => ({
      connectionStatus: "connected",
    });

    await expect(client.waitUntilReady({ timeoutMs: 1_000 })).resolves.toBeUndefined();
    expect(flagsConnect).toHaveBeenCalledOnce();
    expect(configConnect).toHaveBeenCalledOnce();
    client.close();
  });

  it("uses the default timeout when none is provided", async () => {
    const client = new SmplClient();
    (client.flags as unknown as { _ensureConnected: () => Promise<void> })._ensureConnected = () =>
      Promise.resolve();
    (client.config as unknown as { _ensureConnected: () => Promise<void> })._ensureConnected = () =>
      Promise.resolve();
    (client as unknown as { _ensureWs: () => unknown })._ensureWs = () => ({
      connectionStatus: "connected",
    });

    await expect(client.waitUntilReady()).resolves.toBeUndefined();
    client.close();
  });

  it("throws SmplTimeoutError when the WS never connects", async () => {
    const client = new SmplClient();
    (client.flags as unknown as { _ensureConnected: () => Promise<void> })._ensureConnected = () =>
      Promise.resolve();
    (client.config as unknown as { _ensureConnected: () => Promise<void> })._ensureConnected = () =>
      Promise.resolve();
    (client as unknown as { _ensureWs: () => unknown })._ensureWs = () => ({
      connectionStatus: "connecting",
    });

    await expect(client.waitUntilReady({ timeoutMs: 60 })).rejects.toBeInstanceOf(SmplTimeoutError);
    client.close();
  });

  it("polls until the WS reports connected on a later tick", async () => {
    const client = new SmplClient();
    (client.flags as unknown as { _ensureConnected: () => Promise<void> })._ensureConnected = () =>
      Promise.resolve();
    (client.config as unknown as { _ensureConnected: () => Promise<void> })._ensureConnected = () =>
      Promise.resolve();
    let calls = 0;
    (client as unknown as { _ensureWs: () => unknown })._ensureWs = () => ({
      get connectionStatus() {
        calls++;
        return calls < 2 ? "connecting" : "connected";
      },
    });

    await expect(client.waitUntilReady({ timeoutMs: 1_000 })).resolves.toBeUndefined();
    expect(calls).toBeGreaterThanOrEqual(2);
    client.close();
  });
});

describe("SmplClient shared context buffer", () => {
  beforeEach(() => {
    process.env.SMPLKIT_API_KEY = "sk_test_buffer";
    process.env.SMPLKIT_ENVIRONMENT = "production";
    process.env.SMPLKIT_SERVICE = "test-service";
    process.env.SMPLKIT_DISABLE_TELEMETRY = "true";
  });

  afterEach(() => {
    delete process.env.SMPLKIT_API_KEY;
    delete process.env.SMPLKIT_ENVIRONMENT;
    delete process.env.SMPLKIT_SERVICE;
    delete process.env.SMPLKIT_DISABLE_TELEMETRY;
  });

  it("flags borrows platform.contexts as its evaluation-context registration seam", () => {
    const client = new SmplClient();
    const flagsContexts = (client.flags as unknown as { _contexts: unknown })._contexts;
    // The flags client and platform.contexts share one ContextRegistrationBuffer
    // because flags is wired to borrow client.platform.contexts directly.
    expect(flagsContexts).toBe(client.platform.contexts);
    expect((flagsContexts as { _buffer: unknown })._buffer).toBe(client.platform.contexts._buffer);
    expect(client.platform.contexts._buffer).toBe(client.platform._contextBuffer);
    client.close();
  });

  it("exposes platform and account, and no legacy `.manage` namespace", () => {
    const client = new SmplClient();
    expect(client.platform).toBeDefined();
    expect(client.account).toBeDefined();
    expect((client as unknown as Record<string, unknown>).manage).toBeUndefined();
    expect((client as unknown as Record<string, unknown>).management).toBeUndefined();
    client.close();
  });
});
