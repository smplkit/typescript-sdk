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

describe("ConfigClient — discovery (getOrCreate + typed getters)", () => {
  function _setupClient(): {
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
      {
        billing: { "plan.max_seats": 5, "plan.trial_days": 14, "plan.tier": "free" },
      };
    const registerConfig = vi.fn();
    const registerConfigItem = vi.fn();
    const flush = vi.fn().mockResolvedValue(undefined);
    client._resolveManagement = () =>
      ({
        config: { registerConfig, registerConfigItem, flush },
      }) as never;
    return { client, registerConfig, registerConfigItem };
  }

  it("getOrCreate returns the same proxy on repeat calls", async () => {
    const { client } = _setupClient();
    const p1 = await client.getOrCreate("billing");
    const p2 = await client.getOrCreate("billing");
    expect(p1).toBe(p2);
  });

  it("getOrCreate queues a config declaration with metadata", async () => {
    const { client, registerConfig } = _setupClient();
    await client.getOrCreate("billing", { description: "Plan limits.", name: "Billing" });
    expect(registerConfig).toHaveBeenCalledWith("billing", {
      service: "svc",
      environment: "production",
      parent: null,
      name: "Billing",
      description: "Plan limits.",
    });
  });

  it("getOrCreate accepts a LiveConfigProxy as the parent", async () => {
    const { client, registerConfig } = _setupClient();
    const parent = await client.getOrCreate("common");
    registerConfig.mockClear();
    await client.getOrCreate("billing", { parent });
    expect(registerConfig).toHaveBeenCalledTimes(1);
    expect(registerConfig.mock.calls[0][1].parent).toBe("common");
  });

  it("getOrCreate accepts a string id as the parent", async () => {
    const { client, registerConfig } = _setupClient();
    await client.getOrCreate("billing", { parent: "common" });
    expect(registerConfig.mock.calls[0][1].parent).toBe("common");
  });

  it("getOrCreate upgrades a proxy with a model on subsequent call", async () => {
    const { client } = _setupClient();
    class BillingModel {
      "plan.max_seats"!: number;
      constructor(data: Record<string, unknown>) {
        Object.assign(this, data);
      }
    }
    const untyped = await client.getOrCreate("billing");
    const typed = await client.getOrCreate("billing", { model: BillingModel });
    expect(untyped).toBe(typed);
  });

  it("typed getters return resolved values and register items", async () => {
    const { client, registerConfigItem } = _setupClient();
    const billing = await client.getOrCreate("billing");
    expect(billing.getInt("plan.max_seats", 1)).toBe(5);
    expect(billing.getString("plan.tier", "x")).toBe("free");
    expect(registerConfigItem).toHaveBeenCalledWith("billing", "plan.max_seats", "NUMBER", 1, null);
    expect(registerConfigItem).toHaveBeenCalledWith("billing", "plan.tier", "STRING", "x", null);
  });

  it("getJson returns the resolved value when present", async () => {
    const { client } = _setupClient();
    (client as unknown as { _configCache: Record<string, Record<string, unknown>> })._configCache =
      { billing: { payload: { nested: [1, 2] } } };
    const billing = await client.getOrCreate("billing");
    expect(billing.getJson("payload", {})).toEqual({ nested: [1, 2] });
  });

  it("typed getters return default when the item is absent", async () => {
    const { client } = _setupClient();
    const billing = await client.getOrCreate("billing");
    expect(billing.getInt("missing", 99)).toBe(99);
    expect(billing.getBool("missing", true)).toBe(true);
    expect(billing.getFloat("missing", 0.5)).toBe(0.5);
    expect(billing.getString("missing", "default")).toBe("default");
    expect(billing.getJson("missing", { fallback: true })).toEqual({ fallback: true });
  });

  it("typed getters return default on type mismatch (and warn)", async () => {
    const { client } = _setupClient();
    (client as unknown as { _configCache: Record<string, Record<string, unknown>> })._configCache =
      {
        billing: {
          "plan.max_seats": "not a number",
          "plan.enabled": 5,
          "plan.tier": 99,
          "plan.ratio": "x",
        },
      };
    const billing = await client.getOrCreate("billing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(billing.getInt("plan.max_seats", 1)).toBe(1);
      expect(billing.getBool("plan.enabled", false)).toBe(false);
      expect(billing.getString("plan.tier", "free")).toBe("free");
      expect(billing.getFloat("plan.ratio", 0.5)).toBe(0.5);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("typed getters accept an optional description argument", async () => {
    const { client, registerConfigItem } = _setupClient();
    const billing = await client.getOrCreate("billing");
    billing.getInt("plan.max_seats", 5, { description: "Max." });
    expect(registerConfigItem).toHaveBeenCalledWith(
      "billing",
      "plan.max_seats",
      "NUMBER",
      5,
      "Max.",
    );
  });

  it("getFloat coerces an int value to float", async () => {
    const { client } = _setupClient();
    (client as unknown as { _configCache: Record<string, Record<string, unknown>> })._configCache =
      { billing: { ratio: 5 } };
    const billing = await client.getOrCreate("billing");
    expect(billing.getFloat("ratio", 0.0)).toBe(5);
  });

  it("_observeConfigDeclaration and _observeItemDeclaration are no-ops without management wiring", async () => {
    const client = makeClient();
    client._parent = { _environment: "p", _service: null, _metrics: null };
    // No _resolveManagement assigned — calls must not throw.
    client._observeConfigDeclaration("c", null, null, null);
    client._observeItemDeclaration("c", "k", "NUMBER", 1);
  });
});
