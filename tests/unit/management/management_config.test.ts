/**
 * Tests for ManagementConfigClient (mgmt.config.*).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplManagementClient } from "../../../src/management/client.js";
import { Config, ConfigEnvironment, ItemType } from "../../../src/config/types.js";
import {
  SmplNotFoundError,
  SmplConnectionError,
  SmplValidationError,
  SmplConflictError,
} from "../../../src/errors.js";

// ---------------------------------------------------------------------------
// Shared fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_config_test";

function makeClient(): SmplManagementClient {
  return new SmplManagementClient({
    apiKey: API_KEY,
    baseDomain: "test",
    scheme: "http",
  });
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

// ---------------------------------------------------------------------------
// Sample resources
// ---------------------------------------------------------------------------

const SAMPLE_CONFIG = {
  id: "checkout",
  type: "config",
  attributes: {
    name: "Checkout",
    description: "Checkout flow config",
    parent: null,
    items: {
      timeout: { value: 30, type: "NUMBER" },
      currency: { value: "USD", type: "STRING" },
    },
    environments: {
      production: { values: { timeout: { value: 60, type: "NUMBER" } } },
    },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
  },
};

const SAMPLE_CHILD_CONFIG = {
  id: "checkout-child",
  type: "config",
  attributes: {
    name: "Checkout Child",
    description: null,
    parent: "checkout",
    items: {},
    environments: {},
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
  },
};

// ===========================================================================
// new()
// ===========================================================================

describe("ManagementConfigClient.new()", () => {
  it("returns an unsaved Config instance", () => {
    const client = makeClient();
    const cfg = client.config.new("checkout");
    expect(cfg).toBeInstanceOf(Config);
    expect(cfg.id).toBe("checkout");
    expect(cfg.createdAt).toBeNull();
    expect(cfg.updatedAt).toBeNull();
  });

  it("derives display name from id when not provided", () => {
    const client = makeClient();
    const cfg = client.config.new("checkout-flow");
    expect(cfg.name).toBe("Checkout Flow");
  });

  it("accepts an explicit name", () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { name: "Checkout V2" });
    expect(cfg.name).toBe("Checkout V2");
  });

  it("accepts description and parent (string)", () => {
    const client = makeClient();
    const cfg = client.config.new("child", {
      description: "child config",
      parent: "checkout",
    });
    expect(cfg.description).toBe("child config");
    expect(cfg.parent).toBe("checkout");
  });

  it("accepts a Config instance as parent and uses its id", () => {
    const client = makeClient();
    const parent = client.config.new("checkout");
    parent.id = "checkout";
    const child = client.config.new("child", { parent });
    expect(child.parent).toBe("checkout");
  });

  it("accepts null parent", () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { parent: null });
    expect(cfg.parent).toBeNull();
  });

  it("defaults description and parent to null", () => {
    const client = makeClient();
    const cfg = client.config.new("checkout");
    expect(cfg.description).toBeNull();
    expect(cfg.parent).toBeNull();
  });

  it("starts with empty items and environments", () => {
    const client = makeClient();
    const cfg = client.config.new("checkout");
    expect(cfg.items).toEqual({});
    expect(cfg.environments).toEqual({});
  });
});

// ===========================================================================
// list()
// ===========================================================================

describe("ManagementConfigClient.list()", () => {
  it("returns an array of Configs", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_CONFIG] }));

    const configs = await client.config.list();
    expect(configs).toHaveLength(1);
    expect(configs[0]).toBeInstanceOf(Config);
    expect(configs[0].id).toBe("checkout");
    expect(configs[0].name).toBe("Checkout");
    expect(configs[0].items).toEqual({ timeout: 30, currency: "USD" });
  });

  it("returns empty array when no data field", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const configs = await client.config.list();
    expect(configs).toEqual([]);
  });

  it("issues GET to /api/v1/configs", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.config.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/configs");
  });

  it("throws SmplConnectionError on network failure (TypeError)", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.config.list()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplConnectionError on generic error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("kaboom"));
    await expect(client.config.list()).rejects.toThrow(SmplConnectionError);
  });

  it("wraps non-Error rejections", async () => {
    const client = makeClient();
    // Reject with a non-Error to exercise the String(err) branch.
    mockFetch.mockRejectedValueOnce("string-rejection");
    await expect(client.config.list()).rejects.toThrow(SmplConnectionError);
  });

  it("propagates SmplValidationError on 422", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Invalid", 422));
    await expect(client.config.list()).rejects.toThrow(SmplValidationError);
  });

  it("propagates SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.config.list()).rejects.toThrow(SmplNotFoundError);
  });

  it("propagates SmplConflictError on 409", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Conflict", 409));
    await expect(client.config.list()).rejects.toThrow(SmplConflictError);
  });
});

// ===========================================================================
// get()
// ===========================================================================

describe("ManagementConfigClient.get()", () => {
  it("returns a Config by id", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));

    const cfg = await client.config.get("checkout");
    expect(cfg).toBeInstanceOf(Config);
    expect(cfg.id).toBe("checkout");
    expect(cfg.name).toBe("Checkout");
    expect(cfg.description).toBe("Checkout flow config");
    expect(cfg.createdAt).toBe("2026-04-01T10:00:00Z");
    expect(cfg.updatedAt).toBe("2026-04-02T10:00:00Z");
  });

  it("populates items from response", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");
    expect(cfg.items).toEqual({ timeout: 30, currency: "USD" });
  });

  it("populates environments from response", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");
    const prod = cfg.environments.production;
    expect(prod).toBeInstanceOf(ConfigEnvironment);
    expect(prod.values).toEqual({ timeout: 60 });
  });

  it("issues GET to /api/v1/configs/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    await client.config.get("checkout");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/configs/checkout");
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.config.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplNotFoundError when response body is empty", async () => {
    const client = makeClient();
    // 200 OK but no data field → resourceToConfig short-circuits to NotFound.
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(client.config.get("checkout")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.config.get("checkout")).rejects.toThrow(SmplConnectionError);
  });
});

// ===========================================================================
// delete()
// ===========================================================================

describe("ManagementConfigClient.delete()", () => {
  it("resolves on 204", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.config.delete("checkout")).resolves.toBeUndefined();
  });

  it("resolves on 200", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(client.config.delete("checkout")).resolves.toBeUndefined();
  });

  it("issues DELETE to /api/v1/configs/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.config.delete("checkout");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/api/v1/configs/checkout");
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.config.delete("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.config.delete("checkout")).rejects.toThrow(SmplConnectionError);
  });

  it("Config.delete() routes through the client", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(cfg.delete()).resolves.toBeUndefined();
    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/api/v1/configs/checkout");
  });
});

// ===========================================================================
// Config.save() — create flow
// ===========================================================================

describe("Config.save() — create (createdAt === null)", () => {
  it("POSTs to /api/v1/configs", async () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { name: "Checkout" });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    await cfg.save();

    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v1/configs");
  });

  it("sends JSON:API body with id, type, and attributes", async () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", {
      name: "Checkout",
      description: "Checkout flow",
      parent: "parent-cfg",
    });
    cfg.setString("currency", "USD");
    cfg.setNumber("timeout", 30, { environment: "production" });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    await cfg.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.type).toBe("config");
    expect(body.data.id).toBe("checkout");
    expect(body.data.attributes.name).toBe("Checkout");
    expect(body.data.attributes.description).toBe("Checkout flow");
    expect(body.data.attributes.parent).toBe("parent-cfg");
    expect(body.data.attributes.items).toEqual({
      currency: { value: "USD", type: ItemType.STRING },
    });
    expect(body.data.attributes.environments).toEqual({
      production: { values: { timeout: { value: 30, type: ItemType.NUMBER } } },
    });
  });

  it("omits null description and parent from the body", async () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { name: "Checkout" });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    await cfg.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.description).toBeUndefined();
    expect(body.data.attributes.parent).toBeUndefined();
  });

  it("applies response fields after creation", async () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { name: "Checkout" });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    await cfg.save();

    expect(cfg.id).toBe("checkout");
    expect(cfg.createdAt).toBe("2026-04-01T10:00:00Z");
    expect(cfg.updatedAt).toBe("2026-04-02T10:00:00Z");
  });

  it("throws SmplValidationError when server returns no data", async () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { name: "Checkout" });

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(cfg.save()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplValidationError on 422 during create", async () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { name: "Checkout" });

    mockFetch.mockResolvedValueOnce(textResponse("Invalid", 422));
    await expect(cfg.save()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplConnectionError on network failure during create", async () => {
    const client = makeClient();
    const cfg = client.config.new("checkout", { name: "Checkout" });

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(cfg.save()).rejects.toThrow(SmplConnectionError);
  });
});

// ===========================================================================
// Config.save() — update flow
// ===========================================================================

describe("Config.save() — update (createdAt set)", () => {
  it("PUTs to /api/v1/configs/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");
    cfg.name = "Checkout V2";

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    await cfg.save();

    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("/api/v1/configs/checkout");
  });

  it("sends updated body shape", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");
    cfg.name = "Checkout V2";
    cfg.setBoolean("ff-active", true);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    await cfg.save();

    const req: Request = mockFetch.mock.calls[1][0];
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.name).toBe("Checkout V2");
    expect(body.data.attributes.items["ff-active"]).toEqual({
      value: true,
      type: ItemType.BOOLEAN,
    });
  });

  it("throws SmplConnectionError on network failure during update", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(cfg.save()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplValidationError on empty response body during update", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(cfg.save()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplNotFoundError on 404 during update", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const cfg = await client.config.get("checkout");

    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(cfg.save()).rejects.toThrow(SmplNotFoundError);
  });
});

// ===========================================================================
// _fetchConfig (parent chain resolution)
// ===========================================================================

describe("_fetchConfig — parent chain resolution", () => {
  it("Config._buildChain resolves parent via _fetchConfig", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CHILD_CONFIG }));
    const child = await client.config.get("checkout-child");

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    const chain = await child._buildChain();

    expect(chain).toHaveLength(2);
    expect(chain[0].id).toBe("checkout-child");
    expect(chain[1].id).toBe("checkout");

    // Second mockFetch call is the parent fetch.
    const parentReq: Request = mockFetch.mock.calls[1][0];
    expect(parentReq.url).toContain("/api/v1/configs/checkout");
  });

  it("_fetchConfig is a thin wrapper over get()", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONFIG }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = await (client.config as any)._fetchConfig("checkout");
    expect(cfg).toBeInstanceOf(Config);
    expect(cfg.id).toBe("checkout");
  });
});

// ===========================================================================
// _updateConfig — guard against null id
// ===========================================================================

describe("_updateConfig() guard", () => {
  it("throws when called on a Config with no id", async () => {
    const client = makeClient();
    const cfg = new Config(client.config, {
      id: null,
      name: "x",
      description: null,
      parent: null,
      items: null,
      environments: null,
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client.config as any)._updateConfig(cfg)).rejects.toThrow(
      "Cannot update a Config with no id",
    );
  });
});
