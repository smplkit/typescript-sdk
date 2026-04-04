import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagsClient } from "../../../src/flags/client.js";
import { Flag, ContextType } from "../../../src/flags/models.js";
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
  id: "flag-1",
  type: "flag",
  attributes: {
    key: "my-flag",
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

describe("FlagsClient management", () => {
  describe("create", () => {
    it("should create a flag", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));

      const flag = await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
      });

      expect(flag).toBeInstanceOf(Flag);
      expect(flag.key).toBe("my-flag");
      expect(flag.id).toBe("flag-1");
      expect(flag.type).toBe("BOOLEAN");
    });

    it("should auto-generate boolean values", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));

      await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
      });

      const body = JSON.parse(await mockFetch.mock.calls[0][0].text());
      expect(body.data.attributes.values).toEqual([
        { name: "True", value: true },
        { name: "False", value: false },
      ]);
    });

    it("should pass custom values for string flags", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            ...FLAG_RESOURCE,
            attributes: {
              ...FLAG_RESOURCE.attributes,
              type: "STRING",
              default: "red",
              values: [{ name: "Red", value: "red" }],
            },
          },
        }),
      );

      await client.create("color", {
        name: "Color",
        type: "STRING",
        default: "red",
        values: [{ name: "Red", value: "red" }],
      });

      const body = JSON.parse(await mockFetch.mock.calls[0][0].text());
      expect(body.data.attributes.values).toEqual([{ name: "Red", value: "red" }]);
    });

    it("should throw SmplValidationError on 422", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

      await expect(
        client.create("bad", { name: "Bad", type: "BOOLEAN", default: false }),
      ).rejects.toThrow(SmplValidationError);
    });

    it("should throw SmplConflictError on 409", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(textResponse("Conflict", 409));

      await expect(
        client.create("dup", { name: "Dup", type: "BOOLEAN", default: false }),
      ).rejects.toThrow(SmplConflictError);
    });

    it("should throw SmplConnectionError on network error", async () => {
      const client = makeFlagsClient();
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(
        client.create("x", { name: "X", type: "BOOLEAN", default: false }),
      ).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplError on 500 server error", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(textResponse("Internal Server Error", 500));

      await expect(
        client.create("x", { name: "X", type: "BOOLEAN", default: false }),
      ).rejects.toThrow(SmplError);
    });
  });

  describe("get", () => {
    it("should fetch a flag by ID", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));

      const flag = await client.get("flag-1");
      expect(flag.id).toBe("flag-1");
      expect(flag.key).toBe("my-flag");
    });

    it("should throw SmplNotFoundError on 404", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));

      await expect(client.get("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  describe("list", () => {
    it("should list flags", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [FLAG_RESOURCE, FLAG_RESOURCE] }));

      const flags = await client.list();
      expect(flags).toHaveLength(2);
      expect(flags[0]).toBeInstanceOf(Flag);
    });

    it("should throw SmplConnectionError on network error", async () => {
      const client = makeFlagsClient();
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(client.list()).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("delete", () => {
    it("should delete a flag", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(client.delete("flag-1")).resolves.not.toThrow();
    });

    it("should throw on non-204 error", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));

      await expect(client.delete("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  describe("_updateFlag", () => {
    it("should PUT flag update and return updated model", async () => {
      const client = makeFlagsClient();

      // First create a flag
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));
      const flag = await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
      });

      // Now update it
      const updatedResource = {
        ...FLAG_RESOURCE,
        attributes: { ...FLAG_RESOURCE.attributes, default: true },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: updatedResource }));

      const updated = await client._updateFlag({ flag, default: true });
      expect(updated.default).toBe(true);
    });

    it("should include description when flag has one", async () => {
      const client = makeFlagsClient();

      const resource = {
        ...FLAG_RESOURCE,
        attributes: { ...FLAG_RESOURCE.attributes, description: "has desc" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));
      const flag = await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
        description: "has desc",
      });

      // Update without providing description — should use flag's existing one
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));
      await client._updateFlag({ flag, default: true });

      const body = JSON.parse(await mockFetch.mock.calls[1][0].text());
      expect(body.data.attributes.description).toBe("has desc");
    });

    it("should include environments when flag has them", async () => {
      const client = makeFlagsClient();

      const resource = {
        ...FLAG_RESOURCE,
        attributes: {
          ...FLAG_RESOURCE.attributes,
          environments: { staging: { enabled: true, rules: [] } },
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));
      const flag = await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
      });

      // Update without environments — should include flag's existing ones
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));
      await client._updateFlag({ flag, default: true });

      const body = JSON.parse(await mockFetch.mock.calls[1][0].text());
      expect(body.data.attributes.environments).toEqual({ staging: { enabled: true, rules: [] } });
    });

    it("should omit description when flag has null description and none provided", async () => {
      const client = makeFlagsClient();

      const resource = {
        ...FLAG_RESOURCE,
        attributes: { ...FLAG_RESOURCE.attributes, description: undefined },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));
      const flag = await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
      });
      // Ensure flag.description is null
      flag.description = null;

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));
      await client._updateFlag({ flag, default: true });

      const body = JSON.parse(await mockFetch.mock.calls[1][0].text());
      expect(body.data.attributes.description).toBe("");
    });

    it("should include new description when provided", async () => {
      const client = makeFlagsClient();

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));
      const flag = await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
      });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));
      await client._updateFlag({ flag, description: "new desc" });

      const body = JSON.parse(await mockFetch.mock.calls[1][0].text());
      expect(body.data.attributes.description).toBe("new desc");
    });

    it("should throw on update error", async () => {
      const client = makeFlagsClient();

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: FLAG_RESOURCE }));
      const flag = await client.create("my-flag", {
        name: "My Flag",
        type: "BOOLEAN",
        default: false,
      });

      mockFetch.mockRejectedValueOnce(new TypeError("network error"));
      await expect(client._updateFlag({ flag, default: true })).rejects.toThrow(
        SmplConnectionError,
      );
    });
  });
});

describe("Flag model", () => {
  function makeFlag(overrides?: Partial<ConstructorParameters<typeof Flag>[1]>): Flag {
    const client = makeFlagsClient();
    return new Flag(client, {
      id: "flag-1",
      key: "my-flag",
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

  it("should update via update()", async () => {
    const flag = makeFlag();
    const updatedResource = {
      ...FLAG_RESOURCE,
      attributes: { ...FLAG_RESOURCE.attributes, default: true },
    };
    // PUT response
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: updatedResource }));

    await flag.update({ default: true });
    expect(flag.default).toBe(true);
  });

  it("should addRule to an environment", async () => {
    const flag = makeFlag({
      environments: {
        staging: { enabled: true, rules: [{ description: "existing", logic: {}, value: true }] },
      },
    });

    // First call: re-fetch (GET) returns current state
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          ...FLAG_RESOURCE,
          attributes: {
            ...FLAG_RESOURCE.attributes,
            environments: {
              staging: {
                enabled: true,
                rules: [{ description: "existing", logic: {}, value: true }],
              },
            },
          },
        },
      }),
    );

    // Second call: PUT update
    const updatedResource = {
      ...FLAG_RESOURCE,
      attributes: {
        ...FLAG_RESOURCE.attributes,
        environments: {
          staging: {
            enabled: true,
            rules: [
              { description: "existing", logic: {}, value: true },
              {
                description: "new rule",
                logic: { "==": [{ var: "user.plan" }, "enterprise"] },
                value: true,
              },
            ],
          },
        },
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: updatedResource }));

    await flag.addRule({
      environment: "staging",
      description: "new rule",
      logic: { "==": [{ var: "user.plan" }, "enterprise"] },
      value: true,
    });

    expect(flag.environments.staging.rules).toHaveLength(2);
  });

  it("should throw if addRule has no environment", async () => {
    const flag = makeFlag();
    await expect(flag.addRule({ description: "no env", logic: {}, value: true })).rejects.toThrow(
      "Built rule must include 'environment' key",
    );
  });

  it("should have a toString()", () => {
    const flag = makeFlag();
    expect(flag.toString()).toBe("Flag(key=my-flag, type=BOOLEAN, default=false)");
  });
});

describe("ContextType model", () => {
  it("should construct and have a toString()", () => {
    const ct = new ContextType({
      id: "ct-1",
      key: "user",
      name: "User",
      attributes: { plan: {} },
    });
    expect(ct.key).toBe("user");
    expect(ct.toString()).toBe("ContextType(key=user, name=User)");
  });
});

describe("FlagsClient context type management", () => {
  it("should create a context type", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "ct-1",
          type: "context_type",
          attributes: { key: "user", name: "User", attributes: {} },
        },
      }),
    );

    const ct = await client.createContextType("user", { name: "User" });
    expect(ct).toBeInstanceOf(ContextType);
    expect(ct.key).toBe("user");
  });

  it("should update a context type", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "ct-1",
          type: "context_type",
          attributes: { key: "user", name: "User", attributes: { plan: {} } },
        },
      }),
    );

    const ct = await client.updateContextType("ct-1", {
      key: "user",
      name: "User",
      attributes: { plan: {} },
    });
    expect(ct.attributes).toEqual({ plan: {} });
  });

  it("should list context types", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "ct-1",
            type: "context_type",
            attributes: { key: "user", name: "User", attributes: {} },
          },
        ],
      }),
    );

    const cts = await client.listContextTypes();
    expect(cts).toHaveLength(1);
  });

  it("should delete a context type", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(client.deleteContextType("ct-1")).resolves.not.toThrow();
  });

  it("should list context instances", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: "ctx-1" }] }));

    const contexts = await client.listContexts({ contextTypeKey: "user" });
    expect(contexts).toHaveLength(1);
  });

  it("should pass filter[context_type_id] query param for listContexts", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await client.listContexts({ contextTypeKey: "user" });
    const request: Request = mockFetch.mock.calls[0][0];
    expect(request.url).toContain("filter[context_type_id]=user");
  });

  // Error paths for coverage
  it("should handle createContextType network error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.createContextType("user", { name: "User" })).rejects.toThrow(
      SmplConnectionError,
    );
  });

  it("should handle updateContextType network error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(
      client.updateContextType("ct-1", { key: "user", name: "User", attributes: {} }),
    ).rejects.toThrow(SmplConnectionError);
  });

  it("should handle listContextTypes network error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.listContextTypes()).rejects.toThrow(SmplConnectionError);
  });

  it("should handle deleteContextType network error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.deleteContextType("ct-1")).rejects.toThrow(SmplConnectionError);
  });

  it("should handle listContexts network error", async () => {
    const client = makeFlagsClient();
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(client.listContexts({ contextTypeKey: "user" })).rejects.toThrow(
      SmplConnectionError,
    );
  });
});

describe("FlagsClient runtime", () => {
  it("should connect and evaluate flags", async () => {
    const client = makeFlagsClient();

    // Mock the GET /api/v1/flags for connect()
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "flag-1",
            type: "flag",
            attributes: {
              key: "my-flag",
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
    // connectionStatus delegates to the mock WS which returns "disconnected"
    // The important thing is that connect() doesn't throw

    const handle = client.boolFlag("my-flag", false);
    expect(handle.get()).toBe(false);
  });

  it("should disconnect and clear state", async () => {
    const client = makeFlagsClient();

    // connect
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    // disconnect (flushContexts may call fetch)
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.disconnect();

    expect(client.connectionStatus()).toBe("disconnected");
  });

  it("should refresh and fire listeners", async () => {
    const client = makeFlagsClient();

    // connect
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "my-flag",
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
    client.onChange((e) => changes.push(e.key));

    // refresh
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "my-flag",
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

  it("should register global and flag-specific listeners", async () => {
    const client = makeFlagsClient();
    const events: string[] = [];

    client.onChange((e) => events.push(`global:${e.key}`));
    client.onChangeAny((e) => events.push(`any:${e.key}`));

    const handle = client.boolFlag("test-flag", false);
    handle.onChange((e) => events.push(`flag:${e.key}`));

    // connect with the flag in store
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "test-flag",
              name: "T",
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

    // refresh to fire listeners
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "test-flag",
              name: "T",
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

    expect(events).toContain("global:test-flag");
    expect(events).toContain("any:test-flag");
    expect(events).toContain("flag:test-flag");
  });

  it("should evaluate tier 1 (not connected)", async () => {
    const client = makeFlagsClient();

    // evaluate() fetches flags since not connected
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "color",
              name: "Color",
              type: "STRING",
              default: "red",
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [
                    {
                      logic: { "==": [{ var: "user.plan" }, "enterprise"] },
                      value: "blue",
                    },
                  ],
                },
              },
            },
          },
        ],
      }),
    );

    const { Context } = await import("../../../src/flags/types.js");
    const result = await client.evaluate("color", {
      environment: "staging",
      context: [new Context("user", "u-1", { plan: "enterprise" })],
    });
    expect(result).toBe("blue");
  });

  it("should return null for unknown flag in evaluate", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const { Context } = await import("../../../src/flags/types.js");
    const result = await client.evaluate("nonexistent", {
      environment: "staging",
      context: [new Context("user", "u-1")],
    });
    expect(result).toBeNull();
  });

  it("should flush contexts to server", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    client.register(new Context("user", "u-1", { plan: "enterprise" }));

    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.flushContexts();

    // Verify POST was called
    expect(mockFetch).toHaveBeenCalled();
  });

  it("should not flush when no pending contexts", async () => {
    const client = makeFlagsClient();
    await client.flushContexts();
    // No fetch calls for empty batch
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should swallow errors from change listeners", async () => {
    const client = makeFlagsClient();

    // Register a listener that throws
    client.onChange(() => {
      throw new Error("listener error");
    });

    // Register a flag handle with a listener that throws
    const handle = client.boolFlag("test-flag", false);
    handle.onChange(() => {
      throw new Error("handle listener error");
    });

    // connect
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "test-flag",
              name: "T",
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

    // refresh triggers listeners — should not throw
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "test-flag",
              name: "T",
              type: "BOOLEAN",
              default: true,
              values: [],
              environments: {},
            },
          },
        ],
      }),
    );
    await expect(client.refresh()).resolves.not.toThrow();
  });

  it("should swallow errors from context flush", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    client.register(new Context("user", "u-1", { plan: "enterprise" }));

    // Make flush fail
    mockFetch.mockRejectedValueOnce(new Error("network error"));
    await expect(client.flushContexts()).resolves.not.toThrow();
  });

  it("should handle flag_changed WebSocket events", async () => {
    const client = makeFlagsClient();

    // connect
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "my-flag",
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
    client.onChange((e) => changes.push(e.key));

    // Simulate flag_changed WS event — the handler re-fetches flags
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "my-flag",
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

    lastMockWs._emit("flag_changed", { key: "my-flag" });

    // Wait for async handler to complete
    await vi.waitFor(() => expect(changes).toContain("my-flag"));
  });

  it("should handle flag_deleted WebSocket events", async () => {
    const client = makeFlagsClient();

    // connect
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "del-flag",
              name: "D",
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
    client.onChange((e) => changes.push(e.key));

    // Simulate flag_deleted WS event
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    lastMockWs._emit("flag_deleted", { key: "del-flag" });

    await vi.waitFor(() => expect(changes).toContain("del-flag"));
  });

  it("should handle _fetchFlagsList error via wrapFetchError", async () => {
    const client = makeFlagsClient();

    // Make the GET /api/v1/flags fail with a network error
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client._connectInternal("staging")).rejects.toThrow(SmplConnectionError);
  });

  it("should auto-flush context buffer when it reaches batch size", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    // connect
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "my-flag",
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

    // Register many contexts to exceed CONTEXT_BATCH_FLUSH_SIZE (100)
    for (let i = 0; i < 100; i++) {
      client.register(new Context("user", `u-${i}`, { plan: "free" }));
    }

    // Set up a provider that adds one more context
    client.setContextProvider(() => [new Context("user", "u-trigger", { plan: "enterprise" })]);

    // Mock the flush PUT call
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    // This get() call triggers the provider which will push past the batch limit
    const handle = client.boolFlag("my-flag", false);
    handle.get();

    // Give the fire-and-forget flush a moment
    await new Promise((r) => setTimeout(r, 10));
  });

  it("should support contextProvider decorator-style alias", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    const fn = client.contextProvider(() => [new Context("user", "u-1", { plan: "free" })]);
    expect(fn).toBeTypeOf("function");
    // Provider is now registered
    expect(fn()).toHaveLength(1);
  });

  it("should return WS connectionStatus when connected", async () => {
    const client = makeFlagsClient();

    // connect
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    // lastMockWs has connectionStatus: "connected"
    expect(client.connectionStatus()).toBe("connected");
  });

  it("should use local store for tier 1 evaluate when connected", async () => {
    const client = makeFlagsClient();
    const { Context } = await import("../../../src/flags/types.js");

    // connect with a flag in the store
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "color",
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

    // evaluate should use local store, no additional fetch
    const result = await client.evaluate("color", {
      environment: "staging",
      context: [new Context("user", "u-1", { plan: "enterprise" })],
    });
    expect(result).toBe("blue");

    // Only 1 fetch (for connect), not 2
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should return code default when flag evaluates to null", async () => {
    const client = makeFlagsClient();

    // connect with a flag that has a null-returning environment config
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "f1",
            type: "flag",
            attributes: {
              key: "null-flag",
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

  it("should throw SmplTimeoutError when fetch is aborted by timeout", async () => {
    // Create client with a very short timeout
    const client = new FlagsClient(API_KEY, () => lastMockWs as never, 1);

    // Make fetch wait for abort signal, then throw AbortError like real fetch does
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

    const { SmplTimeoutError } = await import("../../../src/errors.js");
    await expect(client.list()).rejects.toThrow(SmplTimeoutError);
  });

  it("should re-throw non-abort errors from custom fetch wrapper", async () => {
    const client = makeFlagsClient();

    // Make fetch throw a non-abort, non-TypeError error
    mockFetch.mockImplementationOnce(() => {
      throw new Error("unexpected fetch error");
    });

    // The error should propagate through wrapFetchError as SmplConnectionError
    await expect(client.list()).rejects.toThrow(SmplConnectionError);
  });

  it("should auto-inject service context in evaluate()", async () => {
    const client = makeFlagsClient();
    client._parent = { _environment: "staging", _service: "my-svc" };

    // Mock evaluate fetch with a flag that targets service.key
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "flag-svc",
            type: "flag",
            attributes: {
              key: "svc-flag",
              name: "Service Flag",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [
                    {
                      logic: { "==": [{ var: "service.key" }, "my-svc"] },
                      value: true,
                    },
                  ],
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
});
