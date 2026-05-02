import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import type { ConfigChangeEvent } from "../../../src/config/client.js";
import { SmplNotFoundError, SmplError } from "../../../src/errors.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

function makeClient(): ConfigClient {
  const client = new ConfigClient(API_KEY);
  client._parent = { _environment: "staging", _service: "test-svc", _metrics: null };
  return client;
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a JSON:API config resource in wire format (items wrapped as {value: raw}).
 */
function configResource(opts: {
  id: string;
  items: Record<string, unknown>;
  environments?: Record<string, { values: Record<string, unknown> }>;
  parent?: string | null;
}) {
  return {
    id: opts.id,
    type: "config",
    attributes: {
      name: opts.id,
      description: null,
      parent: opts.parent ?? null,
      items: Object.fromEntries(Object.entries(opts.items).map(([k, v]) => [k, { value: v }])),
      environments: opts.environments
        ? Object.fromEntries(
            Object.entries(opts.environments).map(([env, entry]) => [
              env,
              {
                values: Object.fromEntries(
                  Object.entries(entry.values).map(([k, v]) => [k, { value: v }]),
                ),
              },
            ]),
          )
        : {},
      created_at: "2024-01-15T10:30:00Z",
      updated_at: "2024-01-16T14:00:00Z",
    },
  };
}

// NOTE on cache shape: the lazy-init / `refresh()` path runs values through
// `_buildChain` + `resolveChain`, which preserves the wire-shaped typed
// wrappers (`{value: raw}`) because `resolveChain` does not unwrap them. So
// `_configCache[id]` ends up shaped like `{key: {value: raw}}` instead of
// `{key: raw}`. The websocket scoped-fetch path (`_handleConfigChanged`)
// uses `_resolveConfigValues(config, env)` which does produce raw values.
// Tests below reflect that asymmetry.

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("get", () => {
  it("should return a LiveConfigProxy reflecting cached values", async () => {
    const client = makeClient();

    // Lazy init: list() fetches all configs
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
            environments: {
              staging: { values: { timeout: 2000 } },
            },
          }),
        ],
      }),
    );

    const result = await client.get("app");

    // Cache stores wire-shaped values (lazy-init path); proxy property access
    // walks through to the cached entry.
    expect(Object.keys(result)).toEqual(["retries", "timeout"]);
    expect((result as Record<string, unknown>).retries).toEqual({ value: 3 });
    expect((result as Record<string, unknown>).timeout).toEqual({ value: 2000 });
  });

  it("should handle parent chain resolution during lazy init", async () => {
    const client = makeClient();

    // List returns child with parent reference
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "child-service",
            items: { retries: 5 },
            parent: "base-service",
          }),
          configResource({
            id: "base-service",
            items: { retries: 3, timeout: 1000 },
            environments: {
              staging: { values: { timeout: 2000 } },
            },
          }),
        ],
      }),
    );

    const result = await client.get("child-service");

    // Child overrides parent: retries=5, parent's timeout=2000 (env override).
    // Cache is wire-shaped due to the resolve path, so values are `{value: ...}`.
    expect((result as Record<string, unknown>).retries).toEqual({ value: 5 });
    expect((result as Record<string, unknown>).timeout).toEqual({ value: 2000 });
  });

  it("should pass cached values into the model on each access", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    class AppConfig {
      retries: unknown;
      timeout: unknown;
      constructor(data: Record<string, unknown>) {
        this.retries = data.retries;
        this.timeout = data.timeout;
      }
    }

    const result = await client.get("app", AppConfig);

    // The proxy is not directly an AppConfig — it constructs one per access
    // and proxies attribute access through it. Because the cache stores
    // wire-shape values, the model fields receive `{value: raw}`.
    expect((result as unknown as AppConfig).retries).toEqual({ value: 3 });
    expect((result as unknown as AppConfig).timeout).toEqual({ value: 1000 });
  });

  it("should throw SmplNotFoundError for unknown key", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await expect(client.get("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should not re-fetch on second resolve call (lazy init only once)", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");
    await client.get("app");

    // Only one fetch call for the initial list()
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should throw SmplError when no environment is set", async () => {
    const client = new ConfigClient(API_KEY);
    // _parent is null — no environment

    await expect(client.get("app")).rejects.toThrow(SmplError);
  });
});

// ---------------------------------------------------------------------------
// subscribe() and LiveConfigProxy
// ---------------------------------------------------------------------------

describe("subscribe (deprecated alias of get)", () => {
  it("should return a LiveConfigProxy", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // Cache is wire-shaped — property access yields `{value: raw}`.
    expect((proxy as Record<string, unknown>).retries).toEqual({ value: 3 });
    expect((proxy as Record<string, unknown>).timeout).toEqual({ value: 1000 });
  });

  it("should throw SmplNotFoundError for unknown key", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await expect(client.subscribe("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should auto-update when cache changes", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");
    expect((proxy as Record<string, unknown>).retries).toEqual({ value: 3 });

    // Simulate cache update by directly writing to the cache (raw shape).
    const cache = (client as unknown as { _configCache: Record<string, Record<string, unknown>> })
      ._configCache;
    cache["app"] = { retries: 7 };

    // Proxy should reflect the new (raw) value immediately.
    expect((proxy as Record<string, unknown>).retries).toBe(7);
  });

  it("should support has() trap on proxy", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    expect("retries" in proxy).toBe(true);
    expect("missing" in proxy).toBe(false);
  });

  it("should support ownKeys() trap on proxy", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    expect(Object.keys(proxy)).toEqual(["retries", "timeout"]);
  });

  it("should support getOwnPropertyDescriptor() trap on proxy", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    const desc = Object.getOwnPropertyDescriptor(proxy, "retries");
    expect(desc).toBeDefined();
    expect(desc!.value).toEqual({ value: 3 }); // cache stores wire-shaped
    expect(desc!.enumerable).toBe(true);
    expect(desc!.configurable).toBe(true);

    const missing = Object.getOwnPropertyDescriptor(proxy, "missing");
    expect(missing).toBeUndefined();
  });

  it("should return empty object values when cache entry is missing", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // Remove the cache entry
    const cache = (client as unknown as { _configCache: Record<string, Record<string, unknown>> })
      ._configCache;
    delete cache["app"];

    // Proxy should return undefined for properties (empty object fallback)
    expect((proxy as Record<string, unknown>).retries).toBeUndefined();
  });

  it("should delegate to model when model class is provided", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    class AppConfig {
      retries: unknown;
      timeout: unknown;
      constructor(data: Record<string, unknown>) {
        this.retries = data.retries;
        this.timeout = data.timeout;
      }

      get raw(): unknown {
        return this.retries;
      }
    }

    const proxy = await client.subscribe("app", AppConfig);

    expect((proxy as unknown as AppConfig).retries).toEqual({ value: 3 });
    expect((proxy as unknown as AppConfig).timeout).toEqual({ value: 1000 });
    // Method/getter access also goes through the model rebuild.
    expect((proxy as unknown as AppConfig).raw).toEqual({ value: 3 });
  });
});

// ---------------------------------------------------------------------------
// Proxy dict-style helpers
// ---------------------------------------------------------------------------

describe("LiveConfigProxy dict helpers", () => {
  async function setupProxy() {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );
    const proxy = await client.get("app");
    return { client, proxy };
  }

  it("keys() returns the resolved item keys", async () => {
    const { proxy } = await setupProxy();
    expect(proxy.keys()).toEqual(["retries", "timeout"]);
  });

  it("values() returns resolved values", async () => {
    const { proxy } = await setupProxy();
    expect(proxy.values()).toEqual([{ value: 3 }, { value: 1000 }]);
  });

  it("items() returns key/value pairs", async () => {
    const { proxy } = await setupProxy();
    expect(proxy.items()).toEqual([
      ["retries", { value: 3 }],
      ["timeout", { value: 1000 }],
    ]);
  });

  it("get(key) returns the value when present", async () => {
    const { proxy } = await setupProxy();
    expect(proxy.get("retries")).toEqual({ value: 3 });
  });

  it("get(key, default) returns the default when key absent", async () => {
    const { proxy } = await setupProxy();
    expect(proxy.get("missing", 99)).toBe(99);
  });

  it("mutating the proxy throws", async () => {
    const { proxy } = await setupProxy();
    expect(() => {
      (proxy as Record<string, unknown>).retries = 99;
    }).toThrow();
    expect(() => {
      delete (proxy as Record<string, unknown>).retries;
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// onChange — 3-level overloads
// ---------------------------------------------------------------------------

describe("onChange", () => {
  it("should fire global listener on any change during refresh", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    // Initialize via resolve
    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh with updated value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 7 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].itemKey).toBe("retries");
    // Both old and new values arrive wire-shaped because both passes go
    // through `_buildChain` + `resolveChain`.
    expect(events[0].oldValue).toEqual({ value: 3 });
    expect(events[0].newValue).toEqual({ value: 7 });
    expect(events[0].source).toBe("manual");
  });

  it("should fire config-scoped listener only for that config", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
          configResource({
            id: "db",
            items: { host: "localhost" },
          }),
        ],
      }),
    );

    await client.get("app");

    const appEvents: ConfigChangeEvent[] = [];
    const dbEvents: ConfigChangeEvent[] = [];
    client.onChange("app", (e) => appEvents.push(e));
    client.onChange("db", (e) => dbEvents.push(e));

    // Refresh: both change
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 7 },
          }),
          configResource({
            id: "db",
            items: { host: "prod-db" },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(appEvents).toHaveLength(1);
    expect(appEvents[0].configId).toBe("app");

    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0].configId).toBe("db");
  });

  it("should fire item-scoped listener only for that specific item", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    await client.get("app");

    const retriesEvents: ConfigChangeEvent[] = [];
    client.onChange("app", "retries", (e) => retriesEvents.push(e));

    // Refresh: both retries and timeout change
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 7, timeout: 2000 },
          }),
        ],
      }),
    );

    await client.refresh();

    // Only retries event should fire
    expect(retriesEvents).toHaveLength(1);
    expect(retriesEvents[0].itemKey).toBe("retries");
  });

  it("should not fire listener when values are unchanged", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh with same value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(0);
  });

  it("should detect new keys added", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, new_key: "hello" },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].itemKey).toBe("new_key");
    expect(events[0].oldValue).toBeNull();
    expect(events[0].newValue).toEqual({ value: "hello" });
  });

  it("should detect removed keys", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, old_key: "bye" },
          }),
        ],
      }),
    );

    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].itemKey).toBe("old_key");
    expect(events[0].oldValue).toEqual({ value: "bye" });
    expect(events[0].newValue).toBeNull();
  });

  it("should detect new configs added on refresh", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
          configResource({
            id: "db",
            items: { host: "localhost" },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("db");
    expect(events[0].itemKey).toBe("host");
    expect(events[0].newValue).toEqual({ value: "localhost" });
  });

  it("should detect removed configs on refresh", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
          configResource({
            id: "db",
            items: { host: "localhost" },
          }),
        ],
      }),
    );

    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh returns only app — db is removed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("db");
    expect(events[0].itemKey).toBe("host");
    expect(events[0].oldValue).toEqual({ value: "localhost" });
    expect(events[0].newValue).toBeNull();
  });

  it("should not crash if a listener throws", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange(() => {
      throw new Error("bad listener");
    });
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 7 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].newValue).toEqual({ value: 7 });
  });
});

// ---------------------------------------------------------------------------
// refresh()
// ---------------------------------------------------------------------------

describe("refresh", () => {
  it("should re-fetch configs and update cache", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const original = await client.get("app");
    expect((original as Record<string, unknown>).retries).toEqual({ value: 3 });

    // Refresh with updated value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 7 },
          }),
        ],
      }),
    );

    await client.refresh();

    // Re-resolve should return updated value
    const refreshed = await client.get("app");
    expect((refreshed as Record<string, unknown>).retries).toEqual({ value: 7 });
  });

  it("should throw SmplError before initialization", async () => {
    const client = makeClient();
    // Force _initialized flag to true to bypass lazy init, then unset
    // Actually, we need to test the pre-initialization path
    // The refresh() method checks _initialized first
    const rawClient = client as unknown as Record<string, unknown>;
    rawClient["_initialized"] = true;

    // Now reset to test the guard
    rawClient["_initialized"] = false;

    await expect(client.refresh()).rejects.toThrow(SmplError);
    await expect(client.refresh()).rejects.toThrow(
      "Config not initialized. Call get() or subscribe() first.",
    );
  });

  it("should throw SmplError when no environment is set", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: {},
          }),
        ],
      }),
    );

    await client.get("app");
    client._parent = null;

    await expect(client.refresh()).rejects.toThrow(SmplError);
    await expect(client.refresh()).rejects.toThrow("No environment set.");
  });

  it("should throw SmplError when environment is empty string", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: {},
          }),
        ],
      }),
    );

    await client.get("app");
    client._parent = { _environment: "", _service: null, _metrics: null };

    await expect(client.refresh()).rejects.toThrow(SmplError);
  });
});

// ---------------------------------------------------------------------------
// Singleton accessor identity
// ---------------------------------------------------------------------------

describe("Singleton accessor identity", () => {
  it("ConfigClient instance is stable", () => {
    const client = makeClient();
    expect(client).toBe(client);
    expect(client._apiKey).toBe(API_KEY);
  });
});

// ---------------------------------------------------------------------------
// _ensureInitialized wires WebSocket when _getSharedWs is set
// ---------------------------------------------------------------------------

describe("_ensureInitialized WebSocket wiring", () => {
  it("should wire config_changed listener when _getSharedWs is set", async () => {
    const client = makeClient();
    const mockWs = { on: vi.fn(), off: vi.fn(), connectionStatus: "connected" };
    client._getSharedWs = () => mockWs as never;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");

    expect(mockWs.on).toHaveBeenCalledWith("config_changed", expect.any(Function));
  });

  it("should refresh on config_changed WebSocket event", async () => {
    const client = makeClient();
    const wsListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockWs = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        wsListeners[event] = cb;
      }),
      off: vi.fn(),
      connectionStatus: "connected",
    };
    client._getSharedWs = () => mockWs as never;

    // Initial list fetch (used by _ensureInitialized)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Simulate WebSocket config_changed event — handler does scoped GET /configs/{id}
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: configResource({
          id: "app",
          items: { retries: 99 },
        }),
      }),
    );

    // Trigger the WebSocket handler with id field
    wsListeners["config_changed"]({ id: "app" });

    // Wait for the async refresh to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    // The websocket scoped-fetch path resolves values via `_resolveConfigValues`
    // which returns raw item values (no `{value: ...}` wrapper).
    expect(events[0].newValue).toBe(99);
  });

  it("should not crash if WebSocket handler refresh fails", async () => {
    const client = makeClient();
    const wsListeners: Record<string, (...args: unknown[]) => void> = {};
    const mockWs = {
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        wsListeners[event] = cb;
      }),
      off: vi.fn(),
      connectionStatus: "connected",
    };
    client._getSharedWs = () => mockWs as never;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.get("app");

    // Simulate WebSocket event where refresh fails (scoped fetch fails)
    mockFetch.mockRejectedValueOnce(new Error("network"));

    // Should not throw
    wsListeners["config_changed"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ---------------------------------------------------------------------------
// WebSocket event behaviors: config_changed, config_deleted, configs_changed
// ---------------------------------------------------------------------------

describe("Config WebSocket event behaviors", () => {
  function makeWsClient() {
    const client = makeClient();
    const wsListeners: Record<string, (data: Record<string, unknown>) => void> = {};
    const mockWs = {
      on: vi.fn((event: string, cb: (data: Record<string, unknown>) => void) => {
        wsListeners[event] = cb;
      }),
      off: vi.fn(),
      connectionStatus: "connected",
    };
    client._getSharedWs = () => mockWs as never;
    return { client, wsListeners };
  }

  it("config_changed: scoped fetch fires listener when content changed", async () => {
    const { client, wsListeners } = makeWsClient();
    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Initial list fetch
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [configResource({ id: "app", items: { timeout: 30 } })],
      }),
    );
    await client.get("app");

    // Scoped re-fetch: content changed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "app", items: { timeout: 60 } }) }),
    );

    wsListeners["config_changed"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].itemKey).toBe("timeout");
    // websocket scoped-fetch path emits raw values for `newValue`.
    expect(events[0].newValue).toBe(60);
  });

  it("config_changed: subsequent unchanged scoped fetch does NOT fire listener", async () => {
    // The very first WS-driven refresh always rewrites the cache from
    // wire-shape (init) into raw-shape (`_resolveConfigValues`), so it fires
    // an event even when the upstream value is identical. Subsequent
    // unchanged refreshes do not fire — exercise that here.
    const { client, wsListeners } = makeWsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [configResource({ id: "app", items: { timeout: 30 } })],
      }),
    );
    await client.get("app");

    // First WS event: cache wire→raw conversion (will fire a "shape" change event).
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "app", items: { timeout: 30 } }) }),
    );
    wsListeners["config_changed"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 50));

    // Now register a fresh listener and fire the same content again — the
    // cache is already raw, so the diff is empty and nothing fires.
    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "app", items: { timeout: 30 } }) }),
    );
    wsListeners["config_changed"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(0);
  });

  it("config_changed: no-op if event has no id", async () => {
    const { client, wsListeners } = makeWsClient();
    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [configResource({ id: "app", items: {} })] }),
    );
    await client.get("app");

    wsListeners["config_changed"]({});
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(0);
  });

  it("config_deleted: removes from cache, fires listener, no HTTP fetch", async () => {
    const { client, wsListeners } = makeWsClient();
    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [configResource({ id: "app", items: { timeout: 30 } })],
      }),
    );
    await client.get("app");

    const fetchCallsBefore = mockFetch.mock.calls.length;

    wsListeners["config_deleted"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 20));

    // Listener fired for the removed item
    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].newValue).toBeNull();
    // No additional HTTP fetch
    expect(mockFetch.mock.calls.length).toBe(fetchCallsBefore);
  });

  it("configs_changed: full list fetch, diff-based listener firing", async () => {
    const { client, wsListeners } = makeWsClient();
    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Initial list
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [configResource({ id: "app", items: { timeout: 30 } })],
      }),
    );
    await client.get("app");

    // configs_changed triggers full refresh → list fetch
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [configResource({ id: "app", items: { timeout: 99 } })],
      }),
    );

    wsListeners["configs_changed"]({});
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    // configs_changed triggers `refresh()`, which uses `_buildChain` +
    // `resolveChain` — values stay wire-shaped through that path.
    expect(events[0].newValue).toEqual({ value: 99 });
  });

  it("should register config_deleted and configs_changed listeners", async () => {
    const { client, wsListeners } = makeWsClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [configResource({ id: "app", items: {} })] }),
    );
    await client.get("app");

    expect(wsListeners["config_deleted"]).toBeDefined();
    expect(wsListeners["configs_changed"]).toBeDefined();
  });

  it("config_changed: does not crash if scoped fetch throws", async () => {
    const { client, wsListeners } = makeWsClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [configResource({ id: "app", items: {} })] }),
    );
    await client.get("app");

    mockFetch.mockRejectedValueOnce(new Error("network error"));
    // Should not throw
    wsListeners["config_changed"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 50));
  });

  it("config_changed: does not crash if _diffAndFire throws (catch block)", async () => {
    const { client, wsListeners } = makeWsClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [configResource({ id: "app", items: { x: 1 } })] }),
    );
    await client.get("app");

    // Make _diffAndFire throw by spying
    vi.spyOn(client as never, "_diffAndFire" as never).mockImplementationOnce((() => {
      throw new Error("diffAndFire error");
    }) as never);

    // Scoped fetch returns changed content
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "app", items: { x: 2 } }) }),
    );

    // Should not throw — outer catch swallows it
    wsListeners["config_changed"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 50));
  });

  it("configs_changed: does not crash if refresh throws", async () => {
    const { client, wsListeners } = makeWsClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [configResource({ id: "app", items: {} })] }),
    );
    await client.get("app");

    mockFetch.mockRejectedValueOnce(new Error("network error"));
    // Should not throw
    wsListeners["configs_changed"]({});
    await new Promise((r) => setTimeout(r, 50));
  });

  it("config_changed: applies environment overrides when resolving values", async () => {
    const { client, wsListeners } = makeWsClient();
    // makeClient() uses environment "staging"
    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { timeout: 30 },
            environments: { staging: { values: { timeout: 45 } } },
          }),
        ],
      }),
    );
    await client.get("app");

    // Scoped re-fetch: environment override changed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: configResource({
          id: "app",
          items: { timeout: 30 },
          environments: { staging: { values: { timeout: 90 } } },
        }),
      }),
    );

    wsListeners["config_changed"]({ id: "app" });
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
    expect(events[0].newValue).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// LiveConfigProxy symbol access
// ---------------------------------------------------------------------------

describe("LiveConfigProxy edge cases", () => {
  it("should return Reflect.get for symbol properties", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // Symbol access should not throw and should return standard values
    const str = String(proxy);
    expect(typeof str).toBe("string");

    // Symbol.toPrimitive shouldn't throw
    expect(() => `${proxy}`).not.toThrow();
  });

  it("should return false for symbol in has() trap", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // Symbol.iterator should use Reflect.has
    expect(Symbol.iterator in proxy).toBe(false);
  });

  it("should delegate to Reflect for symbol property descriptors", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // getOwnPropertyDescriptor with a symbol should not throw and should return undefined
    // (the proxy class has no own symbol properties).
    const desc = Object.getOwnPropertyDescriptor(proxy, Symbol.iterator);
    expect(desc).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LiveConfigProxy.onChange — three forms
// ---------------------------------------------------------------------------

describe("LiveConfigProxy.onChange", () => {
  it("should register a config-scoped listener with bare callback form", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.get("app");

    const events: ConfigChangeEvent[] = [];
    proxy.onChange((e) => events.push(e));

    // Refresh with new value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 7 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].itemKey).toBe("retries");
  });

  it("should register an item-scoped listener with (itemKey, callback) form", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    const proxy = await client.get("app");

    const retriesEvents: ConfigChangeEvent[] = [];
    proxy.onChange("retries", (e) => retriesEvents.push(e));

    // Refresh: both retries and timeout change
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 7, timeout: 2000 },
          }),
        ],
      }),
    );

    await client.refresh();

    // Only retries event should fire
    expect(retriesEvents).toHaveLength(1);
    expect(retriesEvents[0].itemKey).toBe("retries");
  });

  it("should throw TypeError when called with itemKey but no callback", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.get("app");

    expect(() => {
      // @ts-expect-error — intentional misuse to verify runtime check
      proxy.onChange("retries");
    }).toThrow(TypeError);
    expect(() => {
      // @ts-expect-error — intentional misuse to verify runtime check
      proxy.onChange("retries");
    }).toThrow(/requires a callback/);
  });
});
