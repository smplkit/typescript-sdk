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
  client._parent = { _environment: "staging", _service: "test-svc" };
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
  key: string;
  items: Record<string, unknown>;
  environments?: Record<string, { values: Record<string, unknown> }>;
  parent?: string | null;
}) {
  return {
    id: opts.id,
    type: "config",
    attributes: {
      key: opts.key,
      name: opts.key,
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

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

describe("resolve", () => {
  it("should return resolved flat dict", async () => {
    const client = makeClient();

    // Lazy init: list() fetches all configs
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3, timeout: 1000 },
            environments: {
              staging: { values: { timeout: 2000 } },
            },
          }),
        ],
      }),
    );

    const result = await client.resolve("app");

    expect(result).toEqual({ retries: 3, timeout: 2000 });
  });

  it("should handle parent chain resolution during lazy init", async () => {
    const client = makeClient();

    // List returns child with parent reference
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "child-id",
            key: "child-service",
            items: { retries: 5 },
            parent: "parent-id",
          }),
          configResource({
            id: "parent-id",
            key: "base-service",
            items: { retries: 3, timeout: 1000 },
            environments: {
              staging: { values: { timeout: 2000 } },
            },
          }),
        ],
      }),
    );

    // _buildChain for child calls _getById(parent-id)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: configResource({
          id: "parent-id",
          key: "base-service",
          items: { retries: 3, timeout: 1000 },
          environments: {
            staging: { values: { timeout: 2000 } },
          },
        }),
      }),
    );

    const result = await client.resolve("child-service");

    // Child overrides parent: retries=5, parent's timeout=2000 (env override for staging)
    expect(result).toEqual({ retries: 5, timeout: 2000 });
  });

  it("should return typed model instance when model is provided", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    class AppConfig {
      retries: number;
      timeout: number;
      constructor(data: Record<string, unknown>) {
        this.retries = data.retries as number;
        this.timeout = data.timeout as number;
      }
    }

    const result = await client.resolve("app", AppConfig);

    expect(result).toBeInstanceOf(AppConfig);
    expect(result.retries).toBe(3);
    expect(result.timeout).toBe(1000);
  });

  it("should throw SmplNotFoundError for unknown key", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await expect(client.resolve("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should not re-fetch on second resolve call (lazy init only once)", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");
    await client.resolve("app");

    // Only one fetch call for the initial list()
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should throw SmplError when no environment is set", async () => {
    const client = new ConfigClient(API_KEY);
    // _parent is null — no environment

    await expect(client.resolve("app")).rejects.toThrow(SmplError);
  });
});

// ---------------------------------------------------------------------------
// subscribe() and LiveConfigProxy
// ---------------------------------------------------------------------------

describe("subscribe", () => {
  it("should return a LiveConfigProxy", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // Proxy should reflect cached values via property access
    expect((proxy as Record<string, unknown>).retries).toBe(3);
    expect((proxy as Record<string, unknown>).timeout).toBe(1000);
  });

  it("should throw SmplNotFoundError for unknown key", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");
    expect((proxy as Record<string, unknown>).retries).toBe(3);

    // Simulate cache update by directly writing to the cache
    const cache = (client as Record<string, unknown>)["_configCache"] as Record<
      string,
      Record<string, unknown>
    >;
    cache["app"] = { retries: 7 };

    // Proxy should reflect the new value immediately
    expect((proxy as Record<string, unknown>).retries).toBe(7);
  });

  it("should support has() trap on proxy", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
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
            id: "cfg-1",
            key: "app",
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    const desc = Object.getOwnPropertyDescriptor(proxy, "retries");
    expect(desc).toBeDefined();
    expect(desc!.value).toBe(3);
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // Remove the cache entry
    const cache = (client as Record<string, unknown>)["_configCache"] as Record<
      string,
      Record<string, unknown>
    >;
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    class AppConfig {
      retries: number;
      timeout: number;
      constructor(data: Record<string, unknown>) {
        this.retries = data.retries as number;
        this.timeout = data.timeout as number;
      }

      get totalWait(): number {
        return this.retries * this.timeout;
      }
    }

    const proxy = await client.subscribe("app", AppConfig);

    expect((proxy as unknown as AppConfig).retries).toBe(3);
    expect((proxy as unknown as AppConfig).timeout).toBe(1000);
    expect((proxy as unknown as AppConfig).totalWait).toBe(3000);
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    // Initialize via resolve
    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh with updated value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 7 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configKey).toBe("app");
    expect(events[0].itemKey).toBe("retries");
    expect(events[0].oldValue).toBe(3);
    expect(events[0].newValue).toBe(7);
    expect(events[0].source).toBe("manual");
  });

  it("should fire config-scoped listener only for that config", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
          configResource({
            id: "cfg-2",
            key: "db",
            items: { host: "localhost" },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const appEvents: ConfigChangeEvent[] = [];
    const dbEvents: ConfigChangeEvent[] = [];
    client.onChange("app", (e) => appEvents.push(e));
    client.onChange("db", (e) => dbEvents.push(e));

    // Refresh: both change
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 7 },
          }),
          configResource({
            id: "cfg-2",
            key: "db",
            items: { host: "prod-db" },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(appEvents).toHaveLength(1);
    expect(appEvents[0].configKey).toBe("app");

    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0].configKey).toBe("db");
  });

  it("should fire item-scoped listener only for that specific item", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3, timeout: 1000 },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const retriesEvents: ConfigChangeEvent[] = [];
    client.onChange("app", "retries", (e) => retriesEvents.push(e));

    // Refresh: both retries and timeout change
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh with same value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3, new_key: "hello" },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].itemKey).toBe("new_key");
    expect(events[0].oldValue).toBeNull();
    expect(events[0].newValue).toBe("hello");
  });

  it("should detect removed keys", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3, old_key: "bye" },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].itemKey).toBe("old_key");
    expect(events[0].oldValue).toBe("bye");
    expect(events[0].newValue).toBeNull();
  });

  it("should detect new configs added on refresh", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
          configResource({
            id: "cfg-2",
            key: "db",
            items: { host: "localhost" },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configKey).toBe("db");
    expect(events[0].itemKey).toBe("host");
    expect(events[0].newValue).toBe("localhost");
  });

  it("should detect removed configs on refresh", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
          configResource({
            id: "cfg-2",
            key: "db",
            items: { host: "localhost" },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh returns only app — db is removed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configKey).toBe("db");
    expect(events[0].itemKey).toBe("host");
    expect(events[0].oldValue).toBe("localhost");
    expect(events[0].newValue).toBeNull();
  });

  it("should not crash if a listener throws", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange(() => {
      throw new Error("bad listener");
    });
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 7 },
          }),
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].newValue).toBe(7);
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const original = await client.resolve("app");
    expect((original as Record<string, unknown>).retries).toBe(3);

    // Refresh with updated value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 7 },
          }),
        ],
      }),
    );

    await client.refresh();

    // Re-resolve should return updated value
    const refreshed = await client.resolve("app");
    expect((refreshed as Record<string, unknown>).retries).toBe(7);
  });

  it("should throw SmplError before initialization", async () => {
    const client = makeClient();
    // Force _initialized flag to true to bypass lazy init, then unset
    // Actually, we need to test the pre-initialization path
    // The refresh() method checks _initialized first
    const rawClient = client as Record<string, unknown>;
    rawClient["_initialized"] = true;

    // Now reset to test the guard
    rawClient["_initialized"] = false;

    await expect(client.refresh()).rejects.toThrow(SmplError);
    await expect(client.refresh()).rejects.toThrow(
      "Config not initialized. Call resolve() or subscribe() first.",
    );
  });

  it("should throw SmplError when no environment is set", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: {},
          }),
        ],
      }),
    );

    await client.resolve("app");
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
            id: "cfg-1",
            key: "app",
            items: {},
          }),
        ],
      }),
    );

    await client.resolve("app");
    client._parent = { _environment: "", _service: null };

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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");

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

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Simulate WebSocket config_changed event — refresh will re-fetch
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          configResource({
            id: "cfg-1",
            key: "app",
            items: { retries: 99 },
          }),
        ],
      }),
    );

    // Trigger the WebSocket handler
    wsListeners["config_changed"]({ key: "app" });

    // Wait for the async refresh to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(events).toHaveLength(1);
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    await client.resolve("app");

    // Simulate WebSocket event where refresh fails
    mockFetch.mockRejectedValueOnce(new Error("network"));

    // Should not throw
    wsListeners["config_changed"]({ key: "app" });
    await new Promise((r) => setTimeout(r, 50));
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
            id: "cfg-1",
            key: "app",
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
            id: "cfg-1",
            key: "app",
            items: { retries: 3 },
          }),
        ],
      }),
    );

    const proxy = await client.subscribe("app");

    // Symbol.iterator should use Reflect.has
    expect(Symbol.iterator in proxy).toBe(false);
  });
});
