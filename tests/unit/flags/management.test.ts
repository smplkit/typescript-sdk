import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagsClient } from "../../../src/flags/client.js";
import { Flag, BooleanFlag, StringFlag, NumberFlag, JsonFlag } from "../../../src/flags/models.js";
import {
  SmplError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
  SmplConnectionError,
} from "../../../src/errors.js";

// Mock global fetch — openapi-fetch calls fetch(request: Request)
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
  connectionStatus: string;
  _listeners: Record<string, WsCallback[]>;
  _emit: (event: string, data: Record<string, unknown>) => void;
}

function createMockSharedWs(): MockSharedWs {
  const listeners: Record<string, WsCallback[]> = {};
  return {
    on: vi.fn((event: string, cb: WsCallback) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    off: vi.fn((event: string, cb: WsCallback) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== cb);
      }
    }),
    connectionStatus: "connected",
    _listeners: listeners,
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
  };
}

let lastMockWs: MockSharedWs;

function makeFlagsClient(): FlagsClient {
  lastMockWs = createMockSharedWs();
  return new FlagsClient(API_KEY, () => lastMockWs as never, 30000);
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

const FLAG_RESOURCE = {
  id: "my-flag",
  type: "flag",
  attributes: {
    name: "My Flag",
    type: "BOOLEAN",
    default: false,
    values: [
      { name: "True", value: true },
      { name: "False", value: false },
    ],
    description: "A test flag",
    environments: {},
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
};

// ---------------------------------------------------------------------------
// Factory methods (newXxxFlag)
// ---------------------------------------------------------------------------

describe("FlagsClient factory methods", () => {
  describe("newBooleanFlag", () => {
    it("should return a BooleanFlag with createdAt: null", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("checkout-v2", { default: false });

      expect(flag).toBeInstanceOf(BooleanFlag);
      expect(flag.id).toBe("checkout-v2");
      expect(flag.createdAt).toBeNull();
      expect(flag.type).toBe("BOOLEAN");
      expect(flag.default).toBe(false);
    });

    it("should auto-generate name from key", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("checkout-v2", { default: true });
      expect(flag.name).toBe("Checkout V2");
    });

    it("should use custom name when provided", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("checkout-v2", {
        default: true,
        name: "Custom Name",
      });
      expect(flag.name).toBe("Custom Name");
    });

    it("should auto-generate boolean values", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("feat", { default: false });
      expect(flag.values).toEqual([
        { name: "True", value: true },
        { name: "False", value: false },
      ]);
    });

    it("should set description when provided", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("feat", {
        default: false,
        description: "A feature",
      });
      expect(flag.description).toBe("A feature");
    });

    it("should default description to null", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("feat", { default: false });
      expect(flag.description).toBeNull();
    });

    it("should have empty environments", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("feat", { default: false });
      expect(flag.environments).toEqual({});
    });

    it("should have null timestamps", () => {
      const client = makeFlagsClient();
      const flag = client.management.newBooleanFlag("feat", { default: false });
      expect(flag.createdAt).toBeNull();
      expect(flag.updatedAt).toBeNull();
    });
  });

  describe("newStringFlag", () => {
    it("should return a StringFlag with createdAt: null", () => {
      const client = makeFlagsClient();
      const flag = client.management.newStringFlag("banner-color", { default: "red" });

      expect(flag).toBeInstanceOf(StringFlag);
      expect(flag.id).toBe("banner-color");
      expect(flag.createdAt).toBeNull();
      expect(flag.type).toBe("STRING");
      expect(flag.default).toBe("red");
    });

    it("should auto-generate name from key", () => {
      const client = makeFlagsClient();
      const flag = client.management.newStringFlag("banner-color", { default: "red" });
      expect(flag.name).toBe("Banner Color");
    });

    it("should accept custom values", () => {
      const client = makeFlagsClient();
      const flag = client.management.newStringFlag("color", {
        default: "red",
        values: [
          { name: "Red", value: "red" },
          { name: "Blue", value: "blue" },
        ],
      });
      expect(flag.values).toEqual([
        { name: "Red", value: "red" },
        { name: "Blue", value: "blue" },
      ]);
    });

    it("should default to null values (unconstrained)", () => {
      const client = makeFlagsClient();
      const flag = client.management.newStringFlag("color", { default: "red" });
      expect(flag.values).toBeNull();
    });
  });

  describe("newNumberFlag", () => {
    it("should return a NumberFlag with createdAt: null", () => {
      const client = makeFlagsClient();
      const flag = client.management.newNumberFlag("max-retries", { default: 3 });

      expect(flag).toBeInstanceOf(NumberFlag);
      expect(flag.id).toBe("max-retries");
      expect(flag.createdAt).toBeNull();
      expect(flag.type).toBe("NUMERIC");
      expect(flag.default).toBe(3);
    });

    it("should auto-generate name from key with underscores", () => {
      const client = makeFlagsClient();
      const flag = client.management.newNumberFlag("max_retries", { default: 5 });
      expect(flag.name).toBe("Max Retries");
    });

    it("should accept custom values", () => {
      const client = makeFlagsClient();
      const flag = client.management.newNumberFlag("retries", {
        default: 3,
        values: [
          { name: "Low", value: 1 },
          { name: "High", value: 10 },
        ],
      });
      expect(flag.values).toHaveLength(2);
    });
  });

  describe("newJsonFlag", () => {
    it("should return a JsonFlag with createdAt: null", () => {
      const client = makeFlagsClient();
      const defaultVal = { mode: "dark", accent: "#fff" };
      const flag = client.management.newJsonFlag("theme-config", { default: defaultVal });

      expect(flag).toBeInstanceOf(JsonFlag);
      expect(flag.id).toBe("theme-config");
      expect(flag.createdAt).toBeNull();
      expect(flag.type).toBe("JSON");
      expect(flag.default).toEqual(defaultVal);
    });

    it("should auto-generate name from key", () => {
      const client = makeFlagsClient();
      const flag = client.management.newJsonFlag("theme-config", { default: {} });
      expect(flag.name).toBe("Theme Config");
    });

    it("should accept custom values", () => {
      const client = makeFlagsClient();
      const flag = client.management.newJsonFlag("theme", {
        default: {},
        values: [{ name: "Dark", value: { mode: "dark" } }],
      });
      expect(flag.values).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Flag.save()
// ---------------------------------------------------------------------------

describe("Flag.save()", () => {
  it("should POST when createdAt is null (new flag)", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("checkout-v2", { default: false });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "checkout-v2",
          type: "flag",
          attributes: {
            name: "Checkout V2",
            type: "BOOLEAN",
            default: false,
            values: [
              { name: "True", value: true },
              { name: "False", value: false },
            ],
            description: "",
            environments: {},
            created_at: "2024-06-01T00:00:00Z",
            updated_at: "2024-06-01T00:00:00Z",
          },
        },
      }),
    );

    await flag.save();

    // Verify POST was used
    const request: Request = mockFetch.mock.calls[0][0];
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/api/v1/flags");
    expect(request.url).not.toContain("/api/v1/flags/");

    // Verify body structure
    const body = JSON.parse(await mockFetch.mock.calls[0][0].clone().text());
    expect(body.data.type).toBe("flag");
    expect(body.data.id).toBe("checkout-v2");
    expect(body.data.attributes.name).toBe("Checkout V2");
    expect(body.data.attributes.type).toBe("BOOLEAN");
    expect(body.data.attributes.values).toEqual([
      { name: "True", value: true },
      { name: "False", value: false },
    ]);
  });

  it("should PUT when createdAt is set (existing flag)", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("checkout-v2", { default: false });

    // Simulate a previously-saved flag by assigning createdAt
    flag.createdAt = "2024-01-01T00:00:00Z";

    const updatedResource = {
      id: "checkout-v2",
      type: "flag",
      attributes: {
        ...FLAG_RESOURCE.attributes,
        default: false,
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: updatedResource }));

    await flag.save();

    const request: Request = mockFetch.mock.calls[0][0];
    expect(request.method).toBe("PUT");
    expect(request.url).toContain("/api/v1/flags/checkout-v2");
  });

  it("should update the instance in-place via _apply after POST", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("new-flag", { default: true });
    expect(flag.id).toBe("new-flag");
    expect(flag.createdAt).toBeNull();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "new-flag",
          type: "flag",
          attributes: {
            name: "New Flag",
            type: "BOOLEAN",
            default: true,
            values: [
              { name: "True", value: true },
              { name: "False", value: false },
            ],
            description: "",
            environments: {},
            created_at: "2024-06-01T12:00:00Z",
            updated_at: "2024-06-01T12:00:00Z",
          },
        },
      }),
    );

    await flag.save();

    expect(flag.id).toBe("new-flag");
    expect(flag.createdAt).toBe("2024-06-01T12:00:00Z");
    expect(flag.updatedAt).toBe("2024-06-01T12:00:00Z");
  });

  it("should update the instance in-place via _apply after PUT", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("existing", { default: false });
    flag.createdAt = "2024-01-01T00:00:00Z"; // mark as existing
    flag.default = true; // local mutation

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "existing",
          type: "flag",
          attributes: {
            name: "Existing",
            type: "BOOLEAN",
            default: true,
            values: [
              { name: "True", value: true },
              { name: "False", value: false },
            ],
            description: "",
            environments: {},
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-06-15T00:00:00Z",
          },
        },
      }),
    );

    await flag.save();

    expect(flag.default).toBe(true);
    expect(flag.updatedAt).toBe("2024-06-15T00:00:00Z");
  });

  it("should include environments in POST body when present", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("feat", { default: false });
    flag.setEnvironmentEnabled("staging", true);

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "feat",
          type: "flag",
          attributes: {
            name: "Feat",
            type: "BOOLEAN",
            default: false,
            values: [
              { name: "True", value: true },
              { name: "False", value: false },
            ],
            description: "",
            environments: { staging: { enabled: true, rules: [] } },
            created_at: "2024-06-01T00:00:00Z",
            updated_at: "2024-06-01T00:00:00Z",
          },
        },
      }),
    );

    await flag.save();

    const body = JSON.parse(await mockFetch.mock.calls[0][0].clone().text());
    expect(body.data.attributes.environments).toEqual({
      staging: { enabled: true, rules: [] },
    });
  });

  it("should omit environments from body when empty", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("feat", { default: false });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "feat",
          type: "flag",
          attributes: {
            ...FLAG_RESOURCE.attributes,
          },
        },
      }),
    );

    await flag.save();

    const body = JSON.parse(await mockFetch.mock.calls[0][0].clone().text());
    expect(body.data.attributes).not.toHaveProperty("environments");
  });
});

// ---------------------------------------------------------------------------
// Flag local mutations (sync)
// ---------------------------------------------------------------------------

describe("Flag local mutations", () => {
  function makeFlag(overrides?: Partial<ConstructorParameters<typeof Flag>[1]>): Flag {
    const client = makeFlagsClient();
    return new Flag(client, {
      id: "my-flag",
      name: "My Flag",
      type: "BOOLEAN",
      default: false,
      values: [
        { name: "True", value: true },
        { name: "False", value: false },
      ],
      description: "test",
      environments: {},
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      ...overrides,
    });
  }

  describe("addRule", () => {
    it("should be synchronous and return this for chaining", () => {
      const flag = makeFlag();
      const result = flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: { "==": [{ var: "user.plan" }, "enterprise"] },
        value: true,
      });
      expect(result).toBe(flag);
    });

    it("should mutate environments locally", () => {
      const flag = makeFlag();
      flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: { "==": [{ var: "user.plan" }, "enterprise"] },
        value: true,
      });

      expect(flag.environments.staging).toBeDefined();
      expect(flag.environments.staging.rules).toHaveLength(1);
      expect(flag.environments.staging.rules[0].description).toBe("rule 1");
    });

    it("should append to existing rules", () => {
      const flag = makeFlag({
        environments: {
          staging: {
            enabled: true,
            rules: [{ description: "existing", logic: {}, value: true }],
          },
        },
      });

      flag.addRule({
        environment: "staging",
        description: "rule 2",
        logic: { "==": [{ var: "user.plan" }, "free"] },
        value: false,
      });

      expect(flag.environments.staging.rules).toHaveLength(2);
      expect(flag.environments.staging.rules[0].description).toBe("existing");
      expect(flag.environments.staging.rules[1].description).toBe("rule 2");
    });

    it("should strip the environment key from the stored rule", () => {
      const flag = makeFlag();
      flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: {},
        value: true,
      });

      const storedRule = flag.environments.staging.rules[0];
      expect(storedRule).not.toHaveProperty("environment");
    });

    it("should throw if built rule has no environment key", () => {
      const flag = makeFlag();
      expect(() => flag.addRule({ description: "no env", logic: {}, value: true })).toThrow(
        "Built rule must include 'environment' key",
      );
    });

    it("should create environment with enabled: true when environment does not exist", () => {
      const flag = makeFlag();
      flag.addRule({
        environment: "production",
        description: "rule 1",
        logic: {},
        value: true,
      });
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("should support chaining multiple addRule calls", () => {
      const flag = makeFlag();
      flag
        .addRule({
          environment: "staging",
          description: "rule 1",
          logic: { "==": [{ var: "user.plan" }, "enterprise"] },
          value: true,
        })
        .addRule({
          environment: "staging",
          description: "rule 2",
          logic: { "==": [{ var: "user.plan" }, "pro"] },
          value: true,
        });

      expect(flag.environments.staging.rules).toHaveLength(2);
    });
  });

  describe("setEnvironmentEnabled", () => {
    it("should enable an environment", () => {
      const flag = makeFlag();
      flag.setEnvironmentEnabled("staging", true);
      expect(flag.environments.staging.enabled).toBe(true);
    });

    it("should disable an environment", () => {
      const flag = makeFlag({
        environments: { staging: { enabled: true, rules: [] } },
      });
      flag.setEnvironmentEnabled("staging", false);
      expect(flag.environments.staging.enabled).toBe(false);
    });

    it("should create environment if it does not exist", () => {
      const flag = makeFlag();
      flag.setEnvironmentEnabled("production", true);
      expect(flag.environments.production).toBeDefined();
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("should preserve existing rules when toggling", () => {
      const flag = makeFlag({
        environments: {
          staging: {
            enabled: true,
            rules: [{ description: "r1", logic: {}, value: true }],
          },
        },
      });
      flag.setEnvironmentEnabled("staging", false);
      expect(flag.environments.staging.rules).toHaveLength(1);
      expect(flag.environments.staging.enabled).toBe(false);
    });
  });

  describe("setEnvironmentDefault", () => {
    it("should set the default value for an environment", () => {
      const flag = makeFlag();
      flag.setEnvironmentDefault("staging", true);
      expect(flag.environments.staging.default).toBe(true);
    });

    it("should create environment if it does not exist", () => {
      const flag = makeFlag();
      flag.setEnvironmentDefault("production", "blue");
      expect(flag.environments.production).toBeDefined();
      expect(flag.environments.production.default).toBe("blue");
    });

    it("should update existing environment default", () => {
      const flag = makeFlag({
        environments: { staging: { enabled: true, default: "red", rules: [] } },
      });
      flag.setEnvironmentDefault("staging", "green");
      expect(flag.environments.staging.default).toBe("green");
    });
  });

  describe("clearRules", () => {
    it("should clear rules for a specific environment", () => {
      const flag = makeFlag({
        environments: {
          staging: {
            enabled: true,
            rules: [
              { description: "r1", logic: {}, value: true },
              { description: "r2", logic: {}, value: false },
            ],
          },
        },
      });

      flag.clearRules("staging");
      expect(flag.environments.staging.rules).toEqual([]);
    });

    it("should preserve the enabled state", () => {
      const flag = makeFlag({
        environments: {
          staging: {
            enabled: true,
            rules: [{ description: "r1", logic: {}, value: true }],
          },
        },
      });

      flag.clearRules("staging");
      expect(flag.environments.staging.enabled).toBe(true);
    });

    it("should be a no-op for a non-existent environment", () => {
      const flag = makeFlag();
      // Should not throw
      flag.clearRules("nonexistent");
      expect(flag.environments).toEqual({});
    });

    it("should not affect other environments", () => {
      const flag = makeFlag({
        environments: {
          staging: {
            enabled: true,
            rules: [{ description: "s1", logic: {}, value: true }],
          },
          production: {
            enabled: true,
            rules: [{ description: "p1", logic: {}, value: false }],
          },
        },
      });

      flag.clearRules("staging");
      expect(flag.environments.staging.rules).toEqual([]);
      expect(flag.environments.production.rules).toHaveLength(1);
    });
  });

  describe("toString", () => {
    it("should produce a readable string", () => {
      const flag = makeFlag();
      expect(flag.toString()).toBe("Flag(id=my-flag, type=BOOLEAN, default=false)");
    });
  });

  describe("_apply", () => {
    it("should copy all fields from another Flag instance", () => {
      const client = makeFlagsClient();
      const flag = new Flag(client, {
        id: "a",
        name: "A",
        type: "BOOLEAN",
        default: false,
        values: [],
        description: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      const other = new Flag(client, {
        id: "a",
        name: "Updated A",
        type: "BOOLEAN",
        default: true,
        values: [{ name: "T", value: true }],
        description: "Updated",
        environments: { staging: { enabled: true, rules: [] } },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
      });

      flag._apply(other);

      expect(flag.id).toBe("a");
      expect(flag.name).toBe("Updated A");
      expect(flag.default).toBe(true);
      expect(flag.values).toHaveLength(1);
      expect(flag.description).toBe("Updated");
      expect(flag.environments).toHaveProperty("staging");
      expect(flag.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(flag.updatedAt).toBe("2024-06-01T00:00:00Z");
    });
  });
});

// ---------------------------------------------------------------------------
// FlagsClient.get()
// ---------------------------------------------------------------------------

describe("FlagsClient.get()", () => {
  it("should fetch a flag by id using GET /api/v1/flags/{id}", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));

    const flag = await client.management.get("my-flag");
    expect(flag.id).toBe("my-flag");

    // Verify direct GET by id
    const request: Request = mockFetch.mock.calls[0][0];
    expect(request.url).toContain("/api/v1/flags/my-flag");
  });

  it("should return a Flag model from the response", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));

    const flag = await client.management.get("my-flag");
    expect(flag).toBeInstanceOf(Flag);
    expect(flag.name).toBe("My Flag");
    expect(flag.type).toBe("BOOLEAN");
    expect(flag.default).toBe(false);
    expect(flag.description).toBe("A test flag");
  });

  it("should throw SmplNotFoundError on 404", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));

    await expect(client.management.get("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should throw SmplConnectionError on network error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client.management.get("x")).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplNotFoundError when response has no data", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await expect(client.management.get("my-flag")).rejects.toThrow(SmplNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// FlagsClient.list()
// ---------------------------------------------------------------------------

describe("FlagsClient.list()", () => {
  it("should list flags as Flag[] instances", async () => {
    const client = makeFlagsClient();
    const secondResource = {
      ...FLAG_RESOURCE,
      id: "other-flag",
      attributes: { ...FLAG_RESOURCE.attributes, name: "Other Flag" },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [FLAG_RESOURCE, secondResource] }));

    const flags = await client.management.list();
    expect(flags).toHaveLength(2);
    expect(flags[0]).toBeInstanceOf(Flag);
    expect(flags[1]).toBeInstanceOf(Flag);
    expect(flags[0].id).toBe("my-flag");
    expect(flags[1].id).toBe("other-flag");
  });

  it("should return empty array when no flags exist", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const flags = await client.management.list();
    expect(flags).toEqual([]);
  });

  it("should throw SmplConnectionError on network error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client.management.list()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplError on server error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(textResponse("Internal Server Error", 500));

    await expect(client.management.list()).rejects.toThrow(SmplError);
  });
});

// ---------------------------------------------------------------------------
// FlagsClient.delete()
// ---------------------------------------------------------------------------

describe("FlagsClient.delete()", () => {
  it("should DELETE by id directly", async () => {
    const client = makeFlagsClient();

    // DELETE /api/v1/flags/my-flag
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await client.management.delete("my-flag");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const deleteRequest: Request = mockFetch.mock.calls[0][0];
    expect(deleteRequest.method).toBe("DELETE");
    expect(deleteRequest.url).toContain("/api/v1/flags/my-flag");
  });

  it("should throw SmplNotFoundError on 404", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));

    await expect(client.management.delete("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should throw on DELETE error", async () => {
    const client = makeFlagsClient();
    // DELETE fails
    mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

    await expect(client.management.delete("my-flag")).rejects.toThrow(SmplError);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("should throw SmplValidationError on 422", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("bad", { default: false });

    mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

    await expect(flag.save()).rejects.toThrow(SmplValidationError);
  });

  it("should throw SmplConflictError on 409", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("dup", { default: false });

    mockFetch.mockResolvedValueOnce(textResponse("Conflict", 409));

    await expect(flag.save()).rejects.toThrow(SmplConflictError);
  });

  it("should throw SmplNotFoundError on 404", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("missing", { default: false });
    flag.createdAt = "2024-01-01T00:00:00Z"; // mark as existing for PUT path

    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));

    await expect(flag.save()).rejects.toThrow(SmplNotFoundError);
  });

  it("should throw SmplConnectionError on network error (TypeError)", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("x", { default: false });

    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(flag.save()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplError on 500 server error", async () => {
    const client = makeFlagsClient();
    const flag = client.management.newBooleanFlag("x", { default: false });

    mockFetch.mockResolvedValueOnce(textResponse("Internal Server Error", 500));

    await expect(flag.save()).rejects.toThrow(SmplError);
  });

  it("should throw SmplTimeoutError when fetch is aborted", async () => {
    const { SmplTimeoutError } = await import("../../../src/errors.js");
    lastMockWs = createMockSharedWs();
    const client = new FlagsClient(API_KEY, () => lastMockWs as never, 1);

    mockFetch.mockImplementationOnce(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = request.signal;
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );

    await expect(client.management.list()).rejects.toThrow(SmplTimeoutError);
  });

  it("should re-throw SDK errors without wrapping", async () => {
    const client = makeFlagsClient();
    // A 422 response creates SmplValidationError via checkError, which passes through wrapFetchError
    mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

    await expect(client.management.list()).rejects.toThrow(SmplValidationError);
  });
});

// ---------------------------------------------------------------------------
// FlagsClient runtime helpers
// ---------------------------------------------------------------------------

describe("FlagsClient runtime", () => {
  it("should connect via _connectInternal and evaluate flags", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "My Flag",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: {
                staging: { enabled: true, rules: [] },
              },
            },
          },
        ],
      }),
    );

    await client._connectInternal("staging");

    const handle = client.booleanFlag("my-flag", false);
    expect(handle.get()).toBe(false);
  });

  it("should disconnect and clear state", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.disconnect();

    expect(client.connectionStatus()).toBe("disconnected");
  });

  it("should initialize idempotently", async () => {
    const client = makeFlagsClient();
    client._parent = { _environment: "staging", _service: null };

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.initialize();

    // Second call should not make another fetch
    await client.initialize();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should evaluate tier 1 without being initialized", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "color",
            type: "flag",
            attributes: {
              name: "Color",
              type: "STRING",
              default: "red",
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: "blue" }],
                },
              },
            },
          },
        ],
      }),
    );

    const result = await client.evaluate("color", {
      environment: "staging",
      context: [new Context("user", "u-1", { plan: "enterprise" })],
    });
    expect(result).toBe("blue");
  });

  it("should return null for unknown flag in evaluate", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await client.evaluate("nonexistent", {
      environment: "staging",
      context: [new Context("user", "u-1")],
    });
    expect(result).toBeNull();
  });

  it("should use local store for tier 1 evaluate when initialized", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "color",
            type: "flag",
            attributes: {
              name: "Color",
              type: "STRING",
              default: "red",
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: "blue" }],
                },
              },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    const result = await client.evaluate("color", {
      environment: "staging",
      context: [new Context("user", "u-1", { plan: "enterprise" })],
    });
    expect(result).toBe("blue");

    // Only 1 fetch (for _connectInternal), not 2
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should auto-inject service context in evaluate()", async () => {
    const client = makeFlagsClient();
    client._parent = { _environment: "staging", _service: "my-svc" };

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "svc-flag",
            type: "flag",
            attributes: {
              name: "Service Flag",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [{ logic: { "==": [{ var: "service.key" }, "my-svc"] }, value: true }],
                },
              },
            },
          },
        ],
      }),
    );

    const result = await client.evaluate("svc-flag", {
      environment: "staging",
      context: [],
    });
    expect(result).toBe(true);
  });

  it("should refresh and fire listeners", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: {},
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    const changes: string[] = [];
    client.onChange((e) => changes.push(e.id));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: true,
              values: [],
              environments: {},
            },
          },
        ],
      }),
    );
    await client.refresh();

    expect(changes).toContain("my-flag");
  });

  it("should return WS connectionStatus when connected", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    expect(client.connectionStatus()).toBe("connected");
  });

  it("should support contextProvider decorator-style alias", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    const fn = client.contextProvider(() => [new Context("user", "u-1", { plan: "free" })]);
    expect(fn).toBeTypeOf("function");
    expect(fn()).toHaveLength(1);
  });

  it("should return code default when flag evaluates to null", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "null-flag",
            type: "flag",
            attributes: {
              name: "NF",
              type: "STRING",
              default: null,
              values: [],
              environments: {
                staging: { enabled: true, rules: [] },
              },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    const handle = client.stringFlag("null-flag", "fallback");
    expect(handle.get()).toBe("fallback");
  });

  it("should handle _fetchFlagsList error via wrapFetchError", async () => {
    const client = makeFlagsClient();

    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client._connectInternal("staging")).rejects.toThrow(SmplConnectionError);
  });

  it("should auto-flush context buffer when it reaches batch size", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");
    // Access internal buffer to pre-fill it (register() moved to management.contexts)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: { staging: { enabled: true, rules: [] } },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    for (let i = 0; i < 100; i++) {
      buffer.observe([new Context("user", `u-${i}`, { plan: "free" })]);
    }

    client.setContextProvider(() => [new Context("user", "u-trigger", { plan: "enterprise" })]);

    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const handle = client.booleanFlag("my-flag", false);
    handle.get();

    await new Promise((r) => setTimeout(r, 10));
  });

  it("should silently swallow errors from auto-flush context POST", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: { staging: { enabled: true, rules: [] } },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    // Fill buffer past the auto-flush threshold
    for (let i = 0; i < 100; i++) {
      buffer.observe([new Context("user", `u-${i}`, { plan: "free" })]);
    }

    client.setContextProvider(() => [new Context("user", "u-trigger", { plan: "enterprise" })]);

    // Context bulk POST will fail — should be silently swallowed
    mockFetch.mockRejectedValueOnce(new TypeError("Network error"));

    const handle = client.booleanFlag("my-flag", false);
    // Should NOT throw even though the background context flush fails
    expect(() => handle.get()).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
  });

  it("should re-throw non-abort errors from custom fetch wrapper", async () => {
    const client = makeFlagsClient();

    mockFetch.mockImplementationOnce(() => {
      throw new Error("unexpected fetch error");
    });

    await expect(client.management.list()).rejects.toThrow(SmplConnectionError);
  });
});
