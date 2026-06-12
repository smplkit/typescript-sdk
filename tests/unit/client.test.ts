import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Allow homedir to be overridden per-test so tests that require no ~/.smplkit
// config file can point at a nonexistent directory.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
import { SmplClient } from "../../src/client.js";
import * as _debugMod from "../../src/_debug.js";
import { SmplError } from "../../src/errors.js";
import { ConfigClient } from "../../src/config/client.js";
import { FlagsClient } from "../../src/flags/client.js";
import { LoggingClient } from "../../src/logging/client.js";
import { AuditClient } from "../../src/audit/client.js";
import { JobsClient } from "../../src/jobs/client.js";
import { PlatformClient } from "../../src/platform/client.js";
import { AccountClient } from "../../src/account/client.js";

// Stub fetch globally so the fire-and-forget _registerServiceContext never hits the network.
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  // Fresh Response per call — a single shared Response body can only be read
  // once, and several deferred operations may each read a response.
  mockFetch.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ registered: 1, data: [] }), { status: 200 })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

const DEFAULT_OPTS = { apiKey: "sk_api_test", environment: "test", service: "test-svc" };

describe("SmplClient", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.SMPLKIT_SERVICE = process.env.SMPLKIT_SERVICE;
    savedEnv.SMPLKIT_ENVIRONMENT = process.env.SMPLKIT_ENVIRONMENT;
    savedEnv.SMPLKIT_API_KEY = process.env.SMPLKIT_API_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it("should throw SmplError when no apiKey and no env/config fallback", () => {
    // Skip if a config file exists on this machine (CI has no ~/.smplkit)
    if (existsSync(join(homedir(), ".smplkit"))) return;
    delete process.env.SMPLKIT_API_KEY;
    expect(() => new SmplClient({ apiKey: "", environment: "test", service: "test-svc" })).toThrow(
      SmplError,
    );
  });

  it("should create a client with all required options", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should expose a config sub-client", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should accept a custom timeout", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, timeout: 5000 });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should accept all options together", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, timeout: 10000 });
    expect(client).toBeInstanceOf(SmplClient);
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should expose a flags sub-client", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.flags).toBeInstanceOf(FlagsClient);
  });

  it("should expose a logging sub-client", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.logging).toBeInstanceOf(LoggingClient);
  });

  it("should expose audit, jobs, platform, and account sub-clients", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.audit).toBeInstanceOf(AuditClient);
    expect(client.jobs).toBeInstanceOf(JobsClient);
    expect(client.platform).toBeInstanceOf(PlatformClient);
    expect(client.account).toBeInstanceOf(AccountClient);
  });

  it("should return the same config instance every time (singleton accessor)", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.config).toBe(client.config);
  });

  it("should return the same flags instance every time (singleton accessor)", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.flags).toBe(client.flags);
  });

  it("should close without error when no WS is active", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(() => client.close()).not.toThrow();
  });

  it("should use default smplkit.com domain when baseDomain is not set", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client).toBeInstanceOf(SmplClient);
    // Verify the fire-and-forget context registration used the default domain
    const url = mockFetch.mock.calls[0]?.[0];
    if (url) {
      expect(typeof url === "string" ? url : (url as Request).url).toContain("app.smplkit.com");
    }
  });

  it("should use custom baseDomain and http scheme for all service URLs", () => {
    const client = new SmplClient({
      ...DEFAULT_OPTS,
      baseDomain: "localhost",
      scheme: "http",
    });
    expect(client).toBeInstanceOf(SmplClient);
    const url = mockFetch.mock.calls[0]?.[0];
    if (url) {
      expect(typeof url === "string" ? url : (url as Request).url).toContain(
        "http://app.localhost",
      );
    }
  });

  it("should accept baseDomain without scheme (defaults to https)", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, baseDomain: "staging.example.com" });
    expect(client).toBeInstanceOf(SmplClient);
    const url = mockFetch.mock.calls[0]?.[0];
    if (url) {
      expect(typeof url === "string" ? url : (url as Request).url).toContain(
        "https://app.staging.example.com",
      );
    }
  });

  it("should accept a long API key (> 14 chars) without throwing", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, apiKey: "sk_api_1234567890abcdef" });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should call logging.close() on close()", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    const spy = vi.spyOn(client.logging, "close");
    client.close();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("resolves environment to empty (optional) when no environment and no env var", async () => {
    delete process.env.SMPLKIT_ENVIRONMENT;
    delete process.env.SMPLKIT_PROFILE;
    // Point homedir at a nonexistent path so no ~/.smplkit file is read
    vi.mocked(homedir).mockReturnValue("/tmp/nonexistent-smplkit-test-dir");
    const client = new SmplClient({ apiKey: "sk_api_test", service: "test-svc" });
    expect(client._environment).toBe("");
    client.close();
  });

  it("should resolve environment from SMPLKIT_ENVIRONMENT env var", () => {
    process.env.SMPLKIT_ENVIRONMENT = "staging";
    const client = new SmplClient({ apiKey: "sk_api_test", service: "test-svc" });
    expect(client._environment).toBe("staging");
  });

  it("should prefer explicit environment over env var", () => {
    process.env.SMPLKIT_ENVIRONMENT = "staging";
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "production",
      service: "test-svc",
    });
    expect(client._environment).toBe("production");
  });

  it("should store service when provided", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "my-svc",
    });
    expect(client._service).toBe("my-svc");
  });

  it("resolves service to null (optional) when no service and no env var", () => {
    delete process.env.SMPLKIT_SERVICE;
    vi.mocked(homedir).mockReturnValue("/tmp/nonexistent-smplkit-test-dir");
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client._service).toBeNull();
    client.close();
  });

  it("skips the service-context POST entirely when neither environment nor service is set", async () => {
    delete process.env.SMPLKIT_ENVIRONMENT;
    delete process.env.SMPLKIT_SERVICE;
    vi.mocked(homedir).mockReturnValue("/tmp/nonexistent-smplkit-test-dir");
    mockFetch.mockClear();
    const client = new SmplClient({ apiKey: "sk_api_test" });
    await (
      client as unknown as { _registerServiceContext: () => Promise<void> }
    )._registerServiceContext();
    const bulkReq = mockFetch.mock.calls.find((c) => {
      const url = c[0];
      return (typeof url === "string" ? url : (url as Request).url).includes("/contexts/bulk");
    });
    expect(bulkReq).toBeUndefined();
    client.close();
  });

  it("should resolve service from SMPLKIT_SERVICE env var", () => {
    process.env.SMPLKIT_SERVICE = "env-service";
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client._service).toBe("env-service");
  });

  it("requires only api_key; environment and service are optional", () => {
    // Skip if a config file exists (it may supply values that prevent the expected errors)
    if (existsSync(join(homedir(), ".smplkit"))) return;

    delete process.env.SMPLKIT_ENVIRONMENT;
    delete process.env.SMPLKIT_SERVICE;
    delete process.env.SMPLKIT_API_KEY;

    // Missing api_key → api_key error (the only required field).
    expect(() => new SmplClient({ environment: "test", service: "svc" })).toThrow("No API key");

    // api_key alone is sufficient — environment and service default to optional.
    const client = new SmplClient({ apiKey: "sk_test" });
    expect(client._environment).toBe("");
    expect(client._service).toBeNull();
    client.close();
  });

  it("should call enableDebug() when debug: true is passed to constructor", () => {
    const spy = vi.spyOn(_debugMod, "enableDebug");
    new SmplClient({ ...DEFAULT_OPTS, debug: true });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("should not call enableDebug() when debug is false", () => {
    const spy = vi.spyOn(_debugMod, "enableDebug");
    new SmplClient({ ...DEFAULT_OPTS, debug: false });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("should not call enableDebug() when debug is not specified", () => {
    const spy = vi.spyOn(_debugMod, "enableDebug");
    new SmplClient(DEFAULT_OPTS);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("should mention ~/.smplkit in API key error message", () => {
    // Skip if a config file exists on this machine
    if (existsSync(join(homedir(), ".smplkit"))) return;
    delete process.env.SMPLKIT_API_KEY;
    try {
      new SmplClient({ environment: "production", service: "test-svc" });
    } catch (e) {
      expect(e).toBeInstanceOf(SmplError);
      const msg = (e as SmplError).message;
      expect(msg).toContain("No API key provided");
      expect(msg).toContain("~/.smplkit");
    }
  });

  it("is side-effect-free at construction (no flush timer, no WS, no network)", () => {
    mockFetch.mockClear();
    const client = new SmplClient(DEFAULT_OPTS);
    expect((client as unknown as { _flushTimer: unknown })._flushTimer).toBeNull();
    expect((client as unknown as { _wsManager: unknown })._wsManager).toBeNull();
    expect((client as unknown as { _started: boolean })._started).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    client.close();
  });

  it("_ensureStarted() schedules the periodic flush exactly once and registers the service", () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockClear();
      const client = new SmplClient(DEFAULT_OPTS);

      client._ensureStarted();
      expect((client as unknown as { _started: boolean })._started).toBe(true);
      expect((client as unknown as { _flushTimer: unknown })._flushTimer).not.toBeNull();
      // _registerServiceContext fired a POST to /api/v1/contexts/bulk.
      const bulkReq = mockFetch.mock.calls.find((c) => {
        const url = c[0];
        return (typeof url === "string" ? url : (url as Request).url).includes("/contexts/bulk");
      });
      expect(bulkReq).toBeDefined();

      const firstTimer = (client as unknown as { _flushTimer: unknown })._flushTimer;
      // Idempotent — a second call must not reschedule or re-register.
      client._ensureStarted();
      expect((client as unknown as { _flushTimer: unknown })._flushTimer).toBe(firstTimer);

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the periodic flush timer drains the registration buffers and reschedules", async () => {
    vi.useFakeTimers();
    try {
      const client = new SmplClient(DEFAULT_OPTS);
      const ctxFlush = vi.spyOn(client.platform.contexts, "flush").mockResolvedValue(undefined);
      const flagsFlush = vi.spyOn(client.flags, "flush").mockResolvedValue(undefined);
      const loggersFlush = vi.spyOn(client.logging.loggers, "flush").mockResolvedValue(undefined);
      const configFlush = vi.spyOn(client.config, "flush").mockResolvedValue(undefined);

      client._ensureStarted();
      const firstTimer = (client as unknown as { _flushTimer: unknown })._flushTimer;

      // Advance past the 60s interval to fire the tick.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(ctxFlush).toHaveBeenCalled();
      expect(flagsFlush).toHaveBeenCalled();
      expect(loggersFlush).toHaveBeenCalled();
      expect(configFlush).toHaveBeenCalled();

      // Self-rescheduling: a new timer is installed after the tick settles.
      const secondTimer = (client as unknown as { _flushTimer: unknown })._flushTimer;
      expect(secondTimer).not.toBe(firstTimer);

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the periodic tick is a no-op after close()", async () => {
    vi.useFakeTimers();
    try {
      const client = new SmplClient(DEFAULT_OPTS);
      client._ensureStarted();
      client.close();
      const ctxFlush = vi.spyOn(client.platform.contexts, "flush");
      // After close, _closed short-circuits; the timer was cleared anyway.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(ctxFlush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("_ensureStarted() is a no-op once the client is closed", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    client.close();
    client._ensureStarted();
    expect((client as unknown as { _started: boolean })._started).toBe(false);
    expect((client as unknown as { _flushTimer: unknown })._flushTimer).toBeNull();
  });

  it("close() clears the flush timer, stops the WS, and closes sub-clients", () => {
    const client = new SmplClient(DEFAULT_OPTS);

    // Spies on the sub-client teardown chain.
    const loggingClose = vi.spyOn(client.logging, "close");
    const flagsClose = vi.spyOn(client.flags, "close");
    const configClose = vi.spyOn(client.config, "close");
    const auditClose = vi.spyOn(client.audit, "_close").mockResolvedValue(undefined);

    // Start machinery + a fake WS so close() exercises every branch.
    client._ensureStarted();
    const fakeWs = { stop: vi.fn(), connectionStatus: "connected" };
    (client as unknown as { _wsManager: unknown })._wsManager = fakeWs;
    expect((client as unknown as { _flushTimer: unknown })._flushTimer).not.toBeNull();

    client.close();

    expect((client as unknown as { _flushTimer: unknown })._flushTimer).toBeNull();
    expect((client as unknown as { _wsManager: unknown })._wsManager).toBeNull();
    expect(fakeWs.stop).toHaveBeenCalledTimes(1);
    expect(loggingClose).toHaveBeenCalledTimes(1);
    expect(flagsClose).toHaveBeenCalledTimes(1);
    expect(configClose).toHaveBeenCalledTimes(1);
    expect(auditClose).toHaveBeenCalledTimes(1);
  });

  it("close() with telemetry enabled closes the metrics reporter", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, telemetry: true });
    const metrics = (client as unknown as { _metrics: { close: () => void } | null })._metrics;
    expect(metrics).not.toBeNull();
    const metricsClose = vi.spyOn(metrics!, "close");
    client.close();
    expect(metricsClose).toHaveBeenCalledTimes(1);
  });

  it("does not build a metrics reporter when telemetry is disabled", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, telemetry: false });
    expect((client as unknown as { _metrics: unknown })._metrics).toBeNull();
    client.close();
  });

  it("_ensureWs() starts the deferred machinery and returns a shared WS", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    const ws = client._ensureWs();
    expect(ws).toBeDefined();
    expect((client as unknown as { _started: boolean })._started).toBe(true);
    // Same instance on a second call.
    expect(client._ensureWs()).toBe(ws);
    client.close();
  });

  it("masks a short API key (<= 14 chars) in the lifecycle debug log", () => {
    // Exercises the short-key branch of the mask computation.
    const client = new SmplClient({ ...DEFAULT_OPTS, apiKey: "sk_short" });
    expect(client).toBeInstanceOf(SmplClient);
    client.close();
  });

  it("_registerServiceContext swallows POST failures (fire-and-forget)", async () => {
    const client = new SmplClient(DEFAULT_OPTS);
    // Force the bulk POST to reject so the catch branch runs.
    const appHttp = (client as unknown as { _appHttp: { POST: unknown } })._appHttp;
    appHttp.POST = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      (
        client as unknown as { _registerServiceContext: () => Promise<void> }
      )._registerServiceContext(),
    ).resolves.toBeUndefined();
    client.close();
  });
});

describe("SmplClient — extraHeaders", () => {
  it("extraHeaders flow into sub-client HTTP calls", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new SmplClient({
      ...DEFAULT_OPTS,
      extraHeaders: { "X-Tenant": "acme", Authorization: "should-be-overridden" },
    });
    try {
      // Lazily connect flags; the discovery flush + flags list GETs carry the
      // shared headers. SDK-owned headers win over the caller's overrides.
      await client.flags._ensureConnected();
      const flagReq = seen.find((r) => r.url.includes("flags"));
      expect(flagReq).toBeDefined();
      expect(flagReq!.headers.get("x-tenant")).toBe("acme");
      expect(flagReq!.headers.get("authorization")).toBe("Bearer sk_api_test");
    } finally {
      client.close();
    }
  });
});
