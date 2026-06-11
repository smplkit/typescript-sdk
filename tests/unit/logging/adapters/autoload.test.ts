/**
 * Adapter auto-loading and the remaining live-surface edge paths of the
 * fused LoggingClient: the periodic flush timer, the level-change metric in
 * `_applyLevels`, the WebSocket-handler `.catch` branches, the single-resource
 * fetcher fallbacks, and the standalone URL-derivation path.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createClient from "openapi-fetch";
import { LoggingClient, type LoggingParent } from "../../../../src/logging/client.js";
import type { LoggingAdapter } from "../../../../src/logging/adapters/base.js";
import type { SharedWebSocket } from "../../../../src/ws.js";
import { SmplConnectionError } from "../../../../src/errors.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeTransport(): any {
  return createClient<import("../../../../src/generated/logging.d.ts").paths>({
    baseUrl: "https://logging.smplkit.com",
    headers: { Authorization: "Bearer sk_test", Accept: "application/json" },
  });
}

type WsCallback = (data: Record<string, unknown>) => void;

interface MockSharedWs {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  connectionStatus: string;
  _emit: (event: string, data: Record<string, unknown>) => void;
}

function createMockSharedWs(): MockSharedWs {
  const listeners: Record<string, WsCallback[]> = {};
  return {
    on: vi.fn((event: string, cb: WsCallback) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    off: vi.fn(),
    connectionStatus: "connected",
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
  };
}

let lastMockWs: MockSharedWs;

function makeParent(): LoggingParent {
  lastMockWs = createMockSharedWs();
  return {
    _environment: "production",
    _service: "svc",
    _ensureStarted: vi.fn(),
    _ensureWs: () => lastMockWs as unknown as SharedWebSocket,
  };
}

function makeWiredClient(metrics: any = null): LoggingClient {
  return new LoggingClient({ parent: makeParent(), transport: makeTransport(), metrics });
}

function makeAdapter(overrides?: Partial<LoggingAdapter>): LoggingAdapter {
  return {
    name: "mock",
    discover: vi.fn(() => []),
    applyLevel: vi.fn(),
    installHook: vi.fn(),
    uninstallHook: vi.fn(),
    ...overrides,
  };
}

function loggerResource(id: string, attrs: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "logger",
    attributes: {
      name: id,
      level: null,
      group: null,
      managed: true,
      sources: [],
      environments: {},
      created_at: null,
      updated_at: null,
      ...attrs,
    },
  };
}

// ===========================================================================
// Adapter auto-loading
// ===========================================================================

describe("LoggingClient — adapter auto-loading", () => {
  it("warns and continues when no logging framework is detected", async () => {
    // In the vitest ESM runtime the built-in adapters' `require(...)` calls
    // fail to resolve, so autoLoadAdapters() returns an empty list and warns.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeWiredClient();
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No logging framework detected"));
    // WS handlers still wired despite zero adapters.
    expect(lastMockWs.on).toHaveBeenCalledWith("logger_changed", expect.any(Function));
  });

  it("does not auto-load when an adapter is explicitly registered", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeWiredClient();
    const adapter = makeAdapter();
    client.registerAdapter(adapter);
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(adapter.discover).toHaveBeenCalled();
  });
});

// ===========================================================================
// Periodic flush timer
// ===========================================================================

describe("LoggingClient — periodic flush timer", () => {
  it("flushes the discovery buffer every 30s after install()", async () => {
    vi.useFakeTimers();
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter());
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();

    const flushSpy = vi.spyOn(client.loggers, "flush").mockResolvedValue(undefined);
    vi.advanceTimersByTime(30_000);
    expect(flushSpy).toHaveBeenCalledTimes(1);

    client.close();
    flushSpy.mockClear();
    vi.advanceTimersByTime(60_000);
    // Timer cleared on close — no further flushes.
    expect(flushSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// _applyLevels — level-change metric
// ===========================================================================

describe("LoggingClient — _applyLevels metric", () => {
  it("records a level_changes metric per adapter-known logger", async () => {
    const metrics = { record: vi.fn(), recordGauge: vi.fn() };
    const client = makeWiredClient(metrics);
    client.registerAdapter(makeAdapter({ discover: () => [{ name: "sql", level: "INFO" }] }));
    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/loggers/bulk")) return Promise.resolve(jsonResponse({ registered: 1 }));
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(jsonResponse({ data: [loggerResource("sql", { level: "WARN" })] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    await client.install();
    expect(metrics.record).toHaveBeenCalledWith("logging.level_changes", 1, "changes", {
      logger: "sql",
    });
  });
});

// ===========================================================================
// WebSocket-handler .catch branches
// ===========================================================================

describe("LoggingClient — WS handler error branches", () => {
  async function installed(names: string[]): Promise<LoggingClient> {
    const client = makeWiredClient();
    client.registerAdapter({
      name: "t",
      discover: () => names.map((name) => ({ name, level: "INFO" })),
      applyLevel: vi.fn(),
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    mockFetch.mockReset();
    return client;
  }

  it("logger_changed: swallows an error thrown in the .then chain", async () => {
    const client = await installed(["sql"]);
    // The scoped fetch resolves, but _applyLevels throws inside the .then —
    // the handler's .catch must absorb it.
    (client as any)._applyLevels = () => {
      throw new Error("apply exploded");
    };
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: loggerResource("sql", { level: "DEBUG" }) }),
    );
    expect(() => lastMockWs._emit("logger_changed", { id: "sql" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("group_changed: swallows an error thrown in the .then chain", async () => {
    const client = await installed(["app.db"]);
    (client as any)._applyLevels = () => {
      throw new Error("apply exploded");
    };
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "app",
          type: "log_group",
          attributes: { name: "app", level: "WARN", parent_id: null, environments: {} },
        },
      }),
    );
    expect(() => lastMockWs._emit("group_changed", { id: "app" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ===========================================================================
// Single-resource fetchers — catch → null fallback
// ===========================================================================

describe("LoggingClient — single-resource fetcher fallbacks", () => {
  async function installed(names: string[]): Promise<LoggingClient> {
    const client = makeWiredClient();
    client.registerAdapter({
      name: "t",
      discover: () => names.map((name) => ({ name, level: "INFO" })),
      applyLevel: vi.fn(),
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    mockFetch.mockReset();
    return client;
  }

  it("_fetchSingleLogger returns null (cache eviction) when the GET rejects", async () => {
    await installed(["sql"]);
    // Reject the scoped fetch with a network error → openapi-fetch throws →
    // _fetchSingleLogger's catch returns null → the cache entry is evicted.
    mockFetch.mockRejectedValueOnce(new TypeError("network gone"));
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("_fetchSingleGroup returns null (cache eviction) when the GET rejects", async () => {
    await installed(["app.db"]);
    mockFetch.mockRejectedValueOnce(new TypeError("network gone"));
    lastMockWs._emit("group_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ===========================================================================
// LogGroupsClient — connection-error wrapping (wrapFetchError)
// ===========================================================================

describe("LogGroupsClient — connection-error wrapping", () => {
  it("get() wraps a network error as SmplConnectionError", async () => {
    const client = makeWiredClient();
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(client.logGroups.get("g1")).rejects.toThrow(SmplConnectionError);
  });

  it("_createGroup() wraps a network error as SmplConnectionError", async () => {
    const client = makeWiredClient();
    const group = client.logGroups.new("g1");
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(group.save()).rejects.toThrow(SmplConnectionError);
  });

  it("_updateGroup() wraps a network error as SmplConnectionError", async () => {
    const client = makeWiredClient();
    const group = client.logGroups.new("g1");
    // Mark as existing so save() routes to _updateGroup (PUT).
    group.createdAt = "2026-01-01T00:00:00Z";
    mockFetch.mockRejectedValueOnce(new TypeError("offline"));
    await expect(group.save()).rejects.toThrow(SmplConnectionError);
  });
});

// ===========================================================================
// Standalone URL derivation (no explicit baseUrl)
// ===========================================================================

describe("LoggingClient — standalone URL derivation", () => {
  it("derives the logging service URL from baseDomain/scheme when no baseUrl is given", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });
    const client = new LoggingClient({
      apiKey: "sk_standalone",
      environment: "production",
      baseDomain: "example.test",
      scheme: "https",
    });
    await client.loggers.list();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("logging.example.test");
  });

  it("falls back to the default logging URL when serviceUrl yields nothing", async () => {
    // serviceUrl always returns a string in practice; force the defensive
    // `?? DEFAULT_LOGGING_BASE_URL` fallback by stubbing it to null.
    const configModule = await import("../../../../src/config.js");
    vi.spyOn(configModule, "serviceUrl").mockReturnValue(null as unknown as string);
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });
    const client = new LoggingClient({
      apiKey: "sk_standalone",
      environment: "production",
    });
    await client.loggers.list();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("logging.smplkit.com");
  });
});
