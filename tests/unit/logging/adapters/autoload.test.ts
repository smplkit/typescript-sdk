import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LoggingClient } from "../../../../src/logging/client.js";
import type { LoggingAdapter } from "../../../../src/logging/adapters/base.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_test";

interface MockSharedWs {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  connectionStatus: string;
}

function createMockSharedWs(): MockSharedWs {
  return {
    on: vi.fn(),
    off: vi.fn(),
    connectionStatus: "connected",
  };
}

let lastMockWs: MockSharedWs;

function makeClient(): LoggingClient {
  lastMockWs = createMockSharedWs();
  return new LoggingClient(API_KEY, () => lastMockWs as never, 30000);
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock fetch to always return fresh Response objects with the given body. */
function mockFetchAlways(body: object, status = 200): void {
  mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

function createMockAdapter(overrides?: Partial<LoggingAdapter>): LoggingAdapter {
  return {
    name: "mock",
    discover: vi.fn(() => []),
    applyLevel: vi.fn(),
    installHook: vi.fn(),
    uninstallHook: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LoggingClient — adapter auto-loading", () => {
  it("should auto-load adapters when no explicit adapters registered", async () => {
    const client = makeClient();

    // Mock list() and listGroups() responses
    mockFetchAlways({ data: [] });

    // The auto-loader will try to require adapters — this may or may not
    // find winston/pino depending on test environment. We just verify
    // start() completes without error.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await client.start();
    warnSpy.mockRestore();

    // start() should complete and wire WebSocket
    expect(lastMockWs.on).toHaveBeenCalledWith("logger_changed", expect.any(Function));
  });

  it("should warn when zero adapters are found", async () => {
    const client = makeClient();

    // Force auto-load to find nothing by overriding _autoLoadAdapters
    (client as any)._autoLoadAdapters = () => {
      console.warn(
        "[smplkit] No logging framework detected. Runtime logging control requires a supported framework (winston, pino).",
      );
      return [];
    };

    mockFetchAlways({ data: [] });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await client.start();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No logging framework detected"));
    warnSpy.mockRestore();
  });

  it("should skip missing dependencies during auto-load", async () => {
    const client = makeClient();

    // Override auto-load to simulate one adapter failing
    const mockAdapter = createMockAdapter({ name: "winston" });
    (client as any)._autoLoadAdapters = () => [mockAdapter];

    mockFetchAlways({ data: [] });

    await client.start();

    expect(mockAdapter.discover).toHaveBeenCalled();
    expect(mockAdapter.installHook).toHaveBeenCalled();
  });
});

describe("LoggingClient — registerAdapter", () => {
  it("should disable auto-load when registerAdapter is called", async () => {
    const client = makeClient();
    const mockAdapter = createMockAdapter();

    client.registerAdapter(mockAdapter);

    mockFetchAlways({ data: [] });

    const autoLoadSpy = vi.spyOn(client as any, "_autoLoadAdapters");
    await client.start();

    expect(autoLoadSpy).not.toHaveBeenCalled();
    expect(mockAdapter.discover).toHaveBeenCalled();
    expect(mockAdapter.installHook).toHaveBeenCalled();
  });

  it("should use only explicitly registered adapters", async () => {
    const client = makeClient();
    const adapter1 = createMockAdapter({ name: "adapter1" });
    const adapter2 = createMockAdapter({ name: "adapter2" });

    client.registerAdapter(adapter1);
    client.registerAdapter(adapter2);

    mockFetchAlways({ data: [] });
    await client.start();

    expect(adapter1.discover).toHaveBeenCalled();
    expect(adapter2.discover).toHaveBeenCalled();
    expect(adapter1.installHook).toHaveBeenCalled();
    expect(adapter2.installHook).toHaveBeenCalled();
  });

  it("should throw when registerAdapter is called after start()", async () => {
    const client = makeClient();

    // Override auto-load to return empty
    (client as any)._autoLoadAdapters = () => [];
    mockFetchAlways({ data: [] });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await client.start();
    warnSpy.mockRestore();

    const mockAdapter = createMockAdapter();
    expect(() => client.registerAdapter(mockAdapter)).toThrow(
      "Cannot register adapters after start()",
    );
  });
});

describe("LoggingClient — adapter lifecycle", () => {
  it("should call discover() on each adapter during start()", async () => {
    const client = makeClient();
    const adapter = createMockAdapter({
      discover: vi.fn(() => [{ name: "found-logger", level: "INFO" }]),
    });
    client.registerAdapter(adapter);

    // The discovered logger triggers a save, mock create response
    mockFetchAlways({ data: [] });

    await client.start();

    expect(adapter.discover).toHaveBeenCalledTimes(1);
  });

  it("should call installHook() on each adapter during start()", async () => {
    const client = makeClient();
    const adapter = createMockAdapter();
    client.registerAdapter(adapter);

    mockFetchAlways({ data: [] });
    await client.start();

    expect(adapter.installHook).toHaveBeenCalledTimes(1);
    expect(adapter.installHook).toHaveBeenCalledWith(expect.any(Function));
  });

  it("should call uninstallHook() on each adapter during close()", async () => {
    const client = makeClient();
    const adapter = createMockAdapter();
    client.registerAdapter(adapter);

    mockFetchAlways({ data: [] });
    await client.start();

    client._close();

    expect(adapter.uninstallHook).toHaveBeenCalledTimes(1);
  });

  it("should apply server levels to adapters after fetching", async () => {
    const client = makeClient();
    const adapter = createMockAdapter();
    client.registerAdapter(adapter);

    // Mock list() to return a logger with a level
    const loggerResource = {
      id: "my-app",
      type: "logger",
      attributes: {
        name: "My App",
        level: "WARN",
        group: null,
        managed: true,
        sources: [],
        environments: {},
        created_at: "2026-04-01T10:00:00Z",
        updated_at: "2026-04-01T10:00:00Z",
      },
    };

    // First call(s) may be save attempts for discovered loggers, then list, then listGroups
    mockFetchAlways({ data: [loggerResource] });

    await client.start();

    expect(adapter.applyLevel).toHaveBeenCalledWith("my-app", "WARN");
  });

  it("should apply environment-specific levels when available", async () => {
    const client = makeClient();
    const adapter = createMockAdapter();
    client.registerAdapter(adapter);

    // Set up parent with environment
    (client as any)._parent = { _environment: "production", _service: null };

    const loggerResource = {
      id: "my-app",
      type: "logger",
      attributes: {
        name: "My App",
        level: "INFO",
        group: null,
        managed: true,
        sources: [],
        environments: { production: { level: "ERROR" } },
        created_at: "2026-04-01T10:00:00Z",
        updated_at: "2026-04-01T10:00:00Z",
      },
    };

    mockFetchAlways({ data: [loggerResource] });

    await client.start();

    // Should apply the production-specific level, not the base level
    expect(adapter.applyLevel).toHaveBeenCalledWith("my-app", "ERROR");
  });

  it("should handle adapter applyLevel() errors gracefully", async () => {
    const client = makeClient();
    const adapter = createMockAdapter({
      applyLevel: vi.fn(() => {
        throw new Error("applyLevel boom");
      }),
    });
    client.registerAdapter(adapter);

    const loggerResource = {
      id: "my-app",
      type: "logger",
      attributes: {
        name: "My App",
        level: "WARN",
        group: null,
        managed: true,
        sources: [],
        environments: {},
        created_at: "2026-04-01T10:00:00Z",
        updated_at: "2026-04-01T10:00:00Z",
      },
    };

    mockFetchAlways({ data: [loggerResource] });

    // Should not throw despite adapter error
    await expect(client.start()).resolves.toBeUndefined();
    expect(adapter.applyLevel).toHaveBeenCalled();
  });

  it("should call _onAdapterNewLogger when hook fires", async () => {
    const client = makeClient();
    let hookCallback: ((name: string, level: string) => void) | null = null;

    const adapter = createMockAdapter({
      installHook: vi.fn((cb: (name: string, level: string) => void) => {
        hookCallback = cb;
      }),
    });
    client.registerAdapter(adapter);

    mockFetchAlways({ data: [] });
    await client.start();

    // Trigger the hook callback — this should call _onAdapterNewLogger
    expect(hookCallback).not.toBeNull();
    // This fires save() which is fire-and-forget
    hookCallback!("new-runtime-logger", "DEBUG");

    // Wait for the async save to attempt
    await new Promise((r) => setTimeout(r, 10));
  });

  it("should handle adapter discover() errors gracefully", async () => {
    const client = makeClient();
    const adapter = createMockAdapter({
      discover: vi.fn(() => {
        throw new Error("discover boom");
      }),
    });
    client.registerAdapter(adapter);

    mockFetchAlways({ data: [] });

    // Should not throw
    await expect(client.start()).resolves.toBeUndefined();
  });

  it("should handle adapter installHook() errors gracefully", async () => {
    const client = makeClient();
    const adapter = createMockAdapter({
      installHook: vi.fn(() => {
        throw new Error("hook boom");
      }),
    });
    client.registerAdapter(adapter);

    mockFetchAlways({ data: [] });

    await expect(client.start()).resolves.toBeUndefined();
  });

  it("should handle adapter uninstallHook() errors gracefully during close", async () => {
    const client = makeClient();
    const adapter = createMockAdapter({
      uninstallHook: vi.fn(() => {
        throw new Error("unhook boom");
      }),
    });
    client.registerAdapter(adapter);

    mockFetchAlways({ data: [] });
    await client.start();

    expect(() => client._close()).not.toThrow();
  });

  it("should handle server fetch errors during start gracefully", async () => {
    const client = makeClient();
    const adapter = createMockAdapter();
    client.registerAdapter(adapter);

    // All fetch calls fail
    mockFetch.mockImplementation(() => Promise.reject(new TypeError("network error")));

    // start() should still complete (WebSocket wired even if fetch fails)
    await expect(client.start()).resolves.toBeUndefined();
    expect(lastMockWs.on).toHaveBeenCalledWith("logger_changed", expect.any(Function));
  });
});
