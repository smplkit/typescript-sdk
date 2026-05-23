/**
 * Runtime-only tests for ConfigClient. Management/CRUD coverage lives in
 * tests/unit/management/management_config.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import { SmplError, SmplTimeoutError } from "../../../src/errors.js";

// Mock global fetch — openapi-fetch calls fetch(request: Request)
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

function makeClient(): ConfigClient {
  return new ConfigClient(API_KEY);
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("ConfigClient", () => {
  describe("_connectInternal", () => {
    it("should populate cache and config store", async () => {
      const client = makeClient();

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "db",
              type: "config",
              attributes: {
                name: "DB Config",
                description: null,
                parent: null,
                items: { host: "localhost", port: 5432 },
                environments: {},
              },
            },
          ],
        }),
      );

      await client._connectInternal("production");

      // Cache stores resolved values as raw {key: value}. The wire-shaped
      // {value, type, description} envelope is unwrapped in _buildChain
      // before resolveChain merges values into the cache.
      expect(client._getCachedConfig("db")).toEqual({
        host: "localhost",
        port: 5432,
      });
    });

    it("should be a no-op if already initialized", async () => {
      const client = makeClient();

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "db",
              type: "config",
              attributes: {
                name: "DB",
                description: null,
                parent: null,
                items: { host: { value: "localhost" } },
                environments: {},
              },
            },
          ],
        }),
      );

      await client._connectInternal("production");
      await client._connectInternal("production"); // no-op

      // Only one fetch call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should throw SmplError when the list call fails", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

      await expect(client._connectInternal("production")).rejects.toThrow(SmplError);
    });

    it("should treat empty data list as no configs", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await client._connectInternal("production");

      expect(client._getCachedConfig("anything")).toBeUndefined();
    });
  });

  describe("_listConfigs HTTP fallback", () => {
    it("delegates to the management plane when wired", async () => {
      const client = makeClient();
      const fakeMgmt = {
        config: {
          list: vi.fn().mockResolvedValue([]),
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client._resolveManagement = () => fakeMgmt as any;
      client._parent = { _environment: "production", _service: "svc", _metrics: null };

      // start() calls _ensureInitialized which calls _listConfigs
      await client.start();

      expect(fakeMgmt.config.list).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls back to direct HTTP when no management plane is wired", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      client._parent = { _environment: "production", _service: "svc", _metrics: null };

      await client.start();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0].url as string;
      expect(url).toContain("/api/v1/configs");
      expect(url).toMatch(/page(\[|%5B)number(\]|%5D)=1/);
      expect(url).toMatch(/page(\[|%5B)size(\]|%5D)=1000/);
    });

    it("pages through configs when the first page is full (direct HTTP fallback)", async () => {
      const client = makeClient();
      client._parent = { _environment: "production", _service: "svc", _metrics: null };

      const PAGE_SIZE = 1000;
      const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
        id: `cfg-${i}`,
        type: "config",
        attributes: {
          name: `Cfg ${i}`,
          description: null,
          parent: null,
          items: {},
          environments: {},
        },
      }));
      const secondPage = [
        {
          id: "cfg-last",
          type: "config",
          attributes: {
            name: "Last",
            description: null,
            parent: null,
            items: {},
            environments: {},
          },
        },
      ];

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ data: firstPage }))
        .mockResolvedValueOnce(jsonResponse({ data: secondPage }));

      await client.start();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const url1 = mockFetch.mock.calls[0][0].url as string;
      const url2 = mockFetch.mock.calls[1][0].url as string;
      expect(url1).toMatch(/page(\[|%5B)number(\]|%5D)=1/);
      expect(url2).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
      // Both pages landed in the cache
      expect(client._getCachedConfig("cfg-0")).toBeDefined();
      expect(client._getCachedConfig("cfg-last")).toBeDefined();
    });

    it("pages through configs via the management plane when wired", async () => {
      const client = makeClient();
      const PAGE_SIZE = 1000;
      const fakeMgmt = {
        config: {
          list: vi
            .fn()
            // First page is exactly PAGE_SIZE — must loop.
            .mockResolvedValueOnce(
              Array.from({ length: PAGE_SIZE }, (_, i) => ({
                id: `cfg-${i}`,
                _buildChain: () => Promise.resolve([]),
              })),
            )
            // Second page is short — loop exits.
            .mockResolvedValueOnce([{ id: "cfg-last", _buildChain: () => Promise.resolve([]) }]),
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client._resolveManagement = () => fakeMgmt as any;
      client._parent = { _environment: "production", _service: "svc", _metrics: null };

      await client.start();

      expect(fakeMgmt.config.list).toHaveBeenCalledTimes(2);
      expect(fakeMgmt.config.list).toHaveBeenNthCalledWith(1, {
        pageNumber: 1,
        pageSize: PAGE_SIZE,
      });
      expect(fakeMgmt.config.list).toHaveBeenNthCalledWith(2, {
        pageNumber: 2,
        pageSize: PAGE_SIZE,
      });
    });
  });

  describe("custom fetch wrapper", () => {
    it("maps DOMException AbortError to SmplTimeoutError", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

      await expect(client._connectInternal("staging")).rejects.toThrow(SmplTimeoutError);
    });
  });

  describe("extractEnvironments defensive path (via wire response)", () => {
    it("preserves entries that lack a values key when reading a single config", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "cfg",
              type: "config",
              attributes: {
                name: "Cfg",
                description: null,
                parent: null,
                items: {},
                // staging has no `values` key — extractEnvironments should
                // pass the entry through unchanged.
                environments: { staging: { metadata: "x" } },
              },
            },
          ],
        }),
      );

      await client._connectInternal("production");
      // No exception means the defensive branch was taken; cache is populated.
      expect(client._getCachedConfig("cfg")).toBeDefined();
    });
  });
});

describe("ConfigClient — extraHeaders", () => {
  it("extraHeaders are present on every request", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({
        data: [],
      });
    });

    const client = new ConfigClient(API_KEY, undefined, undefined, { "X-Test": "v" });
    await client._connectInternal("production");
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.headers.get("x-test")).toBe("v");
    // SDK Authorization header still present
    expect(seen[0]!.headers.get("authorization")).toMatch(/^Bearer /);
  });
});

describe("ConfigClient — bind + get", () => {
  function _setupClient(cache: Record<string, Record<string, unknown>> = {}): {
    client: ConfigClient;
    registerConfig: ReturnType<typeof vi.fn>;
    registerConfigItem: ReturnType<typeof vi.fn>;
  } {
    const client = makeClient();
    client._parent = {
      _environment: "production",
      _service: "svc",
      _metrics: null,
    };
    // Pre-seed initialized state so we exercise the post-init path.
    (client as unknown as { _initialized: boolean })._initialized = true;
    (client as unknown as { _configCache: Record<string, Record<string, unknown>> })._configCache =
      cache;
    const registerConfig = vi.fn();
    const registerConfigItem = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    client._resolveManagement = () =>
      ({
        config: { registerConfig, registerConfigItem, flush },
      }) as never;
    return { client, registerConfig, registerConfigItem };
  }

  // ----- bind: plain object literals -----

  it("bind returns the same object literal back", async () => {
    const { client } = _setupClient({ billing: {} });
    const payload = { max_seats: 5, tier: "free" };
    const result = await client.bind("billing", payload);
    expect(result).toBe(payload);
  });

  it("bind is idempotent — repeat calls return the originally-bound object", async () => {
    const { client } = _setupClient({ billing: {} });
    const first = { max_seats: 5 };
    const second = { max_seats: 999 };
    const a = await client.bind("billing", first);
    const b = await client.bind("billing", second);
    expect(a).toBe(first);
    expect(b).toBe(first);
  });

  it("bind rejects non-object inputs", async () => {
    const { client } = _setupClient();
    await expect(client.bind("billing", "nope" as never)).rejects.toThrow(TypeError);
    await expect(client.bind("billing", null as never)).rejects.toThrow(TypeError);
  });

  it("bind on a plain object literal queues a config declaration with null name", async () => {
    const { client, registerConfig } = _setupClient({ billing: {} });
    await client.bind("billing", { k: 1 });
    expect(registerConfig).toHaveBeenCalledWith("billing", {
      service: "svc",
      environment: "production",
      parent: null,
      name: null,
      description: null,
    });
  });

  it("bind on a class instance uses the class name as the console name", async () => {
    const { client, registerConfig } = _setupClient({ billing: {} });
    class BillingPlan {
      max_seats = 5;
    }
    await client.bind("billing", new BillingPlan());
    expect(registerConfig.mock.calls[0][1].name).toBe("BillingPlan");
  });

  it("bind registers every leaf with its inferred type", async () => {
    const { client, registerConfigItem } = _setupClient({ billing: {} });
    await client.bind("billing", { seats: 5, tier: "free", enabled: true });
    const calls = registerConfigItem.mock.calls.map((c) => [c[1], c[2], c[3]]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["seats", "NUMBER", 5],
        ["tier", "STRING", "free"],
        ["enabled", "BOOLEAN", true],
      ]),
    );
  });

  it("bind flattens nested plain objects to dot-notation", async () => {
    const { client, registerConfigItem } = _setupClient({ db: {} });
    await client.bind("db", {
      primary: { host: "h", port: 5432 },
      pool_size: 10,
    });
    const keys = registerConfigItem.mock.calls.map((c) => c[1]);
    expect(keys).toEqual(expect.arrayContaining(["primary.host", "primary.port", "pool_size"]));
  });

  it("bind with parent resolves the parent's config id", async () => {
    const { client, registerConfig } = _setupClient({ base: {}, child: {} });
    const base = await client.bind("base", { k: 1 });
    registerConfig.mockClear();
    await client.bind("child", { other: 2 }, { parent: base });
    expect(registerConfig).toHaveBeenCalledTimes(1);
    expect(registerConfig.mock.calls[0][1].parent).toBe("base");
  });

  it("bind throws when the parent is not a previously-bound object", async () => {
    const { client } = _setupClient({ child: {} });
    await expect(client.bind("child", { k: 1 }, { parent: { stray: true } })).rejects.toThrow(
      /previously returned from client.config.bind/,
    );
  });

  it("bind syncs the bound object from cache (existing-config case)", async () => {
    const { client } = _setupClient({
      billing: { seats: 999, tier: "enterprise" },
    });
    const payload = { seats: 5, tier: "free" };
    const result = await client.bind("billing", payload);
    expect(result).toEqual({ seats: 999, tier: "enterprise" });
  });

  // ----- get: full config -----

  it("get(id) returns a LiveConfigProxy", async () => {
    const { client } = _setupClient({ billing: { k: 1 } });
    const proxy = await client.get("billing");
    expect((proxy as Record<string, unknown>).k).toBe(1);
  });

  it("get(id) returns the same proxy on repeat calls", async () => {
    const { client } = _setupClient({ billing: { k: 1 } });
    const a = await client.get("billing");
    const b = await client.get("billing");
    expect(a).toBe(b);
  });

  it("get(id) throws SmplNotFoundError when the config is missing", async () => {
    const { client } = _setupClient({});
    await expect(client.get("missing")).rejects.toThrow(/not found in cache/);
  });

  // ----- get(id, key) — single value, no default -----

  it("get(id, key) returns the resolved value when present", async () => {
    const { client } = _setupClient({ db: { connection_string: "postgres://x" } });
    await expect(client.get("db", "connection_string")).resolves.toBe("postgres://x");
  });

  it("get(id, key) throws when the config is missing", async () => {
    const { client } = _setupClient({});
    await expect(client.get("db", "k")).rejects.toThrow(/Config with id 'db' not found/);
  });

  it("get(id, key) throws when the key is missing", async () => {
    const { client } = _setupClient({ db: {} });
    await expect(client.get("db", "k")).rejects.toThrow(/Config item 'k' not found/);
  });

  it("get(id, key) does not register anything", async () => {
    const { client, registerConfig, registerConfigItem } = _setupClient({ db: { k: "v" } });
    await client.get("db", "k");
    expect(registerConfig).not.toHaveBeenCalled();
    expect(registerConfigItem).not.toHaveBeenCalled();
  });

  // ----- get(id, key, default) — single value with default -----

  it("get(id, key, default) returns the cached value when present", async () => {
    const { client } = _setupClient({ db: { connection_string: "real" } });
    await expect(client.get("db", "connection_string", "fallback")).resolves.toBe("real");
  });

  it("get(id, key, default) returns default when the config is missing", async () => {
    const { client } = _setupClient({});
    await expect(client.get("db", "connection_string", "fallback")).resolves.toBe("fallback");
  });

  it("get(id, key, default) returns default when the key is missing", async () => {
    const { client } = _setupClient({ db: {} });
    await expect(client.get("db", "missing", "fallback")).resolves.toBe("fallback");
  });

  it("get(id, key, default) registers the config and the key", async () => {
    const { client, registerConfig, registerConfigItem } = _setupClient({});
    await client.get("db", "connection_string", "postgres://...");
    expect(registerConfig).toHaveBeenCalledWith("db", {
      service: "svc",
      environment: "production",
      parent: null,
      name: null,
      description: null,
    });
    expect(registerConfigItem).toHaveBeenCalledWith(
      "db",
      "connection_string",
      "STRING",
      "postgres://...",
      null,
    );
  });

  it("get(id, key, default) infers item type from the default's type", async () => {
    const { client, registerConfigItem } = _setupClient({});
    await client.get("billing", "max_seats", 5);
    await client.get("billing", "trial_days", 14.0);
    await client.get("billing", "active", true);
    const types = Object.fromEntries(registerConfigItem.mock.calls.map((c) => [c[1], c[2]]));
    expect(types).toEqual({
      max_seats: "NUMBER",
      trial_days: "NUMBER",
      active: "BOOLEAN",
    });
  });

  it("get(id, key, default) falls back to STRING for non-primitive defaults", async () => {
    const { client, registerConfigItem } = _setupClient({});
    await client.get("billing", "tags", [1, 2, 3]);
    await client.get("billing", "payload", null);
    const types = Object.fromEntries(registerConfigItem.mock.calls.map((c) => [c[1], c[2]]));
    expect(types.tags).toBe("STRING");
    expect(types.payload).toBe("STRING");
  });

  // ----- bound-target mutation via the listener pipeline -----

  it("WebSocket-driven changes mutate the bound object in place", async () => {
    const { client } = _setupClient({ billing: { max_seats: 5 } });
    const payload: { max_seats: number } = { max_seats: 5 };
    await client.bind("billing", payload);
    // Simulate a server-side bump by feeding the diff pipeline directly.
    const oldCache = { billing: { max_seats: 5 } };
    const newCache = { billing: { max_seats: 50 } };
    (
      client as unknown as {
        _diffAndFire: (a: typeof oldCache, b: typeof newCache, s: string) => void;
      }
    )._diffAndFire(oldCache, newCache, "websocket");
    expect(payload.max_seats).toBe(50);
  });

  it("WebSocket-driven changes traverse nested objects to apply at the leaf", async () => {
    const { client } = _setupClient({
      billing: { "audit.managed_streams": 0, "audit.siem": false },
    });
    const payload = { audit: { managed_streams: 0, siem: false } };
    await client.bind("billing", payload);
    const oldCache = { billing: { "audit.managed_streams": 0, "audit.siem": false } };
    const newCache = { billing: { "audit.managed_streams": 50, "audit.siem": false } };
    (
      client as unknown as {
        _diffAndFire: (a: typeof oldCache, b: typeof newCache, s: string) => void;
      }
    )._diffAndFire(oldCache, newCache, "websocket");
    expect(payload.audit.managed_streams).toBe(50);
    // Nested object reference is preserved (mutation, not replacement).
    expect(payload.audit.siem).toBe(false);
  });

  it("WebSocket-driven changes bail silently when the bound object has no matching path", async () => {
    const { client } = _setupClient({ billing: { other: 1 } });
    const payload: { other: number } = { other: 1 };
    await client.bind("billing", payload);
    // Server pushes a dotted key whose intermediate doesn't exist on the target.
    const oldCache = { billing: { other: 1 } };
    const newCache = { billing: { other: 1, "deep.path.missing": "x" } };
    (
      client as unknown as {
        _diffAndFire: (a: typeof oldCache, b: typeof newCache, s: string) => void;
      }
    )._diffAndFire(oldCache, newCache, "websocket");
    // Original property untouched; the bail just no-ops without throwing.
    expect(payload).toEqual({ other: 1 });
  });

  it("_observeConfigDeclaration and _observeItemDeclaration are no-ops without management wiring", () => {
    const client = makeClient();
    client._parent = { _environment: "p", _service: null, _metrics: null };
    // No _resolveManagement assigned — calls must not throw.
    client._observeConfigDeclaration("c", null, null, null);
    client._observeItemDeclaration("c", "k", "NUMBER", 1);
  });
});
