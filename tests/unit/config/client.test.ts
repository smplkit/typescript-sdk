/**
 * Tests for the management/CRUD + discovery surface of the fused
 * ConfigClient: construction (standalone + wired), `new` / `get` / `list` /
 * `delete`, the active-record `Config.save()` / `.delete()` round-trip, the
 * owned discovery buffer (`registerConfig` / `registerConfigItem` / `flush` /
 * `pendingCount` + the threshold auto-flush), error wrapping, and `close()`.
 *
 * The live surface (subscribe / getValue / bind / refresh / onChange / WS
 * handlers / LiveConfigProxy) is exercised in prescriptive.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigClient,
  ConfigChangeEvent,
  ConfigRegistrationBuffer,
} from "../../../src/config/client.js";
import { Config } from "../../../src/config/types.js";
import {
  SmplkitConnectionError,
  SmplkitNotFoundError,
  SmplkitTimeoutError,
  SmplkitValidationError,
  SmplkitError,
} from "../../../src/errors.js";
import type { ConfigParent } from "../../../src/config/client.js";
import type { SharedWebSocket } from "../../../src/ws.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

/** A wire-format JSON:API config resource. */
function configResource(opts: {
  id: string;
  name?: string;
  description?: string | null;
  parent?: string | null;
  items?: Record<string, unknown>;
  environments?: Record<string, Record<string, unknown>>;
  createdAt?: string | null;
  updatedAt?: string | null;
}) {
  return {
    id: opts.id,
    type: "config",
    attributes: {
      name: opts.name ?? opts.id,
      description: opts.description ?? null,
      parent: opts.parent ?? null,
      items: Object.fromEntries(
        Object.entries(opts.items ?? {}).map(([k, v]) => [k, { value: v }]),
      ),
      environments: opts.environments ?? {},
      created_at: opts.createdAt ?? "2024-01-15T10:30:00Z",
      updated_at: opts.updatedAt ?? "2024-01-16T14:00:00Z",
    },
  };
}

/** Standalone client (owns its own transport). */
function makeStandalone(extra: Record<string, unknown> = {}): ConfigClient {
  return new ConfigClient({ apiKey: API_KEY, environment: "production", ...extra });
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("ConfigClient construction", () => {
  it("standalone form resolves its own transport and sends an Authorization header", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });

    const client = makeStandalone();
    await client.list();

    expect(seen).toHaveLength(1);
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(seen[0].url).toContain("/api/v1/configs");
  });

  it("standalone form honours a custom baseUrl and strips trailing slashes", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });

    const client = new ConfigClient({
      apiKey: API_KEY,
      environment: "production",
      baseUrl: "https://config.example.com///",
    });
    await client.list();

    expect(seen[0].url.startsWith("https://config.example.com/api/v1/configs")).toBe(true);
  });

  it("standalone form attaches extraHeaders to every request", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });

    const client = makeStandalone({ extraHeaders: { "X-Test": "v" } });
    await client.list();

    expect(seen[0].headers.get("x-test")).toBe("v");
    expect(seen[0].headers.get("authorization")).toMatch(/^Bearer /);
  });

  it("wired form borrows the supplied transport and parent identity", async () => {
    const parent: ConfigParent = {
      _environment: "staging",
      _service: "svc",
      _ensureStarted: vi.fn(),
      _ensureWs: vi.fn(),
    };
    const transport = {
      GET: vi.fn().mockResolvedValue({ response: { ok: true }, data: { data: [] } }),
    } as never;

    const client = new ConfigClient({ parent, transport });
    const result = await client.list();

    expect(result).toEqual([]);
    // Parent identity flows into observe declarations.
    client.registerConfig("c", { service: null, environment: null });
    expect(client.pendingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// new()
// ---------------------------------------------------------------------------

describe("new()", () => {
  it("returns an unsaved Config with a display-name derived from the id", () => {
    const client = makeStandalone();
    const cfg = client.new("billing-v2");
    expect(cfg).toBeInstanceOf(Config);
    expect(cfg.id).toBe("billing-v2");
    expect(cfg.name).toBe("Billing V2");
    expect(cfg.createdAt).toBeNull();
  });

  it("accepts an explicit name, description and string parent", () => {
    const client = makeStandalone();
    const cfg = client.new("child", {
      name: "Child Cfg",
      description: "desc",
      parent: "base",
    });
    expect(cfg.name).toBe("Child Cfg");
    expect(cfg.description).toBe("desc");
    expect(cfg.parent).toBe("base");
  });

  it("accepts a Config instance as the parent and reads its id", () => {
    const client = makeStandalone();
    const base = client.new("base");
    const child = client.new("child", { parent: base });
    expect(child.parent).toBe("base");
  });

  it("treats a null parent as no parent", () => {
    const client = makeStandalone();
    const cfg = client.new("solo", { parent: null });
    expect(cfg.parent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe("get()", () => {
  it("fetches and returns an editable Config", async () => {
    const client = makeStandalone();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "billing", items: { seats: 5 } }) }),
    );

    const cfg = await client.get("billing");
    expect(cfg).toBeInstanceOf(Config);
    expect(cfg.id).toBe("billing");
    expect(cfg.items).toEqual({ seats: 5 });
  });

  it("throws SmplkitNotFoundError when the server returns no data", async () => {
    const client = makeStandalone();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(client.get("missing")).rejects.toThrow(SmplkitNotFoundError);
  });

  it("maps a 404 response to SmplkitNotFoundError", async () => {
    const client = makeStandalone();
    mockFetch.mockResolvedValueOnce(textResponse("not found", 404));
    await expect(client.get("missing")).rejects.toThrow(SmplkitNotFoundError);
  });

  it("maps a 500 response to SmplkitError", async () => {
    const client = makeStandalone();
    mockFetch.mockResolvedValueOnce(textResponse("boom", 500));
    await expect(client.get("x")).rejects.toThrow(SmplkitError);
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("list()", () => {
  it("returns editable Config records", async () => {
    const client = makeStandalone();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [configResource({ id: "a" }), configResource({ id: "b" })],
      }),
    );

    const configs = await client.list();
    expect(configs.map((c) => c.id)).toEqual(["a", "b"]);
    expect(configs[0]).toBeInstanceOf(Config);
  });

  it("passes page[number] and page[size] query params", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });

    const client = makeStandalone();
    await client.list({ pageNumber: 2, pageSize: 25 });

    const url = seen[0].url;
    expect(url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect(url).toMatch(/page(\[|%5B)size(\]|%5D)=25/);
  });

  it("returns an empty array when openapi-fetch yields no parsed data (204)", async () => {
    const client = makeStandalone();
    // A 204 No Content yields no parsed success body, so `result.data` is
    // undefined and `list()` short-circuits to [].
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await client.list();
    expect(result).toEqual([]);
  });

  it("wraps an HTTP error into a typed SDK exception", async () => {
    const client = makeStandalone();
    mockFetch.mockResolvedValueOnce(textResponse("server error", 500));
    await expect(client.list()).rejects.toThrow(SmplkitError);
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("delete()", () => {
  it("issues a DELETE and resolves on 204", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return new Response(null, { status: 204 });
    });

    const client = makeStandalone();
    await client.delete("billing");

    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].url).toContain("/api/v1/configs/billing");
  });

  it("resolves on a 200 OK as well", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    const client = makeStandalone();
    await expect(client.delete("billing")).resolves.toBeUndefined();
  });

  it("raises on a non-204 error status", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("nope", 404));
    const client = makeStandalone();
    await expect(client.delete("missing")).rejects.toThrow(SmplkitNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Config.save() / Config.delete() round-trip through the client
// ---------------------------------------------------------------------------

describe("Config active-record round-trip", () => {
  it("save() on a new config POSTs and applies the server response", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({
        data: configResource({
          id: "billing",
          name: "Billing",
          items: { seats: 50 },
          createdAt: "2024-02-01T00:00:00Z",
        }),
      });
    });

    const client = makeStandalone();
    const cfg = client.new("billing", { name: "Billing" });
    cfg.setNumber("seats", 50);
    await cfg.save();

    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toContain("/api/v1/configs");
    // Server result applied back onto the model.
    expect(cfg.createdAt).toBe("2024-02-01T00:00:00Z");
  });

  it("save() on an existing config PUTs to the id path", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({
        data: configResource({ id: "billing", name: "Renamed" }),
      });
    });

    const client = makeStandalone();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "billing", name: "Billing" }) }),
    );
    const cfg = await client.get("billing");
    cfg.name = "Renamed";
    await cfg.save();

    const put = seen.find((r) => r.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.url).toContain("/api/v1/configs/billing");
    expect(cfg.name).toBe("Renamed");
  });

  it("save() includes description, parent and environments in the body", async () => {
    const bodies: unknown[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      bodies.push(await req.clone().json());
      return jsonResponse({
        data: configResource({ id: "child", createdAt: "2024-02-01T00:00:00Z" }),
      });
    });

    const client = makeStandalone();
    const cfg = client.new("child", { description: "desc", parent: "base" });
    cfg.setString("region", "us-east", { environment: "production" });
    await cfg.save();

    const body = bodies[0] as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes.description).toBe("desc");
    expect(body.data.attributes.parent).toBe("base");
    expect(body.data.attributes.environments).toEqual({ production: { region: "us-east" } });
  });

  it("delete() on an editable config DELETEs through the client", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: configResource({ id: "billing" }) }));
    const client = makeStandalone();
    const cfg = await client.get("billing");

    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return new Response(null, { status: 204 });
    });
    await cfg.delete();

    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].url).toContain("/api/v1/configs/billing");
  });

  it("_fetchConfig resolves a parent not present in the supplied configs list", async () => {
    // Config._buildChain calls client._fetchConfig(parentId) when the parent
    // is not in the local list — that GET round-trips through get().
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "child", parent: "base", items: { a: 1 } }) }),
    );
    const client = makeStandalone();
    const child = await client.get("child");

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: configResource({ id: "base", items: { b: 2 } }) }),
    );
    const chain = await child._buildChain();
    expect(chain.map((c) => c.id)).toEqual(["child", "base"]);
  });

  it("_updateConfig wraps a server error on PUT", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: configResource({ id: "billing" }) }));
    const client = makeStandalone();
    const cfg = await client.get("billing");
    cfg.name = "Renamed";
    // PUT fails with a 500.
    mockFetch.mockResolvedValueOnce(textResponse("server error", 500));
    await expect(cfg.save()).rejects.toThrow(SmplkitError);
  });

  it("_updateConfig throws when the config has no id", async () => {
    const client = makeStandalone();
    const cfg = new Config(client, {
      id: null,
      name: "X",
      description: null,
      parent: null,
      items: {},
      environments: {},
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: null,
    });
    await expect(cfg.save()).rejects.toThrow(/Cannot update a Config with no id/);
  });

  it("_createConfig raises when the server returns no data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const client = makeStandalone();
    const cfg = client.new("billing");
    await expect(cfg.save()).rejects.toThrow(SmplkitValidationError);
  });

  it("_updateConfig raises when the server returns no data", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: configResource({ id: "billing" }) }));
    const client = makeStandalone();
    const cfg = await client.get("billing");
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(cfg.save()).rejects.toThrow(SmplkitValidationError);
  });
});

// ---------------------------------------------------------------------------
// Error wrapping
// ---------------------------------------------------------------------------

describe("error wrapping", () => {
  it("maps a network TypeError to SmplkitConnectionError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = makeStandalone();
    await expect(client.list()).rejects.toThrow(SmplkitConnectionError);
  });

  it("maps a DOMException AbortError to SmplkitTimeoutError", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const client = makeStandalone({ timeout: 5 });
    await expect(client.list()).rejects.toThrow(SmplkitTimeoutError);
  });

  it("maps a generic non-Error rejection to SmplkitConnectionError", async () => {
    mockFetch.mockRejectedValueOnce("string failure");
    const client = makeStandalone();
    await expect(client.list()).rejects.toThrow(SmplkitConnectionError);
  });

  it("re-raises an already-typed SmplkitNotFoundError unchanged", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("missing", 404));
    const client = makeStandalone();
    await expect(client.get("missing")).rejects.toThrow(SmplkitNotFoundError);
  });

  it("maps a 409 conflict to its typed error during create", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("conflict", 409));
    const client = makeStandalone();
    const cfg = client.new("billing");
    await expect(cfg.save()).rejects.toThrow(/HTTP 409/);
  });

  it("maps a 422 validation error during create", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ status: "422", detail: "bad" }] }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = makeStandalone();
    const cfg = client.new("billing");
    await expect(cfg.save()).rejects.toThrow(SmplkitValidationError);
  });
});

// ---------------------------------------------------------------------------
// Discovery buffer (owned)
// ---------------------------------------------------------------------------

describe("discovery buffer", () => {
  it("registerConfig + registerConfigItem grow pendingCount", () => {
    const client = makeStandalone();
    expect(client.pendingCount).toBe(0);
    client.registerConfig("billing", { service: "svc", environment: "production" });
    expect(client.pendingCount).toBe(1);
    client.registerConfigItem("billing", "seats", "NUMBER", 5);
    // Items attach to the existing config entry — still one pending config.
    expect(client.pendingCount).toBe(1);
  });

  it("registerConfigItem before registerConfig is ignored", () => {
    const client = makeStandalone();
    client.registerConfigItem("unknown", "k", "STRING", "v");
    expect(client.pendingCount).toBe(0);
  });

  it("flush POSTs the drained batch to /configs/bulk", async () => {
    const seen: Request[] = [];
    const bodies: unknown[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      bodies.push(await req.clone().json());
      return jsonResponse({}, 200);
    });

    const client = makeStandalone();
    client.registerConfig("billing", { service: "svc", environment: "production" });
    client.registerConfigItem("billing", "seats", "NUMBER", 5, "max seats");
    await client.flush();

    expect(seen[0].url).toContain("/api/v1/configs/bulk");
    const body = bodies[0] as { configs: Array<{ id: string; items: Record<string, unknown> }> };
    expect(body.configs[0].id).toBe("billing");
    expect(body.configs[0].items.seats).toEqual({
      value: 5,
      type: "NUMBER",
      description: "max seats",
    });
    // Buffer drained.
    expect(client.pendingCount).toBe(0);
  });

  it("flush with an empty buffer is a no-op (no request)", async () => {
    const client = makeStandalone();
    await client.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("flush swallows a non-OK bulk response", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("boom", 500));
    const client = makeStandalone();
    client.registerConfig("c", { service: null, environment: null });
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("flush swallows a thrown network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    const client = makeStandalone();
    client.registerConfig("c", { service: null, environment: null });
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("auto-flushes when the buffer crosses the batch threshold", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200));
    const client = makeStandalone();
    // CONFIG_BATCH_FLUSH_SIZE is 50 — declare 50 distinct configs.
    for (let i = 0; i < 50; i++) {
      client.registerConfig(`cfg-${i}`, { service: "svc", environment: "production" });
    }
    // Allow the fire-and-forget threshold flush to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalled();
    const url = mockFetch.mock.calls[0][0].url as string;
    expect(url).toContain("/api/v1/configs/bulk");
  });

  it("auto-flushes from registerConfigItem once the buffer is at threshold", async () => {
    const client = makeStandalone();
    // Replace flush with a non-draining stub so the buffer can sit at its
    // threshold across multiple register calls — exercising the threshold
    // guard inside registerConfigItem rather than the one in registerConfig.
    const flush = vi.spyOn(client, "flush").mockResolvedValue(undefined);
    for (let i = 0; i < 50; i++) {
      client.registerConfig(`cfg-${i}`, { service: "svc", environment: "production" });
    }
    // 50 registerConfig calls → 50 threshold flushes (each a no-op stub).
    flush.mockClear();
    client.registerConfigItem("cfg-0", "k", "STRING", "v");
    await new Promise((r) => setTimeout(r, 0));
    // The item-side guard fired because pendingCount is still >= 50.
    expect(flush).toHaveBeenCalled();
  });

  it("a failed threshold flush is swallowed (debug only)", async () => {
    const client = makeStandalone();
    // Make flush itself reject so _thresholdFlush's catch runs.
    vi.spyOn(client, "flush").mockRejectedValue(new Error("flush boom"));
    for (let i = 0; i < 50; i++) {
      client.registerConfig(`cfg-${i}`, { service: "svc", environment: "production" });
    }
    // No throw escapes the fire-and-forget threshold flush.
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// ConfigRegistrationBuffer (direct unit tests for the owned buffer)
// ---------------------------------------------------------------------------

describe("ConfigRegistrationBuffer", () => {
  const meta = {
    service: "svc",
    environment: "production",
    parent: null,
    name: null,
    description: null,
  };

  it("declare is idempotent per config id", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("a", meta);
    buf.declare("a", { ...meta, name: "Second" });
    expect(buf.pendingCount).toBe(1);
    const [entry] = buf.drain();
    // First declaration wins; the second is ignored.
    expect(entry.name).toBeUndefined();
  });

  it("_buildEntry includes only non-null meta fields", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("a", {
      service: "svc",
      environment: "production",
      parent: "base",
      name: "A",
      description: "d",
    });
    const [entry] = buf.drain();
    expect(entry).toMatchObject({
      id: "a",
      service: "svc",
      environment: "production",
      parent: "base",
      name: "A",
      description: "d",
    });
  });

  it("addItem is ignored when the config was never declared", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.addItem("never", "k", "STRING", "v", null);
    expect(buf.pendingCount).toBe(0);
  });

  it("addItem records value, type and optional description", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("a", meta);
    buf.addItem("a", "k1", "STRING", "v", "desc");
    buf.addItem("a", "k2", "NUMBER", 5, null);
    const [entry] = buf.drain();
    expect(entry.items.k1).toEqual({ value: "v", type: "STRING", description: "desc" });
    expect(entry.items.k2).toEqual({ value: 5, type: "NUMBER" });
  });

  it("addItem dedupes a key already present in the entry", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("a", meta);
    buf.addItem("a", "k", "STRING", "first", null);
    buf.addItem("a", "k", "STRING", "second", null);
    const [entry] = buf.drain();
    expect(entry.items.k).toEqual({ value: "first", type: "STRING" });
  });

  it("drain records sent items so an already-sent item is not re-queued", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("a", meta);
    buf.addItem("a", "k", "STRING", "v", null);
    buf.drain();
    // declare("a") is a no-op (meta persists), and re-adding the same item is
    // suppressed by the _sentItems guard — so the next drain is empty.
    buf.declare("a", meta);
    buf.addItem("a", "k", "STRING", "v", null);
    expect(buf.pendingCount).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it("addItem rebuilds a pending entry when one was drained but meta persists", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("a", meta);
    buf.drain();
    // After drain the pending entry is gone but the meta lingers — addItem
    // for a NEW key rebuilds the entry from meta.
    buf.addItem("a", "fresh", "STRING", "v", null);
    expect(buf.pendingCount).toBe(1);
    const [entry] = buf.drain();
    expect(entry.items.fresh).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ConfigChangeEvent
// ---------------------------------------------------------------------------

describe("ConfigChangeEvent", () => {
  it("is frozen and exposes its fields", () => {
    const event = new ConfigChangeEvent({
      configId: "billing",
      itemKey: "seats",
      oldValue: 5,
      newValue: 50,
      source: "manual",
    });
    expect(event.configId).toBe("billing");
    expect(event.itemKey).toBe("seats");
    expect(event.oldValue).toBe(5);
    expect(event.newValue).toBe(50);
    expect(event.source).toBe("manual");
    expect(Object.isFrozen(event)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe("close()", () => {
  it("is a no-op for a standalone client that never opened a WebSocket", () => {
    const client = makeStandalone();
    expect(() => client.close()).not.toThrow();
  });

  it("stops and clears an owned WebSocket opened on first live use", async () => {
    const stop = vi.fn();
    const ws = {
      start: vi.fn(),
      stop,
      on: vi.fn(),
    } as unknown as SharedWebSocket;

    const client = makeStandalone();
    // Inject a fake owned WebSocket through the private fields the standalone
    // path manages, then ensure close() tears it down.
    (client as unknown as { _wsManager: SharedWebSocket; _ownsWs: boolean })._wsManager = ws;
    (client as unknown as { _ownsWs: boolean })._ownsWs = true;

    client.close();
    expect(stop).toHaveBeenCalledTimes(1);
    // Second close is a no-op.
    client.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
