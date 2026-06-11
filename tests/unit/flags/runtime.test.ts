/**
 * FlagsClient end-to-end behaviour:
 *
 * - Management CRUD: get / list / delete / _createFlag / _updateFlag.
 * - Lazy connect: _ensureConnected flushes discovery, paginates the flag
 *   fetch, clears the cache, and subscribes to the shared WebSocket once.
 * - Live surface: refresh / stats / onChange / setContextProvider.
 * - Evaluation metrics + context registration.
 * - Standalone construction (owns its transport + WebSocket) and close().
 * - Error wrapping (network, not-found, validation, timeout).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagsClient, FlagStats, FlagChangeEvent } from "../../../src/flags/client.js";
import { Flag, FlagValue } from "../../../src/flags/models.js";
import { Context } from "../../../src/flags/types.js";
import {
  SmplError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
  SmplConnectionError,
  SmplTimeoutError,
} from "../../../src/errors.js";
import {
  makeWiredClient,
  jsonResponse,
  textResponse,
  flagListResponse,
  createMockSharedWs,
} from "./_helpers.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function flagAttrs(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    name: "My Flag",
    type: "BOOLEAN",
    default: false,
    values: [{ name: "True", value: true }],
    description: "desc",
    environments: { staging: { enabled: true, default: null, rules: [] } },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-02-01T00:00:00Z",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Management CRUD
// ---------------------------------------------------------------------------

describe("FlagsClient.get()", () => {
  it("returns a typed Flag built from the wire resource", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "my-flag", type: "flag", attributes: flagAttrs() } }),
    );

    const flag = await client.get("my-flag");

    expect(flag).toBeInstanceOf(Flag);
    expect(flag.id).toBe("my-flag");
    expect(flag.type).toBe("BOOLEAN");
    expect(flag.values?.[0]).toBeInstanceOf(FlagValue);
    expect(flag.environments.staging.enabled).toBe(true);
    expect(flag.createdAt).toBe("2024-01-01T00:00:00Z");
  });

  it("converts rules + env defaults from the wire shape", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "f",
          type: "flag",
          attributes: flagAttrs({
            values: null,
            description: null,
            environments: {
              staging: {
                enabled: false,
                default: "blue",
                rules: [{ logic: { "==": [1, 1] }, value: "x", description: "r" }],
              },
              bad: { rules: "not-an-array" },
            },
          }),
        },
      }),
    );

    const flag = await client.get("f");
    expect(flag.values).toBeNull();
    expect(flag.environments.staging.enabled).toBe(false);
    expect(flag.environments.staging.default).toBe("blue");
    expect(flag.environments.staging.rules[0].description).toBe("r");
    // Non-array rules degrade to an empty rule list.
    expect(flag.environments.bad.rules).toEqual([]);
    expect(flag.environments.bad.enabled).toBe(true);
  });

  it("throws SmplNotFoundError when the body has no data", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
    await expect(client.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("maps a non-OK response to a typed error", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(textResponse("nope", 404));
    await expect(client.get("missing")).rejects.toThrow(SmplNotFoundError);
  });
});

describe("FlagsClient.list()", () => {
  it("returns typed flags and omits page params when not given", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      flagListResponse([{ id: "a" }, { id: "b", type: "STRING", default: "x" }]),
    );

    const flags = await client.list();
    expect(flags).toHaveLength(2);
    const url = mockFetch.mock.calls[0][0].url as string;
    expect(url).not.toContain("page");
  });

  it("forwards page[number] and page[size]", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    await client.list({ pageNumber: 2, pageSize: 25 });
    const url = mockFetch.mock.calls[0][0].url as string;
    expect(url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect(url).toMatch(/page(\[|%5B)size(\]|%5D)=25/);
  });

  it("returns an empty list when the response has no body", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await client.list()).toEqual([]);
  });

  it("builds the correct typed subclass for each flag type", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      flagListResponse([
        { id: "b", type: "BOOLEAN", default: false },
        { id: "s", type: "STRING", default: "x" },
        { id: "n", type: "NUMERIC", default: 1 },
        { id: "j", type: "JSON", default: { a: 1 } },
        { id: "u", type: "WHATEVER", default: null },
      ]),
    );
    const flags = await client.list();
    const byId = Object.fromEntries(flags.map((f) => [f.id, f.constructor.name]));
    expect(byId).toEqual({
      b: "BooleanFlag",
      s: "StringFlag",
      n: "NumberFlag",
      j: "JsonFlag",
      u: "Flag", // unknown type falls through to the base Flag class
    });
  });
});

describe("FlagsClient.delete()", () => {
  it("succeeds on a 200 response", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(client.delete("f")).resolves.toBeUndefined();
  });

  it("treats 204 as success", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.delete("f")).resolves.toBeUndefined();
  });

  it("maps a non-OK, non-204 response to a typed error", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(textResponse("conflict", 409));
    await expect(client.delete("f")).rejects.toThrow(SmplConflictError);
  });
});

describe("FlagsClient._createFlag()", () => {
  it("POSTs a create envelope and returns the saved Flag (via save())", async () => {
    const { client } = makeWiredClient();
    const flag = client.newBooleanFlag("beta", { default: false, description: "Beta gate" });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: { id: "beta", type: "flag", attributes: flagAttrs({ name: "Beta" }) },
      }),
    );

    await flag.save();

    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("POST");
    expect(new URL(req.url).pathname).toBe("/api/v1/flags");
    const body = JSON.parse(await req.clone().text());
    expect(body.data.id).toBe("beta");
    expect(body.data.attributes.type).toBe("BOOLEAN");
    expect(flag.name).toBe("Beta");
  });

  it("serializes environments into the wire shape on create", async () => {
    const { client } = makeWiredClient();
    const flag = client.newStringFlag("color", { default: "red" });
    flag.addRule({
      environment: "staging",
      description: "ent",
      logic: { "==": [{ var: "user.plan" }, "enterprise"] },
      value: "blue",
    });
    flag.setDefault("green", { environment: "staging" });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "color", type: "flag", attributes: flagAttrs() } }),
    );

    await flag.save();

    const body = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).clone().text());
    expect(body.data.attributes.environments.staging.default).toBe("green");
    expect(body.data.attributes.environments.staging.rules[0]).toMatchObject({
      value: "blue",
      description: "ent",
    });
  });

  it("throws SmplValidationError when the create response has no data", async () => {
    const { client } = makeWiredClient();
    const flag = client.newBooleanFlag("x", { default: false });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
    await expect(flag.save()).rejects.toThrow(SmplValidationError);
  });

  it("wraps a network error during create", async () => {
    const { client } = makeWiredClient();
    const flag = client.newBooleanFlag("x", { default: false });
    mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    await expect(flag.save()).rejects.toThrow(SmplConnectionError);
  });
});

describe("FlagsClient._updateFlag()", () => {
  it("PUTs an update envelope and returns the saved Flag (via save())", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "my-flag", type: "flag", attributes: flagAttrs() } }),
    );
    const flag = await client.get("my-flag");

    flag.setDefault(true);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: { id: "my-flag", type: "flag", attributes: flagAttrs({ default: true }) },
      }),
    );
    await flag.save();

    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("PUT");
    expect(new URL(req.url).pathname).toBe("/api/v1/flags/my-flag");
    expect(flag.default).toBe(true);
  });

  it("omits the description on a rule when it is null", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "f", type: "flag", attributes: flagAttrs({ values: null }) } }),
    );
    const flag = await client.get("f");
    flag.addRule({ environment: "staging", logic: {}, value: true }); // no description

    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "f", type: "flag", attributes: flagAttrs() } }),
    );
    await flag.save();

    const body = JSON.parse(await (mockFetch.mock.calls[1][0] as Request).clone().text());
    const rule = body.data.attributes.environments.staging.rules[0];
    expect(rule).not.toHaveProperty("description");
  });

  it("throws when _updateFlag is called on a flag with no id", async () => {
    const { client } = makeWiredClient();
    const flag = new Flag(client as any, {
      id: null,
      name: "X",
      type: "BOOLEAN",
      default: false,
      values: null,
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    await expect(client._updateFlag(flag)).rejects.toThrow(/Cannot update a Flag with no id/);
  });

  it("throws SmplValidationError when the update response has no data", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "f", type: "flag", attributes: flagAttrs() } }),
    );
    const flag = await client.get("f");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
    await expect(flag.save()).rejects.toThrow(SmplValidationError);
  });

  it("wraps a network error during update", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: { id: "f", type: "flag", attributes: flagAttrs() } }),
    );
    const flag = await client.get("f");
    mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError("offline")));
    await expect(flag.save()).rejects.toThrow(SmplConnectionError);
  });
});

describe("new* factories", () => {
  it("newBooleanFlag derives a display name and on/off values", () => {
    const { client } = makeWiredClient();
    const flag = client.newBooleanFlag("dark-mode", { default: true });
    expect(flag.name).toBe("Dark Mode");
    expect(flag.values?.map((v) => v.name)).toEqual(["True", "False"]);
    expect(flag.default).toBe(true);
  });

  it("newStringFlag accepts an explicit name and coerces value objects", () => {
    const { client } = makeWiredClient();
    const flag = client.newStringFlag("theme", {
      default: "light",
      name: "Theme",
      values: [{ name: "Light", value: "light" }, new FlagValue({ name: "Dark", value: "dark" })],
    });
    expect(flag.name).toBe("Theme");
    expect(flag.values).toHaveLength(2);
    expect(flag.values?.[0]).toBeInstanceOf(FlagValue);
  });

  it("newNumberFlag / newJsonFlag default to null values when none are given", () => {
    const { client } = makeWiredClient();
    expect(client.newNumberFlag("n", { default: 1 }).values).toBeNull();
    expect(client.newJsonFlag("j", { default: { a: 1 } }).values).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lazy connect
// ---------------------------------------------------------------------------

describe("_ensureConnected (lazy)", () => {
  it("starts the parent, flushes discovery before fetch, then subscribes to WS", async () => {
    const { client, ensureStarted, ws } = makeWiredClient({
      service: "svc",
      environment: "staging",
    });
    await client.register(new FlagDeclarationStub());

    const calls: string[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/flags/bulk") {
        calls.push("bulk");
        return jsonResponse({ registered: 1 });
      }
      calls.push("list");
      return flagListResponse([{ id: "f" }]);
    });

    await client.refresh(); // first live call → connect

    expect(ensureStarted).toHaveBeenCalled();
    expect(calls[0]).toBe("bulk");
    expect(calls[1]).toBe("list");
    expect(ws.on).toHaveBeenCalledWith("flag_changed", expect.any(Function));
    expect(ws.on).toHaveBeenCalledWith("flag_deleted", expect.any(Function));
    expect(ws.on).toHaveBeenCalledWith("flags_changed", expect.any(Function));
  });

  it("connects only once and registers WS handlers a single time", async () => {
    const { client, ws } = makeWiredClient();
    mockFetch.mockImplementation(async () => flagListResponse([]));

    await client.refresh();
    await client.refresh();

    // 3 WS event subscriptions, total — not 6.
    expect(ws.on).toHaveBeenCalledTimes(3);
  });

  it("swallows a discovery-flush error before connecting", async () => {
    const { client } = makeWiredClient();
    await client.register(new FlagDeclarationStub());
    mockFetch.mockImplementation(async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === "/api/v1/flags/bulk") return textResponse("err", 500);
      return flagListResponse([]);
    });

    // The flush rejection is logged (debug) and connect proceeds regardless.
    await expect((client as any)._ensureConnected()).resolves.toBeUndefined();
  });

  it("paginates the flag fetch when the first page is full", async () => {
    const { client } = makeWiredClient();
    const PAGE = 1000;
    const firstPage = Array.from({ length: PAGE }, (_, i) => ({ id: `f-${i}` }));
    // Key the response on the requested page number so each GET gets a fresh
    // Response and the loop terminates after the short second page.
    mockFetch.mockImplementation(async (req: Request) => {
      const page = new URL(req.url).searchParams.get("page[number]");
      return page === "1"
        ? flagListResponse(firstPage)
        : flagListResponse([{ id: "f-last", default: true }]);
    });

    await (client as any)._ensureConnected();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const url1 = mockFetch.mock.calls[0][0].url as string;
    const url2 = mockFetch.mock.calls[1][0].url as string;
    expect(url1).toMatch(/page(\[|%5B)number(\]|%5D)=1/);
    expect(url2).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect((client as any)._flagStore["f-last"]).toBeDefined();
  });

  it("stops paging when the first page is short", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "only" }]));
    await (client as any)._ensureConnected();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// refresh / stats / onChange / context provider
// ---------------------------------------------------------------------------

describe("refresh / stats / onChange", () => {
  it("refresh fires change listeners for every stored flag", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "my-flag" }]));
    const changes: string[] = [];
    await client.onChange((e) => changes.push(`${e.id}:${e.source}`));

    mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "my-flag", default: true }]));
    await client.refresh();

    expect(changes).toContain("my-flag:manual");
  });

  it("stats reports cache hit/miss counters", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    const stats = await client.stats();
    expect(stats).toBeInstanceOf(FlagStats);
    expect(stats.cacheHits).toBe(0);
    expect(stats.cacheMisses).toBe(0);
  });

  it("onChange(callback) registers a global listener", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValue(flagListResponse([{ id: "f" }]));
    const seen: string[] = [];
    await client.onChange((e) => seen.push(e.id));
    mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "f", default: true }]));
    await client.refresh();
    expect(seen).toContain("f");
  });

  it("onChange(id, callback) registers a key-scoped listener", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValue(flagListResponse([{ id: "a" }, { id: "b" }]));
    const seen: string[] = [];
    await client.onChange("a", (e) => seen.push(e.id));
    mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "a" }, { id: "b" }]));
    await client.refresh();
    expect(seen).toEqual(["a"]);
  });

  it("onChange(id) without a callback throws", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    await expect((client as any).onChange("a")).rejects.toThrow(SmplError);
  });

  it("setContextProvider and contextProvider both install the provider", async () => {
    const { client } = makeWiredClient();
    const fn = () => [new Context("user", "u-1", { plan: "free" })];
    client.setContextProvider(fn);
    expect((client as any)._contextProvider).toBe(fn);

    const returned = client.contextProvider(fn);
    expect(returned).toBe(fn);
    expect((client as any)._contextProvider).toBe(fn);
  });
});

// ---------------------------------------------------------------------------
// Evaluation: metrics + context registration
// ---------------------------------------------------------------------------

describe("_evaluateHandle metrics + context registration", () => {
  function seed(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
    (client as any)._flagStore = store;
    (client as any)._connected = true;
  }

  it("records cache-miss then cache-hit metrics and registers explicit context", () => {
    const metrics = { record: vi.fn(), recordGauge: vi.fn() };
    const { client, contexts } = makeWiredClient({ metrics });
    seed(client, { f: { id: "f", default: "x", environments: {} } });

    const ctx = [new Context("user", "u-1", { plan: "free" })];
    const v1 = client._evaluateHandle("f", "def", ctx); // miss
    const v2 = client._evaluateHandle("f", "def", ctx); // hit
    expect(v1).toBe("x");
    expect(v2).toBe("x");

    expect(contexts.register).toHaveBeenCalledWith(ctx);
    const names = metrics.record.mock.calls.map((c) => c[0]);
    expect(names).toContain("flags.cache_misses");
    expect(names).toContain("flags.cache_hits");
    expect(names).toContain("flags.evaluations");
  });

  it("uses the context provider and registers its contexts", () => {
    const { client, contexts } = makeWiredClient();
    seed(client, { f: { id: "f", default: "x", environments: {} } });
    const provided = [new Context("user", "u-2", { plan: "pro" })];
    client.setContextProvider(() => provided);

    client._evaluateHandle("f", "def", null);
    expect(contexts.register).toHaveBeenCalledWith(provided);
  });

  it("falls back to the code default and caches it when the flag is absent", () => {
    const metrics = { record: vi.fn(), recordGauge: vi.fn() };
    const { client } = makeWiredClient({ metrics });
    seed(client, {});
    expect(client._evaluateHandle("missing", "fallback", null)).toBe("fallback");
    // Cached miss returns the same value without metrics on the absent path.
    expect(client._evaluateHandle("missing", "fallback", null)).toBe("fallback");
  });

  it("returns the code default when evaluation yields null/undefined", () => {
    const { client } = makeWiredClient();
    seed(client, {
      f: { id: "f", default: null, environments: { staging: { enabled: true, rules: [] } } },
    });
    expect(client._evaluateHandle("f", "fallback", null)).toBe("fallback");
  });

  it("does not register context when there is no contexts seam", () => {
    const { client } = makeWiredClient({ contexts: null });
    seed(client, { f: { id: "f", default: "x", environments: {} } });
    // Provider path with no contexts seam must not throw.
    client.setContextProvider(() => [new Context("user", "u", {})]);
    expect(client._evaluateHandle("f", "def", null)).toBe("x");
    // Explicit-context path with no contexts seam must not throw either.
    expect(client._evaluateHandle("f", "def", [new Context("user", "u2", {})])).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Standalone construction + close
// ---------------------------------------------------------------------------

describe("standalone construction", () => {
  it("builds its own transport, owns a WebSocket on first live use, and close() tears it down", async () => {
    // Patch SharedWebSocket so the standalone client's _ensureWs uses our mock.
    const wsMod = await import("../../../src/ws.js");
    const mockWs = createMockSharedWs();
    const ctor = vi.spyOn(wsMod, "SharedWebSocket").mockImplementation(() => mockWs as any);

    const client = new FlagsClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://flags.example.com",
      baseDomain: "example.com",
    });

    mockFetch.mockImplementation(async () => flagListResponse([{ id: "f" }]));
    await client.refresh();

    expect(ctor).toHaveBeenCalled();
    expect(mockWs.start).toHaveBeenCalled();
    expect((client as any)._ownsWs).toBe(true);

    client.close();
    expect(mockWs.stop).toHaveBeenCalled();
    expect((client as any)._ownsWs).toBe(false);

    // Second close is a no-op.
    expect(() => client.close()).not.toThrow();
    ctor.mockRestore();
  });

  it("sends the standalone flags request to the resolved base URL with auth", async () => {
    const client = new FlagsClient({
      apiKey: "sk_standalone",
      environment: "production",
      baseUrl: "https://flags.example.com/",
      extraHeaders: { "X-Custom": "v" },
    });
    mockFetch.mockResolvedValueOnce(flagListResponse([]));

    await client.list();

    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.url.startsWith("https://flags.example.com/api/v1/flags")).toBe(true);
    expect(req.headers.get("authorization")).toBe("Bearer sk_standalone");
    expect(req.headers.get("x-custom")).toBe("v");
  });

  it("times out a standalone request via the abort wrapper", async () => {
    const client = new FlagsClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://flags.example.com",
      timeout: 5,
    });
    mockFetch.mockImplementationOnce(() =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    await expect(client.list()).rejects.toThrow(SmplTimeoutError);
  });

  it("re-raises a non-abort error from the standalone fetch wrapper", async () => {
    const client = new FlagsClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://flags.example.com",
    });
    mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError("boom")));
    await expect(client.list()).rejects.toThrow(SmplConnectionError);
  });

  it("close() on a wired client (no owned WS) is a no-op", () => {
    const { client } = makeWiredClient();
    expect(() => client.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Error wrapping (wrapFetchError)
// ---------------------------------------------------------------------------

describe("error wrapping", () => {
  it("wraps a raw TypeError network failure as SmplConnectionError", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockImplementationOnce(() => Promise.reject(new TypeError("fetch failed")));
    await expect(client.get("f")).rejects.toThrow(SmplConnectionError);
  });

  it("wraps an arbitrary error as SmplConnectionError", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockImplementationOnce(() => Promise.reject("weird"));
    await expect(client.list()).rejects.toThrow(SmplConnectionError);
  });

  it("re-throws an already-typed SDK error unchanged", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(textResponse("conflict", 409));
    await expect(client.get("f")).rejects.toBeInstanceOf(SmplConflictError);
  });

  it("FlagChangeEvent is frozen with the expected fields", () => {
    const ev = new FlagChangeEvent({ id: "f", source: "manual" });
    expect(ev.id).toBe("f");
    expect(ev.source).toBe("manual");
    expect(ev.deleted).toBe(false);
    expect(() => {
      (ev as any).id = "x";
    }).toThrow();
  });
});

// A tiny FlagDeclaration stub avoids importing the class into the connect tests.
import { FlagDeclaration } from "../../../src/flags/types.js";
class FlagDeclarationStub extends FlagDeclaration {
  constructor() {
    super({ id: "decl", type: "BOOLEAN", default: false });
  }
}
