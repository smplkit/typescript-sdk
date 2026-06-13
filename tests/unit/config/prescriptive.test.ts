/**
 * Tests for the live surface of the fused ConfigClient: lazy auto-connect
 * (`_ensureConnected` → flush discovery → fetch + resolve all configs →
 * subscribe WS), `subscribe`, `getValue` (both forms), `bind` (plain object /
 * class instance / nested / parent-chain / seed-vs-sync), `refresh`,
 * `onChange` (three forms), the WebSocket event handlers
 * (`config_changed` / `config_deleted` / `configs_changed`), the standalone
 * (owns-its-own-WS) and wired (borrows parent WS) connection paths, and the
 * LiveConfigProxy. CRUD + discovery coverage lives in client.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import type { ConfigChangeEvent, ConfigParent } from "../../../src/config/client.js";
import { SmplkitNotFoundError } from "../../../src/errors.js";
import type { SharedWebSocket } from "../../../src/ws.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

type WsCallback = (data: Record<string, unknown>) => void;

interface MockSharedWs {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connectionStatus: string;
  _emit: (event: string, data: Record<string, unknown>) => void;
}

function createMockSharedWs(): MockSharedWs {
  const listeners: Record<string, WsCallback[]> = {};
  return {
    on: vi.fn((event: string, cb: WsCallback) => {
      (listeners[event] ??= []).push(cb);
    }),
    off: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    connectionStatus: "connected",
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
  };
}

/** Build a wired client with a fully-mocked parent + shared WebSocket. */
function makeWired(opts: { environment?: string; service?: string | null } = {}): {
  client: ConfigClient;
  parent: ConfigParent;
  ws: MockSharedWs;
  ensureStarted: ReturnType<typeof vi.fn>;
} {
  const ws = createMockSharedWs();
  const ensureStarted = vi.fn();
  const parent: ConfigParent = {
    _environment: opts.environment ?? "staging",
    _service: opts.service ?? "test-svc",
    _ensureStarted: ensureStarted,
    _ensureWs: () => ws as unknown as SharedWebSocket,
  };
  // Pass an explicit apiKey so construction never depends on a `~/.smplkit`
  // file (absent in CI). The parent still supplies environment/service and the
  // shared WebSocket; HTTP is driven through the mocked global fetch.
  const client = new ConfigClient({ parent, apiKey: API_KEY });
  return { client, parent, ws, ensureStarted };
}

function makeStandalone(): ConfigClient {
  return new ConfigClient({ apiKey: API_KEY, environment: "staging" });
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function configResource(opts: {
  id: string;
  items?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
  parent?: string | null;
}) {
  return {
    id: opts.id,
    type: "config",
    attributes: {
      name: opts.id,
      description: null,
      parent: opts.parent ?? null,
      items: Object.fromEntries(
        Object.entries(opts.items ?? {}).map(([k, v]) => [k, { value: v }]),
      ),
      environments: opts.environments ?? {},
      created_at: "2024-01-15T10:30:00Z",
      updated_at: "2024-01-16T14:00:00Z",
    },
  };
}

/** Queue a list response for the initial _fetchAllConfigs paged read. */
function mockListOnce(configs: ReturnType<typeof configResource>[]): void {
  mockFetch.mockResolvedValueOnce(jsonResponse({ data: configs }));
}

// ---------------------------------------------------------------------------
// subscribe() + auto-connect
// ---------------------------------------------------------------------------

describe("subscribe()", () => {
  it("auto-connects on first use and returns a live proxy of resolved values", async () => {
    const { client, ws, ensureStarted } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3, timeout: 1000 } })]);

    const proxy = await client.subscribe("app");

    expect(ensureStarted).toHaveBeenCalled();
    // WS subscriptions were registered.
    expect(ws.on).toHaveBeenCalledWith("config_changed", expect.any(Function));
    expect(ws.on).toHaveBeenCalledWith("config_deleted", expect.any(Function));
    expect(ws.on).toHaveBeenCalledWith("configs_changed", expect.any(Function));
    expect((proxy as Record<string, unknown>).retries).toBe(3);
    expect((proxy as Record<string, unknown>).timeout).toBe(1000);
  });

  it("applies environment overrides during the initial resolve", async () => {
    const { client } = makeWired({ environment: "staging" });
    mockListOnce([
      configResource({
        id: "app",
        items: { timeout: 1000 },
        environments: { staging: { timeout: 2000 } },
      }),
    ]);
    const proxy = await client.subscribe("app");
    expect((proxy as Record<string, unknown>).timeout).toBe(2000);
  });

  it("resolves inheritance through the parent chain on connect", async () => {
    const { client } = makeWired();
    mockListOnce([
      configResource({ id: "child", items: { retries: 5 }, parent: "base" }),
      configResource({ id: "base", items: { retries: 3, timeout: 1000 } }),
    ]);
    const proxy = await client.subscribe("child");
    expect((proxy as Record<string, unknown>).retries).toBe(5);
    expect((proxy as Record<string, unknown>).timeout).toBe(1000);
  });

  it("throws SmplkitNotFoundError when the config is unknown", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await expect(client.subscribe("missing")).rejects.toThrow(SmplkitNotFoundError);
  });

  it("returns the same proxy instance on repeat calls and connects only once", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    const a = await client.subscribe("app");
    const b = await client.subscribe("app");
    expect(a).toBe(b);
    // Only the single initial list fetch — no reconnect.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("records a resolution metric when a metrics reporter is wired", async () => {
    const ws = createMockSharedWs();
    const record = vi.fn();
    const parent: ConfigParent = {
      _environment: "staging",
      _service: "svc",
      _ensureStarted: vi.fn(),
      _ensureWs: () => ws as unknown as SharedWebSocket,
    };
    const client = new ConfigClient({
      parent,
      apiKey: API_KEY,
      metrics: { record, recordGauge: vi.fn() } as never,
    });
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);

    await client.subscribe("app");
    expect(record).toHaveBeenCalledWith("config.resolutions", 1, "resolutions", { config: "app" });
  });

  it("queues a discovery declaration for the subscribed config", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    // flush() drains the buffer on connect; the subscribe declaration is added
    // afterward, leaving exactly one pending entry.
    await client.subscribe("app");
    expect(client.pendingCount).toBe(1);
  });

  it("swallows a pre-connect discovery flush failure and still connects", async () => {
    const { client } = makeWired();
    // The flush() before the initial fetch rejects; _ensureConnected's catch
    // logs and continues to the refresh + WS subscribe.
    vi.spyOn(client, "flush").mockRejectedValueOnce(new Error("flush boom"));
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    const proxy = await client.subscribe("app");
    expect((proxy as Record<string, unknown>).retries).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Standalone WebSocket path (owns its own SharedWebSocket)
// ---------------------------------------------------------------------------

describe("standalone live connection", () => {
  it("opens and owns its own SharedWebSocket, torn down on close()", async () => {
    const fakeWs = createMockSharedWs();
    const { SharedWebSocket } = await import("../../../src/ws.js");
    const spy = vi.spyOn(SharedWebSocket.prototype, "start").mockImplementation(function (
      this: unknown,
    ) {
      // no-op; avoid opening a real socket
    });
    const onSpy = vi.spyOn(SharedWebSocket.prototype, "on").mockImplementation(() => {});
    const stopSpy = vi.spyOn(SharedWebSocket.prototype, "stop").mockImplementation(() => {});
    void fakeWs;

    const client = makeStandalone();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);

    await client.subscribe("app");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onSpy).toHaveBeenCalledWith("config_changed", expect.any(Function));

    client.close();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses the same owned WebSocket across live calls", async () => {
    const { SharedWebSocket } = await import("../../../src/ws.js");
    const startSpy = vi.spyOn(SharedWebSocket.prototype, "start").mockImplementation(() => {});
    vi.spyOn(SharedWebSocket.prototype, "on").mockImplementation(() => {});

    const client = makeStandalone();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.subscribe("app");
    // A second live call must not open a second socket.
    await client.getValue("app", "retries");
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getValue()
// ---------------------------------------------------------------------------

describe("getValue()", () => {
  it("two-arg form returns the resolved value when present", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "db", items: { conn: "postgres://x" } })]);
    await expect(client.getValue("db", "conn")).resolves.toBe("postgres://x");
  });

  it("two-arg form throws when the config is missing", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "db", items: {} })]);
    await expect(client.getValue("missing", "k")).rejects.toThrow(
      /Config with id 'missing' not found/,
    );
  });

  it("two-arg form throws when the key is missing", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "db", items: {} })]);
    await expect(client.getValue("db", "k")).rejects.toThrow(/Config item 'k' not found/);
  });

  it("two-arg form does not register a declaration", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "db", items: { k: "v" } })]);
    await client.getValue("db", "k");
    // Only the subscribe-side declaration is queued by getValue with a default;
    // the bare two-arg form adds nothing.
    expect(client.pendingCount).toBe(0);
  });

  it("three-arg form returns the cached value when present", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "db", items: { conn: "real" } })]);
    await expect(client.getValue("db", "conn", "fallback")).resolves.toBe("real");
  });

  it("three-arg form returns the default when the config is missing and registers it", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    await expect(client.getValue("db", "conn", "fallback")).resolves.toBe("fallback");
    expect(client.pendingCount).toBe(1);
  });

  it("three-arg form returns the default when the key is missing", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "db", items: {} })]);
    await expect(client.getValue("db", "missing", "fallback")).resolves.toBe("fallback");
  });

  it("three-arg form infers the item type from the default", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    await client.getValue("billing", "max_seats", 5);
    await client.getValue("billing", "active", true);
    await client.getValue("billing", "name", "x");
    await client.getValue("billing", "tags", [1, 2, 3]);
    // Inspect the drained buffer to confirm the inferred types.
    const drained = (
      client as unknown as {
        _buffer: { drain: () => Array<{ items: Record<string, { type: string }> }> };
      }
    )._buffer.drain();
    const items = drained.find((e) => "items" in e)!.items;
    expect(items.max_seats.type).toBe("NUMBER");
    expect(items.active.type).toBe("BOOLEAN");
    expect(items.name.type).toBe("STRING");
    expect(items.tags.type).toBe("STRING");
  });
});

// ---------------------------------------------------------------------------
// bind()
// ---------------------------------------------------------------------------

describe("bind()", () => {
  it("returns the same object and seeds the cache for a brand-new config", async () => {
    const { client } = makeWired();
    mockListOnce([]); // no server-side config
    const payload = { max_seats: 5, tier: "free" };
    const result = await client.bind("billing", payload);
    expect(result).toBe(payload);
    // The cache is seeded in-memory from the bound object — readable at once.
    await expect(client.getValue("billing", "max_seats")).resolves.toBe(5);
  });

  it("is idempotent — repeat calls return the originally-bound object", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    const first = { max_seats: 5 };
    const second = { max_seats: 999 };
    const a = await client.bind("billing", first);
    const b = await client.bind("billing", second);
    expect(a).toBe(first);
    expect(b).toBe(first);
  });

  it("rejects non-object inputs", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    await expect(client.bind("billing", "nope" as never)).rejects.toThrow(TypeError);
    mockListOnce([]);
    await expect(client.bind("billing2", null as never)).rejects.toThrow(TypeError);
  });

  it("syncs a freshly-bound object from an existing server-side config", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "billing", items: { seats: 999, tier: "enterprise" } })]);
    const payload = { seats: 5, tier: "free" };
    const result = await client.bind("billing", payload);
    // Server values are authoritative — synced onto the bound object.
    expect(result).toEqual({ seats: 999, tier: "enterprise" });
  });

  it("uses a class instance's constructor name as the console display name", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    class BillingPlan {
      max_seats = 5;
    }
    await client.bind("billing", new BillingPlan());
    const drained = (
      client as unknown as { _buffer: { drain: () => Array<{ id: string; name?: string }> } }
    )._buffer.drain();
    const entry = drained.find((e) => e.id === "billing")!;
    expect(entry.name).toBe("BillingPlan");
  });

  it("leaves the display name unset for a plain object literal", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    await client.bind("billing", { k: 1 });
    const drained = (
      client as unknown as { _buffer: { drain: () => Array<{ id: string; name?: string }> } }
    )._buffer.drain();
    const entry = drained.find((e) => e.id === "billing")!;
    expect(entry.name).toBeUndefined();
  });

  it("flattens nested plain objects to dot-notation declarations", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    await client.bind("db", { primary: { host: "h", port: 5432 }, pool_size: 10 });
    const drained = (
      client as unknown as {
        _buffer: { drain: () => Array<{ id: string; items?: Record<string, unknown> }> };
      }
    )._buffer.drain();
    const entry = drained.find((e) => e.id === "db")!;
    expect(Object.keys(entry.items!)).toEqual(
      expect.arrayContaining(["primary.host", "primary.port", "pool_size"]),
    );
  });

  it("resolves a bound parent chain (child inherits omitted keys)", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    const base = await client.bind("base", { retries: 3, timeout: 1000 });
    const child = await client.bind("child", { retries: 5 }, { parent: base });
    expect(child).toBe(child);
    // Child overrides retries; inherits timeout from the bound parent chain.
    await expect(client.getValue("child", "retries")).resolves.toBe(5);
    await expect(client.getValue("child", "timeout")).resolves.toBe(1000);
  });

  it("records the resolved parent id in the child's declaration", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    const base = await client.bind("base", { k: 1 });
    await client.bind("child", { other: 2 }, { parent: base });
    const drained = (
      client as unknown as { _buffer: { drain: () => Array<{ id: string; parent?: string }> } }
    )._buffer.drain();
    const child = drained.find((e) => e.id === "child")!;
    expect(child.parent).toBe("base");
  });

  it("throws when the parent was not previously bound", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    await expect(client.bind("child", { k: 1 }, { parent: { stray: true } })).rejects.toThrow(
      /previously returned from client\.config\.bind/,
    );
  });
});

// ---------------------------------------------------------------------------
// refresh()
// ---------------------------------------------------------------------------

describe("refresh()", () => {
  it("re-fetches and updates resolved values", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    const proxy = await client.subscribe("app");
    expect((proxy as Record<string, unknown>).retries).toBe(3);

    mockListOnce([configResource({ id: "app", items: { retries: 7 } })]);
    await client.refresh();
    expect((proxy as Record<string, unknown>).retries).toBe(7);
  });

  it("auto-connects when refresh is the first live call", async () => {
    const { client, ensureStarted } = makeWired();
    // refresh() triggers the initial connect refresh AND its own manual
    // refresh — two list reads.
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.refresh();
    expect(ensureStarted).toHaveBeenCalled();
  });

  it("re-seeds in-memory bound configs not present server-side on refresh", async () => {
    const { client } = makeWired();
    mockListOnce([]);
    await client.bind("billing", { seats: 5 });
    // A refresh that returns no server config must keep the bound seed alive.
    mockListOnce([]);
    await client.refresh();
    await expect(client.getValue("billing", "seats")).resolves.toBe(5);
  });
});

// ---------------------------------------------------------------------------
// onChange()
// ---------------------------------------------------------------------------

describe("onChange()", () => {
  it("fires a global listener on any change during refresh", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 7 } })]);
    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].itemKey).toBe("retries");
    expect(events[0].oldValue).toBe(3);
    expect(events[0].newValue).toBe(7);
    expect(events[0].source).toBe("manual");
  });

  it("fires the initial connect refresh with source 'initial'", async () => {
    const { client } = makeWired();

    // Register the listener BEFORE the first live call. The first live call
    // (`subscribe`) lazily connects, and the initial resolve diffs against an
    // empty cache — so the pre-registered listener sees every resolved value
    // as an "initial" change (distinct from "manual"/"websocket").
    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.subscribe("app");

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].itemKey).toBe("retries");
    expect(events[0].oldValue).toBe(null);
    expect(events[0].newValue).toBe(3);
    expect(events[0].source).toBe("initial");
  });

  it("fires a config-scoped listener only for its config", async () => {
    const { client } = makeWired();
    mockListOnce([
      configResource({ id: "app", items: { retries: 3 } }),
      configResource({ id: "db", items: { host: "localhost" } }),
    ]);
    await client.subscribe("app");

    const appEvents: ConfigChangeEvent[] = [];
    const dbEvents: ConfigChangeEvent[] = [];
    client.onChange("app", (e) => appEvents.push(e));
    client.onChange("db", (e) => dbEvents.push(e));

    mockListOnce([
      configResource({ id: "app", items: { retries: 7 } }),
      configResource({ id: "db", items: { host: "prod-db" } }),
    ]);
    await client.refresh();

    expect(appEvents).toHaveLength(1);
    expect(appEvents[0].configId).toBe("app");
    expect(dbEvents).toHaveLength(1);
    expect(dbEvents[0].configId).toBe("db");
  });

  it("fires an item-scoped listener only for its item", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3, timeout: 1000 } })]);
    await client.subscribe("app");

    const retriesEvents: ConfigChangeEvent[] = [];
    client.onChange("app", "retries", (e) => retriesEvents.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 7, timeout: 2000 } })]);
    await client.refresh();

    expect(retriesEvents).toHaveLength(1);
    expect(retriesEvents[0].itemKey).toBe("retries");
  });

  it("does not fire when values are unchanged", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.refresh();
    expect(events).toHaveLength(0);
  });

  it("detects newly added keys", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 3, new_key: "hello" } })]);
    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].itemKey).toBe("new_key");
    expect(events[0].oldValue).toBeNull();
    expect(events[0].newValue).toBe("hello");
  });

  it("detects removed keys and removed configs", async () => {
    const { client } = makeWired();
    mockListOnce([
      configResource({ id: "app", items: { retries: 3 } }),
      configResource({ id: "db", items: { host: "localhost" } }),
    ]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // db disappears entirely.
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.refresh();

    const dbEvent = events.find((e) => e.configId === "db");
    expect(dbEvent).toBeDefined();
    expect(dbEvent!.itemKey).toBe("host");
    expect(dbEvent!.oldValue).toBe("localhost");
    expect(dbEvent!.newValue).toBeNull();
  });

  it("ignores an unrecognised onChange call shape", () => {
    const { client } = makeWired();
    // Two non-function, non-callback args — falls through every branch without
    // registering anything (and without throwing).
    (client.onChange as unknown as (a: string, b: string) => void)("app", "retries");
    const listeners = (client as unknown as { _listeners: unknown[] })._listeners;
    expect(listeners).toHaveLength(0);
  });

  it("does not crash when a listener throws", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange(() => {
      throw new Error("bad listener");
    });
    client.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 7 } })]);
    await client.refresh();
    expect(events).toHaveLength(1);
  });

  it("records a change metric when a metrics reporter is wired", async () => {
    const ws = createMockSharedWs();
    const record = vi.fn();
    const parent: ConfigParent = {
      _environment: "staging",
      _service: "svc",
      _ensureStarted: vi.fn(),
      _ensureWs: () => ws as unknown as SharedWebSocket,
    };
    const client = new ConfigClient({
      parent,
      apiKey: API_KEY,
      metrics: { record, recordGauge: vi.fn() } as never,
    });
    mockListOnce([configResource({ id: "app", items: { retries: 3 } })]);
    await client.subscribe("app");
    record.mockClear();

    mockListOnce([configResource({ id: "app", items: { retries: 9 } })]);
    await client.refresh();
    expect(record).toHaveBeenCalledWith("config.changes", 1, "changes", { config: "app" });
  });
});

// ---------------------------------------------------------------------------
// bind() — WebSocket-driven mutation of bound objects
// ---------------------------------------------------------------------------

describe("bound-object mutation via refresh", () => {
  it("mutates a bound object in place when a server value changes", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "billing", items: { max_seats: 5 } })]);
    const payload: { max_seats: number } = { max_seats: 5 };
    await client.bind("billing", payload);

    mockListOnce([configResource({ id: "billing", items: { max_seats: 50 } })]);
    await client.refresh();
    expect(payload.max_seats).toBe(50);
  });

  it("walks nested objects to apply a change at the leaf", async () => {
    const { client } = makeWired();
    mockListOnce([
      configResource({ id: "billing", items: { "audit.streams": 0, "audit.siem": false } }),
    ]);
    const payload = { audit: { streams: 0, siem: false } };
    await client.bind("billing", payload);

    mockListOnce([
      configResource({ id: "billing", items: { "audit.streams": 50, "audit.siem": false } }),
    ]);
    await client.refresh();
    expect(payload.audit.streams).toBe(50);
    expect(payload.audit.siem).toBe(false);
  });

  it("silently bails when the bound object lacks the changed path", async () => {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "billing", items: { other: 1 } })]);
    const payload: { other: number } = { other: 1 };
    await client.bind("billing", payload);

    mockListOnce([
      configResource({ id: "billing", items: { other: 1, "deep.path.missing": "x" } }),
    ]);
    await client.refresh();
    expect(payload).toEqual({ other: 1 });
  });
});

// ---------------------------------------------------------------------------
// WebSocket event handlers
// ---------------------------------------------------------------------------

describe("WebSocket handlers", () => {
  it("config_changed: refetches the single config and fires change events", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: { timeout: 30 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Scoped single-config GET returns the updated resource.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "app", items: { timeout: 60 } }) }),
    );
    ws._emit("config_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].itemKey).toBe("timeout");
    expect(events[0].newValue).toBe(60);
    expect(events[0].source).toBe("websocket");
  });

  it("config_changed with no id falls through to a full configs_changed refresh", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: { timeout: 30 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // No id → handler delegates to configs_changed → full list refresh.
    mockListOnce([configResource({ id: "app", items: { timeout: 99 } })]);
    ws._emit("config_changed", {});
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0].newValue).toBe(99);
  });

  it("config_changed: a null scoped-fetch result is ignored", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: { timeout: 30 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Scoped GET 404s → _fetchSingleConfig returns null → handler returns.
    mockFetch.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    ws._emit("config_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(0);
  });

  it("config_changed: a thrown scoped fetch is swallowed", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: {} })]);
    await client.subscribe("app");

    mockFetch.mockRejectedValueOnce(new Error("network"));
    ws._emit("config_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));
    // No throw escapes.
  });

  it("config_changed: a rejected cache rebuild is swallowed by the handler", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: { timeout: 30 } })]);
    await client.subscribe("app");

    // The scoped fetch succeeds, but the subsequent rebuild rejects — the
    // handler's .catch must absorb it.
    vi.spyOn(
      client as unknown as { _rebuildResolvedCache: () => Promise<void> },
      "_rebuildResolvedCache",
    ).mockRejectedValueOnce(new Error("rebuild boom"));
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "app", items: { timeout: 60 } }) }),
    );
    ws._emit("config_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));
    // No throw escapes.
  });

  it("config_deleted: removes the config from cache and fires a removal event", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: { timeout: 30 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    const before = mockFetch.mock.calls.length;
    ws._emit("config_deleted", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
    expect(events[0].newValue).toBeNull();
    // Deletion is cache-only — no extra HTTP fetch.
    expect(mockFetch.mock.calls.length).toBe(before);
  });

  it("config_deleted: an unknown config id is a no-op", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: {} })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));
    ws._emit("config_deleted", { id: "never-seen" });
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(0);
  });

  it("config_deleted with no id falls through to a full refresh", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: { timeout: 30 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { timeout: 77 } })]);
    ws._emit("config_deleted", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toHaveLength(1);
    expect(events[0].newValue).toBe(77);
  });

  it("configs_changed: triggers a full refresh", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: { timeout: 30 } })]);
    await client.subscribe("app");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { timeout: 99 } })]);
    ws._emit("configs_changed", {});
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toHaveLength(1);
    expect(events[0].newValue).toBe(99);
  });

  it("configs_changed: a failing refresh is swallowed", async () => {
    const { client, ws } = makeWired();
    mockListOnce([configResource({ id: "app", items: {} })]);
    await client.subscribe("app");

    mockFetch.mockRejectedValueOnce(new Error("network"));
    ws._emit("configs_changed", {});
    await new Promise((r) => setTimeout(r, 20));
    // No throw escapes.
  });

  it("config_deleted: a failing rebuild is swallowed", async () => {
    const { client, ws } = makeWired();
    mockListOnce([
      configResource({ id: "app", items: {}, parent: "base" }),
      configResource({ id: "base", items: { x: 1 } }),
    ]);
    await client.subscribe("app");

    // Force the rebuild's parent fetch to throw by deleting base (app inherits
    // from it) and stubbing the parent fetch to reject.
    const rebuild = vi.spyOn(
      client as unknown as { _rebuildResolvedCache: () => Promise<void> },
      "_rebuildResolvedCache",
    );
    rebuild.mockRejectedValueOnce(new Error("rebuild failed"));
    ws._emit("config_deleted", { id: "base" });
    await new Promise((r) => setTimeout(r, 20));
    // No throw escapes the handler's catch.
  });

  it("config_changed cascade: a descendant is re-resolved when its ancestor changes", async () => {
    const { client, ws } = makeWired({ environment: "staging" });
    mockListOnce([
      configResource({
        id: "parent",
        items: { retries: 3 },
        environments: { staging: { retries: 5 } },
      }),
      configResource({ id: "child", parent: "parent", items: {} }),
    ]);
    await client.subscribe("child");

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Scoped refetch of the changed parent only.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: configResource({
          id: "parent",
          items: { retries: 3 },
          environments: { staging: { retries: 7 } },
        }),
      }),
    );
    ws._emit("config_changed", { id: "parent" });
    await new Promise((r) => setTimeout(r, 20));

    const childEvents = events.filter((e) => e.configId === "child" && e.itemKey === "retries");
    expect(childEvents).toHaveLength(1);
    expect(childEvents[0].newValue).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// LiveConfigProxy
// ---------------------------------------------------------------------------

describe("LiveConfigProxy", () => {
  async function setupProxy() {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3, timeout: 1000 } })]);
    const proxy = await client.subscribe("app");
    return { client, proxy };
  }

  it("reflects live cache updates through subscript access", async () => {
    const { client, proxy } = await setupProxy();
    expect((proxy as Record<string, unknown>).retries).toBe(3);

    (client as unknown as { _configCache: Record<string, Record<string, unknown>> })._configCache[
      "app"
    ] = { retries: 7 };
    expect((proxy as Record<string, unknown>).retries).toBe(7);
  });

  it("supports the has() trap", async () => {
    const { proxy } = await setupProxy();
    expect("retries" in proxy).toBe(true);
    expect("missing" in proxy).toBe(false);
  });

  it("supports ownKeys() via Object.keys", async () => {
    const { proxy } = await setupProxy();
    expect(Object.keys(proxy)).toEqual(["retries", "timeout"]);
  });

  it("supports getOwnPropertyDescriptor() for present and absent keys", async () => {
    const { proxy } = await setupProxy();
    const desc = Object.getOwnPropertyDescriptor(proxy, "retries");
    expect(desc).toMatchObject({ value: 3, enumerable: true, configurable: true, writable: false });
    expect(Object.getOwnPropertyDescriptor(proxy, "missing")).toBeUndefined();
  });

  it("returns an empty view when the cache entry vanishes", async () => {
    const { client, proxy } = await setupProxy();
    delete (client as unknown as { _configCache: Record<string, unknown> })._configCache["app"];
    expect((proxy as Record<string, unknown>).retries).toBeUndefined();
  });

  it("exposes dict-style keys/values/items/get", async () => {
    const { proxy } = await setupProxy();
    expect(proxy.keys()).toEqual(["retries", "timeout"]);
    expect(proxy.values()).toEqual([3, 1000]);
    expect(proxy.items()).toEqual([
      ["retries", 3],
      ["timeout", 1000],
    ]);
    expect(proxy.get("retries")).toBe(3);
    expect(proxy.get("missing", 99)).toBe(99);
  });

  it("is read-only — set and delete throw", async () => {
    const { proxy } = await setupProxy();
    expect(() => {
      (proxy as Record<string, unknown>).retries = 99;
    }).toThrow(/read-only/);
    expect(() => {
      delete (proxy as Record<string, unknown>).retries;
    }).toThrow(/read-only/);
  });

  it("delegates symbol access to Reflect", async () => {
    const { proxy } = await setupProxy();
    expect(typeof String(proxy)).toBe("string");
    expect(() => `${proxy}`).not.toThrow();
    expect(Symbol.iterator in proxy).toBe(false);
    expect(Object.getOwnPropertyDescriptor(proxy, Symbol.iterator)).toBeUndefined();
  });

  it("falls back to own members for underscored / constructor / method props", async () => {
    const { proxy } = await setupProxy();
    // Own method, not a cached value.
    expect(typeof proxy.keys).toBe("function");
    // constructor and toJSON go through Reflect.
    expect((proxy as unknown as { constructor: unknown }).constructor).toBeDefined();
    expect((proxy as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
  });
});

describe("LiveConfigProxy.onChange", () => {
  async function setupProxy() {
    const { client } = makeWired();
    mockListOnce([configResource({ id: "app", items: { retries: 3, timeout: 1000 } })]);
    const proxy = await client.subscribe("app");
    return { client, proxy };
  }

  it("registers a config-scoped listener via the bare-callback form", async () => {
    const { client, proxy } = await setupProxy();
    const events: ConfigChangeEvent[] = [];
    proxy.onChange((e) => events.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 7, timeout: 1000 } })]);
    await client.refresh();
    expect(events).toHaveLength(1);
    expect(events[0].configId).toBe("app");
  });

  it("registers an item-scoped listener via the (itemKey, callback) form", async () => {
    const { client, proxy } = await setupProxy();
    const retriesEvents: ConfigChangeEvent[] = [];
    proxy.onChange("retries", (e) => retriesEvents.push(e));

    mockListOnce([configResource({ id: "app", items: { retries: 7, timeout: 2000 } })]);
    await client.refresh();
    expect(retriesEvents).toHaveLength(1);
    expect(retriesEvents[0].itemKey).toBe("retries");
  });

  it("throws TypeError when given an itemKey but no callback", async () => {
    const { proxy } = await setupProxy();
    expect(() => {
      // @ts-expect-error — intentional misuse
      proxy.onChange("retries");
    }).toThrow(TypeError);
  });
});
