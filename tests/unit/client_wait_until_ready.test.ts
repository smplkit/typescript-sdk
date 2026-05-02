/**
 * Tests for SmplClient.waitUntilReady() — rule 4 of PR #127.
 *
 * Validates:
 *   - flags.initialize() and config.start() are awaited.
 *   - Returns once the WebSocket reaches "connected".
 *   - Throws SmplTimeoutError if the WebSocket never connects.
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

  it("awaits flags.initialize, config.start, and resolves when WS reports connected", async () => {
    const client = new SmplClient();
    const flagsInit = vi.fn().mockResolvedValue(undefined);
    const configStart = vi.fn().mockResolvedValue(undefined);
    (client.flags as unknown as { initialize: typeof flagsInit }).initialize = flagsInit;
    (client.config as unknown as { start: typeof configStart }).start = configStart;
    // Pretend the WS is already connected so the loop exits immediately.
    (client as unknown as { _ensureWs: () => unknown })._ensureWs = () => ({
      connectionStatus: "connected",
    });

    await expect(client.waitUntilReady({ timeoutMs: 1_000 })).resolves.toBeUndefined();
    expect(flagsInit).toHaveBeenCalledOnce();
    expect(configStart).toHaveBeenCalledOnce();
    client.close();
  });

  it("throws SmplTimeoutError when the WS never connects", async () => {
    const client = new SmplClient();
    (client.flags as unknown as { initialize: () => Promise<void> }).initialize = () =>
      Promise.resolve();
    (client.config as unknown as { start: () => Promise<void> }).start = () => Promise.resolve();
    (client as unknown as { _ensureWs: () => unknown })._ensureWs = () => ({
      connectionStatus: "connecting",
    });

    await expect(client.waitUntilReady({ timeoutMs: 60 })).rejects.toBeInstanceOf(SmplTimeoutError);
    client.close();
  });

  it("polls until the WS reports connected on a later tick", async () => {
    const client = new SmplClient();
    (client.flags as unknown as { initialize: () => Promise<void> }).initialize = () =>
      Promise.resolve();
    (client.config as unknown as { start: () => Promise<void> }).start = () => Promise.resolve();
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

describe("SmplClient.manage shares context buffer with runtime flags", () => {
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

  it("flags client and management share a single ContextRegistrationBuffer instance", () => {
    const client = new SmplClient();
    const flagsBuffer = (client.flags as unknown as { _contextBuffer: unknown })._contextBuffer;
    expect(flagsBuffer).toBe(client.manage._contextBuffer);
    client.close();
  });

  it("client.manage is the only top-level management entry point", () => {
    const client = new SmplClient();
    // `client.management` was removed — the only exposed name is `client.manage`.
    expect(client.manage).toBeDefined();
    expect((client as unknown as Record<string, unknown>).management).toBeUndefined();
    client.close();
  });
});

describe("ConfigClient.start", () => {
  beforeEach(() => {
    process.env.SMPLKIT_API_KEY = "sk_test_config_start";
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

  it("delegates to the lazy initializer", async () => {
    const client = new SmplClient();
    const internal = vi.fn().mockResolvedValue(undefined);
    (client.config as unknown as { _ensureInitialized: typeof internal })._ensureInitialized =
      internal;
    await client.config.start();
    expect(internal).toHaveBeenCalledOnce();
    client.close();
  });
});
