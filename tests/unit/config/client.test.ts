import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import {
  SmplNotFoundError,
  SmplNotConnectedError,
  SmplConflictError,
  SmplValidationError,
  SmplConnectionError,
  SmplTimeoutError,
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

function makeClient() {
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

/** Extract the URL string from the Request that openapi-fetch passes to fetch. */
function calledUrl(): string {
  return mockFetch.mock.calls[0][0].url as string;
}

/** Extract the method from the last fetch call's Request object. */
function calledMethod(): string {
  return mockFetch.mock.calls[0][0].method as string;
}

/** Read the body JSON from the first fetch call's Request object. */
async function calledBodyJson(): Promise<unknown> {
  return mockFetch.mock.calls[0][0].json();
}

/** Get an authorization header value from the first fetch call's Request. */
function calledAuthHeader(): string {
  return mockFetch.mock.calls[0][0].headers.get("Authorization") as string;
}

const SAMPLE_RESOURCE = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "config",
  attributes: {
    name: "User Service",
    key: "user_service",
    description: "Configuration for the user service",
    parent: null,
    items: {
      timeout: { value: 30, type: "NUMBER" },
      retries: { value: 3, type: "NUMBER" },
    },
    environments: {
      production: {
        values: {
          timeout: { value: 60 },
        },
      },
    },
    created_at: "2024-01-15T10:30:00Z",
    updated_at: "2024-01-16T14:00:00Z",
  },
};

describe("ConfigClient", () => {
  describe("get", () => {
    it("should fetch a config by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client.get({ id: "550e8400-e29b-41d4-a716-446655440000" });

      expect(config.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(config.name).toBe("User Service");
      expect(config.key).toBe("user_service");
      expect(config.description).toBe("Configuration for the user service");
      expect(config.parent).toBeNull();
      expect(config.items).toEqual({ timeout: 30, retries: 3 });
      expect(config.environments).toEqual({ production: { values: { timeout: 60 } } });
      expect(config.createdAt).toBeInstanceOf(Date);
      expect(config.updatedAt).toBeInstanceOf(Date);

      expect(calledUrl()).toContain("/api/v1/configs/550e8400-e29b-41d4-a716-446655440000");
      expect(calledAuthHeader()).toBe("Bearer sk_api_test");
    });

    it("should fetch a config by key using filter query param", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_RESOURCE] }));

      const client = makeClient();
      const config = await client.get({ key: "user_service" });

      expect(config.key).toBe("user_service");

      expect(calledUrl()).toContain("/api/v1/configs");
      // openapi-fetch passes the URL with bracket notation unencoded
      expect(calledUrl()).toMatch(/filter\[key\]=user_service/);
    });

    it("should throw if neither key nor id is provided", async () => {
      const client = makeClient();
      await expect(client.get({})).rejects.toThrow(
        "Exactly one of 'key' or 'id' must be provided.",
      );
    });

    it("should throw if both key and id are provided", async () => {
      const client = makeClient();
      await expect(client.get({ key: "test", id: "abc" })).rejects.toThrow(
        "Exactly one of 'key' or 'id' must be provided.",
      );
    });

    it("should throw SmplNotFoundError when get by key returns empty array", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const client = makeClient();
      await expect(client.get({ key: "nonexistent" })).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError when get by id returns no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));

      const client = makeClient();
      await expect(client.get({ id: "nonexistent" })).rejects.toThrow(SmplNotFoundError);
    });
  });

  describe("list", () => {
    it("should return an array of configs", async () => {
      const secondResource = {
        ...SAMPLE_RESOURCE,
        id: "660e8400-e29b-41d4-a716-446655440000",
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          name: "Other Service",
          key: "other_service",
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_RESOURCE, secondResource] }));

      const client = makeClient();
      const configs = await client.list();

      expect(configs).toHaveLength(2);
      expect(configs[0].name).toBe("User Service");
      expect(configs[1].name).toBe("Other Service");
    });

    it("should return an empty array when no configs exist", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const client = makeClient();
      const configs = await client.list();

      expect(configs).toEqual([]);
    });
  });

  describe("create", () => {
    it("should send correct body and return the created config", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      const config = await client.create({
        name: "User Service",
        key: "user_service",
        description: "Configuration for the user service",
        items: { timeout: 30, retries: 3 },
      });

      expect(config.name).toBe("User Service");
      expect(config.key).toBe("user_service");

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const data = body.data as Record<string, unknown>;
      const attrs = data.attributes as Record<string, unknown>;
      expect(data.type).toBe("config");
      expect(attrs.name).toBe("User Service");
      expect(attrs.key).toBe("user_service");
      expect(attrs.description).toBe("Configuration for the user service");
      expect(attrs.items).toEqual({
        timeout: { value: 30 },
        retries: { value: 3 },
      });
    });

    it("should create with only required fields", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      await client.create({ name: "Minimal Config" });

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs.name).toBe("Minimal Config");
      expect(attrs.key).toBeUndefined();
      expect(attrs.description).toBeUndefined();
    });

    it("should throw SmplValidationError when data is missing from response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 201));

      const client = makeClient();
      await expect(client.create({ name: "test" })).rejects.toThrow(SmplValidationError);
    });
  });

  describe("delete", () => {
    it("should send a DELETE request and return void", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = makeClient();
      const result = await client.delete("550e8400-e29b-41d4-a716-446655440000");

      expect(result).toBeUndefined();
      expect(calledUrl()).toContain("/api/v1/configs/550e8400-e29b-41d4-a716-446655440000");
      expect(calledMethod()).toBe("DELETE");
    });
  });

  describe("error handling", () => {
    it("should throw SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = makeClient();
      await expect(client.get({ id: "missing" })).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConflictError on 409", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Conflict", 409));

      const client = makeClient();
      await expect(client.delete("has-children")).rejects.toThrow(SmplConflictError);
    });

    it("should throw SmplValidationError on 422", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

      const client = makeClient();
      await expect(client.create({ name: "" })).rejects.toThrow(SmplValidationError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(client.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplTimeoutError on abort", async () => {
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      const client = makeClient();
      await expect(client.list()).rejects.toThrow(SmplTimeoutError);
    });
  });

  describe("response parsing", () => {
    it("should handle null description and parent", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          description: null,
          parent: null,
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));

      const client = makeClient();
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.description).toBeNull();
      expect(config.parent).toBeNull();
    });

    it("should handle null items and environments", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          items: null,
          environments: null,
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));

      const client = makeClient();
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.items).toEqual({});
      expect(config.environments).toEqual({});
    });

    it("should pass through environment entries without values when parsing response", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          environments: {
            staging: { description: "no values key" },
            legacy: null,
          },
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));

      const client = makeClient();
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.environments).toEqual({
        staging: { description: "no values key" },
        legacy: null,
      });
    });

    it("should handle null timestamps", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          created_at: null,
          updated_at: null,
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));

      const client = makeClient();
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.createdAt).toBeNull();
      expect(config.updatedAt).toBeNull();
    });

    it("should parse timestamps as Date objects", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.createdAt).toBeInstanceOf(Date);
      expect(config.createdAt?.toISOString()).toBe("2024-01-15T10:30:00.000Z");
      expect(config.updatedAt).toBeInstanceOf(Date);
      expect(config.updatedAt?.toISOString()).toBe("2024-01-16T14:00:00.000Z");
    });

    it("should use empty string fallback when key is null", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        attributes: { ...SAMPLE_RESOURCE.attributes, key: null },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));

      const client = makeClient();
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.key).toBe("");
    });

    it("should use empty string fallback when id is null", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        id: null,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));

      const client = makeClient();
      const config = await client.get({ id: "some-id" });

      expect(config.id).toBe("");
    });
  });

  describe("create with optional fields", () => {
    it("should include parent in request body when provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      await client.create({ name: "Child Config", parent: "parent-uuid-123" });

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs.parent).toBe("parent-uuid-123");
    });
  });

  describe("_updateConfig", () => {
    it("should send a PUT request and return the updated config", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client._updateConfig({
        configId: SAMPLE_RESOURCE.id,
        name: "User Service",
        key: "user_service",
        description: "Updated description",
        parent: null,
        items: { timeout: 30 },
        environments: {},
      });

      expect(config.name).toBe("User Service");
      expect(calledUrl()).toContain(`/api/v1/configs/${SAMPLE_RESOURCE.id}`);
      expect(calledMethod()).toBe("PUT");
    });

    it("should throw SmplValidationError when update returns no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      const client = makeClient();
      await expect(
        client._updateConfig({
          configId: "cfg-1",
          name: "Test",
          key: "test",
          description: null,
          parent: null,
          items: {},
          environments: {},
        }),
      ).rejects.toThrow(SmplValidationError);
    });

    it("should throw on 422 error from server", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

      const client = makeClient();
      await expect(
        client._updateConfig({
          configId: "cfg-1",
          name: "",
          key: "test",
          description: null,
          parent: null,
          items: {},
          environments: {},
        }),
      ).rejects.toThrow(SmplValidationError);
    });

    it("should throw on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(
        client._updateConfig({
          configId: "cfg-1",
          name: "Test",
          key: "test",
          description: null,
          parent: null,
          items: {},
          environments: {},
        }),
      ).rejects.toThrow(SmplConnectionError);
    });

    it("should pass through environment entries without values property", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      await client._updateConfig({
        configId: SAMPLE_RESOURCE.id,
        name: "User Service",
        key: "user_service",
        description: null,
        parent: null,
        items: {},
        environments: { staging: { description: "no values here" } },
      });

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs.environments).toEqual({ staging: { description: "no values here" } });
    });

    it("should pass through non-object environment entries (e.g. null or primitive)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      await client._updateConfig({
        configId: SAMPLE_RESOURCE.id,
        name: "User Service",
        key: "user_service",
        description: null,
        parent: null,
        items: {},
        environments: { staging: null as unknown, legacy: "disabled" as unknown },
      });

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs.environments).toEqual({ staging: null, legacy: "disabled" });
    });

    it("should include environments in the PUT body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      await client._updateConfig({
        configId: SAMPLE_RESOURCE.id,
        name: "User Service",
        key: "user_service",
        description: null,
        parent: null,
        items: {},
        environments: { production: { values: { x: 1 } } },
      });

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs.environments).toEqual({ production: { values: { x: { value: 1 } } } });
    });
  });

  describe("checkError via result.error path", () => {
    // openapi-fetch sets result.error when the response has JSON content type
    // and the status is non-2xx. This exercises the checkError path.

    it("should throw SmplNotFoundError for JSON 404 on getById", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "Not Found" }] }, 404));

      const client = makeClient();
      await expect(client.get({ id: "missing" })).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError for JSON 404 on getByKey", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "Not Found" }] }, 404));

      const client = makeClient();
      await expect(client.get({ key: "missing_key" })).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw on JSON error for list", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "Server Error" }] }, 500));

      const client = makeClient();
      await expect(client.list()).rejects.toThrow();
    });

    it("should throw on JSON error for create", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errors: [{ detail: "Validation Error" }] }, 422),
      );

      const client = makeClient();
      await expect(client.create({ name: "test" })).rejects.toThrow(SmplValidationError);
    });

    it("should throw on JSON error for delete (non-204)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "Conflict" }] }, 409));

      const client = makeClient();
      await expect(client.delete("test-id")).rejects.toThrow(SmplConflictError);
    });

    it("should throw on JSON error for _updateConfig", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errors: [{ detail: "Validation Error" }] }, 422),
      );

      const client = makeClient();
      await expect(
        client._updateConfig({
          configId: "cfg-1",
          name: "Test",
          key: "test",
          description: null,
          parent: null,
          items: {},
          environments: {},
        }),
      ).rejects.toThrow(SmplValidationError);
    });
  });

  describe("additional error handling", () => {
    it("should throw SmplError on unknown status code (default case)", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

      const client = makeClient();
      await expect(client.get({ id: "test" })).rejects.toThrow("HTTP 500");
    });

    it("should throw SmplConnectionError on generic error (not TypeError or DOMException)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("some other error"));

      const client = makeClient();
      await expect(client.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplConnectionError with String(err) for non-Error objects", async () => {
      mockFetch.mockRejectedValueOnce("string error");

      const client = makeClient();
      await expect(client.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplNotFoundError on 404 for getByKey", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = makeClient();
      await expect(client.get({ key: "missing_key" })).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConnectionError on network failure for getByKey", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(client.get({ key: "test" })).rejects.toThrow(SmplConnectionError);
    });

    it("should throw on error response for list", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Internal Error", 500));

      const client = makeClient();
      await expect(client.list()).rejects.toThrow("HTTP 500");
    });

    it("should throw on error response for create", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

      const client = makeClient();
      await expect(client.create({ name: "test" })).rejects.toThrow("HTTP 500");
    });

    it("should throw on error response for delete", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

      const client = makeClient();
      await expect(client.delete("test-id")).rejects.toThrow("HTTP 500");
    });

    it("should throw SmplTimeoutError on abort for getByKey", async () => {
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      const client = makeClient();
      await expect(client.get({ key: "test" })).rejects.toThrow(SmplTimeoutError);
    });

    it("should re-throw SmplError subclasses through wrapFetchError", async () => {
      // When checkError throws, wrapFetchError should re-throw it as-is
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = makeClient();
      await expect(client.get({ id: "missing" })).rejects.toThrow(SmplNotFoundError);
    });
  });
});

// ---------------------------------------------------------------------------
// _connectInternal + getValue
// ---------------------------------------------------------------------------

describe("ConfigClient _connectInternal and getValue", () => {
  it("should populate cache via _connectInternal", async () => {
    const client = makeClient();

    // Mock list() returning one config
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "cfg-1",
            type: "config",
            attributes: {
              key: "db",
              name: "DB Config",
              description: null,
              parent: null,
              items: { host: { value: "localhost" }, port: { value: 5432 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client._connectInternal("production");

    expect(client.getValue("db", "host")).toBe("localhost");
    expect(client.getValue("db", "port")).toBe(5432);
  });

  it("should return all values when itemKey is omitted", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "cfg-1",
            type: "config",
            attributes: {
              key: "db",
              name: "DB Config",
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

    const all = client.getValue("db") as Record<string, unknown>;
    expect(all).toEqual({ host: "localhost" });
  });

  it("should return default for missing config", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await client._connectInternal("production");

    expect(client.getValue("missing", "key", "fallback")).toBe("fallback");
  });

  it("should return default for missing item key", async () => {
    const client = makeClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "cfg-1",
            type: "config",
            attributes: {
              key: "db",
              name: "DB Config",
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

    expect(client.getValue("db", "missing_key", "nope")).toBe("nope");
  });

  it("should throw SmplNotConnectedError before connect", () => {
    const client = makeClient();
    expect(() => client.getValue("db", "host")).toThrow(SmplNotConnectedError);
  });
});
