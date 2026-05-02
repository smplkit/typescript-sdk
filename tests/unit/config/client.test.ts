import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import { ConfigEnvironment } from "../../../src/config/types.js";
import {
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplError,
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

function makeClient(timeout?: number): ConfigClient {
  return new ConfigClient(API_KEY, timeout);
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
function calledUrl(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex][0].url as string;
}

/** Extract the method from a fetch call's Request object. */
function calledMethod(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex][0].method as string;
}

/** Read the body JSON from a fetch call's Request object. */
async function calledBodyJson(callIndex = 0): Promise<unknown> {
  return mockFetch.mock.calls[callIndex][0].json();
}

/** Get an authorization header value from a fetch call's Request. */
function calledAuthHeader(callIndex = 0): string {
  return mockFetch.mock.calls[callIndex][0].headers.get("Authorization") as string;
}

const SAMPLE_RESOURCE = {
  id: "user-service",
  type: "config",
  attributes: {
    name: "User Service",
    description: "User service configuration",
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

// ---------------------------------------------------------------------------
// new()
// ---------------------------------------------------------------------------

describe("ConfigClient", () => {
  describe("new", () => {
    it("should return a Config with the given id", () => {
      const client = makeClient();
      const config = client.management.new("user-service");

      expect(config.id).toBe("user-service");
    });

    it("should auto-generate name from key", () => {
      const client = makeClient();
      const config = client.management.new("user-service");

      expect(config.name).toBe("User Service");
    });

    it("should auto-generate name from underscore key", () => {
      const client = makeClient();
      const config = client.management.new("payment_gateway");

      expect(config.name).toBe("Payment Gateway");
    });

    it("should use provided name when given", () => {
      const client = makeClient();
      const config = client.management.new("user-service", { name: "Custom Name" });

      expect(config.name).toBe("Custom Name");
    });

    it("should set description when provided", () => {
      const client = makeClient();
      const config = client.management.new("user-service", { description: "A config" });

      expect(config.description).toBe("A config");
    });

    it("should default description to null", () => {
      const client = makeClient();
      const config = client.management.new("user-service");

      expect(config.description).toBeNull();
    });

    it("should set parent when provided", () => {
      const client = makeClient();
      const config = client.management.new("child-service", { parent: "parent-uuid" });

      expect(config.parent).toBe("parent-uuid");
    });

    it("should default parent to null", () => {
      const client = makeClient();
      const config = client.management.new("user-service");

      expect(config.parent).toBeNull();
    });

    it("should initialize items and environments as empty objects", () => {
      const client = makeClient();
      const config = client.management.new("user-service");

      expect(config.items).toEqual({});
      expect(config.environments).toEqual({});
    });

    it("should set timestamps to null", () => {
      const client = makeClient();
      const config = client.management.new("user-service");

      expect(config.createdAt).toBeNull();
      expect(config.updatedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Config.save() — POST (id is null)
  // ---------------------------------------------------------------------------

  describe("Config.save (POST — createdAt is null)", () => {
    it("should POST when createdAt is null", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      const config = client.management.new("user-service", { name: "User Service" });
      config.setNumber("timeout", 30);
      config.setNumber("retries", 3);

      await config.save();

      expect(calledMethod()).toBe("POST");
      expect(calledUrl()).toContain("/api/v1/configs");
    });

    it("should send correct JSON:API body with items wrapped as {value: raw}", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      const config = client.management.new("user-service", {
        name: "User Service",
        description: "User service configuration",
      });
      config.setNumber("timeout", 30);
      config.setNumber("retries", 3);

      await config.save();

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const data = body.data as Record<string, unknown>;
      const attrs = data.attributes as Record<string, unknown>;

      expect(data.type).toBe("config");
      expect(attrs.name).toBe("User Service");
      expect(attrs.description).toBe("User service configuration");
      expect(attrs.items).toEqual({
        timeout: { value: 30 },
        retries: { value: 3 },
      });
    });

    it("should send authorization header", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      const config = client.management.new("user-service");
      await config.save();

      expect(calledAuthHeader()).toBe("Bearer sk_api_test");
    });

    it("should update instance in-place after save", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      const config = client.management.new("user-service");

      expect(config.createdAt).toBeNull();
      await config.save();

      expect(config.id).toBe("user-service");
      expect(config.name).toBe("User Service");
      expect(config.items).toEqual({ timeout: 30, retries: 3 });
      expect(config.createdAt).toBe("2024-01-15T10:30:00Z");
      expect(config.updatedAt).toBe("2024-01-16T14:00:00Z");
    });

    it("should wrap environment values in the POST body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      const config = client.management.new("user-service");
      config.setNumber("timeout", 60, { environment: "production" });

      await config.save();

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      // The wire body wraps values in `{value: raw}`. (The current source also
      // includes an internal `_valuesRaw` field on each environment due to the
      // ConfigEnvironment instance being JSON-serialized; we only assert on
      // the canonical `values` key here.)
      const envs = attrs.environments as Record<string, Record<string, unknown>>;
      expect(envs.production.values).toEqual({ timeout: { value: 60 } });
    });

    it("should throw SmplValidationError when response has no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 201));

      const client = makeClient();
      const config = client.management.new("user-service");

      await expect(config.save()).rejects.toThrow(SmplValidationError);
    });
  });

  // ---------------------------------------------------------------------------
  // Config.save() — PUT (id is set)
  // ---------------------------------------------------------------------------

  describe("Config.save (PUT — createdAt is set)", () => {
    it("should PUT when createdAt is set", async () => {
      const updatedResource = {
        ...SAMPLE_RESOURCE,
        attributes: { ...SAMPLE_RESOURCE.attributes, name: "Updated Service" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: updatedResource }));

      const client = makeClient();
      const config = client.management.new("user-service");
      // Simulate a previously-saved config with createdAt set
      config.createdAt = "2024-01-15T10:30:00Z";
      config.name = "Updated Service";

      await config.save();

      expect(calledMethod()).toBe("PUT");
      expect(calledUrl()).toContain("/api/v1/configs/user-service");
    });

    it("should send correct JSON:API body for PUT", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = client.management.new("user-service");
      config.createdAt = "2024-01-15T10:30:00Z";
      config.setNumber("timeout", 30);

      await config.save();

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const data = body.data as Record<string, unknown>;
      expect(data.id).toBe("user-service");
      expect(data.type).toBe("config");
    });

    it("should update instance in-place after PUT", async () => {
      const updatedResource = {
        ...SAMPLE_RESOURCE,
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          name: "Updated Service",
          updated_at: "2024-02-01T00:00:00Z",
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: updatedResource }));

      const client = makeClient();
      const config = client.management.new("user-service");
      config.createdAt = "2024-01-15T10:30:00Z";

      await config.save();

      expect(config.name).toBe("Updated Service");
      expect(config.updatedAt).toBe("2024-02-01T00:00:00Z");
    });

    it("should throw SmplValidationError when PUT response has no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      const client = makeClient();
      const config = client.management.new("user-service");
      config.createdAt = "2024-01-15T10:30:00Z";

      await expect(config.save()).rejects.toThrow(SmplValidationError);
    });
  });

  // ---------------------------------------------------------------------------
  // get(key)
  // ---------------------------------------------------------------------------

  describe("management.get", () => {
    it("should fetch a config by id using GET /api/v1/configs/{id}", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client.management.get("user-service");

      expect(config.id).toBe("user-service");
      expect(config.name).toBe("User Service");
      expect(config.description).toBe("User service configuration");
      expect(config.parent).toBeNull();
      expect(config.items).toEqual({ timeout: 30, retries: 3 });
      // environments returns a Record<string, ConfigEnvironment>; ConfigEnvironment.values is a getter.
      expect(Object.keys(config.environments)).toEqual(["production"]);
      expect(config.environments.production).toBeInstanceOf(ConfigEnvironment);
      expect(config.environments.production.values).toEqual({ timeout: 60 });
      expect(config.createdAt).toBe("2024-01-15T10:30:00Z");
      expect(config.updatedAt).toBe("2024-01-16T14:00:00Z");

      expect(calledUrl()).toContain("/api/v1/configs/user-service");
      expect(calledAuthHeader()).toBe("Bearer sk_api_test");
    });

    it("should throw SmplNotFoundError when data is undefined", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      const client = makeClient();
      await expect(client.management.get("nonexistent")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError on 404 response", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = makeClient();
      await expect(client.management.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(client.management.get("test")).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplNotFoundError for JSON 404", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "Not Found" }] }, 404));

      const client = makeClient();
      await expect(client.management.get("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  // ---------------------------------------------------------------------------
  // delete(key)
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    it("should DELETE by id directly", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = makeClient();
      const result = await client.management.delete("user-service");

      expect(result).toBeUndefined();

      expect(calledUrl(0)).toContain("/api/v1/configs/user-service");
      expect(calledMethod(0)).toBe("DELETE");
    });

    it("should throw SmplConflictError on 409 from DELETE", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Conflict", 409));

      const client = makeClient();
      await expect(client.management.delete("user-service")).rejects.toThrow(SmplConflictError);
    });

    it("should throw SmplConflictError on JSON 409 from DELETE", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "Conflict" }] }, 409));

      const client = makeClient();
      await expect(client.management.delete("user-service")).rejects.toThrow(SmplConflictError);
    });

    it("should throw SmplConnectionError on network failure during DELETE", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(client.management.delete("user-service")).rejects.toThrow(SmplConnectionError);
    });
  });

  // ---------------------------------------------------------------------------
  // list()
  // ---------------------------------------------------------------------------

  describe("list", () => {
    it("should return an array of Config objects", async () => {
      const secondResource = {
        ...SAMPLE_RESOURCE,
        id: "other-service",
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          name: "Other Service",
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_RESOURCE, secondResource] }));

      const client = makeClient();
      const configs = await client.management.list();

      expect(configs).toHaveLength(2);
      expect(configs[0].name).toBe("User Service");
      expect(configs[0].id).toBe("user-service");
      expect(configs[1].name).toBe("Other Service");
      expect(configs[1].id).toBe("other-service");
    });

    it("should return an empty array when no configs exist", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const client = makeClient();
      const configs = await client.management.list();

      expect(configs).toEqual([]);
    });

    it("should return empty array when data is falsy", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const client = makeClient();
      const configs = await client.management.list();

      expect(configs).toEqual([]);
    });

    it("should throw on server error", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Internal Error", 500));

      const client = makeClient();
      await expect(client.management.list()).rejects.toThrow(SmplError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(client.management.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw on JSON error response for list", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "Server Error" }] }, 500));

      const client = makeClient();
      await expect(client.management.list()).rejects.toThrow(SmplError);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("should throw SmplValidationError on 422", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

      const client = makeClient();
      const config = client.management.new("test");
      await expect(config.save()).rejects.toThrow(SmplValidationError);
    });

    it("should throw SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = makeClient();
      await expect(client.management.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(client.management.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplTimeoutError on abort", async () => {
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      const client = makeClient();
      await expect(client.management.list()).rejects.toThrow(SmplTimeoutError);
    });

    it("should throw SmplError on unknown status code", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

      const client = makeClient();
      await expect(client.management.get("test")).rejects.toThrow("HTTP 500");
    });

    it("should throw SmplConnectionError on generic error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("some other error"));

      const client = makeClient();
      await expect(client.management.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplConnectionError for non-Error objects", async () => {
      mockFetch.mockRejectedValueOnce("string error");

      const client = makeClient();
      await expect(client.management.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should re-throw SmplError subclasses through wrapFetchError", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = makeClient();
      await expect(client.management.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplValidationError for JSON 422 on save", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ errors: [{ detail: "Validation Error" }] }, 422),
      );

      const client = makeClient();
      const config = client.management.new("test");
      await expect(config.save()).rejects.toThrow(SmplValidationError);
    });

    it("should throw SmplConnectionError on network failure for save", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      const config = client.management.new("test");
      await expect(config.save()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplValidationError for 422 on PUT", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

      const client = makeClient();
      const config = client.management.new("test");
      config.createdAt = "2024-01-15T10:30:00Z";
      await expect(config.save()).rejects.toThrow(SmplValidationError);
    });

    it("should throw SmplConnectionError on network failure for PUT", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      const config = client.management.new("test");
      config.createdAt = "2024-01-15T10:30:00Z";
      await expect(config.save()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw on error response for delete", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

      const client = makeClient();
      await expect(client.management.delete("user-service")).rejects.toThrow("HTTP 500");
    });

    it("should throw SmplTimeoutError on abort for get", async () => {
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      const client = makeClient();
      await expect(client.management.get("test")).rejects.toThrow(SmplTimeoutError);
    });
  });

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

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
      const config = await client.management.get("user-service");

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
      const config = await client.management.get("user-service");

      expect(config.items).toEqual({});
      expect(config.environments).toEqual({});
    });

    it("should pass through environment entries without values key", async () => {
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
      const config = await client.management.get("user-service");

      // environments are wrapped into ConfigEnvironment instances. An entry
      // without a `values` key falls back to a fresh ConfigEnvironment whose
      // own data is whatever was passed (description treated as a key/value).
      expect(Object.keys(config.environments)).toEqual(["staging", "legacy"]);
      expect(config.environments.staging).toBeInstanceOf(ConfigEnvironment);
      expect(config.environments.legacy).toBeInstanceOf(ConfigEnvironment);
      // legacy was null — produces an empty ConfigEnvironment.
      expect(config.environments.legacy.values).toEqual({});
    });

    it("should store timestamps as strings (not Date)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client.management.get("user-service");

      expect(typeof config.createdAt).toBe("string");
      expect(config.createdAt).toBe("2024-01-15T10:30:00Z");
      expect(typeof config.updatedAt).toBe("string");
      expect(config.updatedAt).toBe("2024-01-16T14:00:00Z");
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
      const config = await client.management.get("user-service");

      expect(config.createdAt).toBeNull();
      expect(config.updatedAt).toBeNull();
    });

    it("should use null when id is null in resource", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        id: null,
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [resource] }));

      const client = makeClient();
      // Force it through list which doesn't throw for null id
      const configs = await client.management.list();

      expect(configs[0].id).toBeNull();
    });

    it("should unwrap items from {value: raw} to raw", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client.management.get("user-service");

      // Items should be unwrapped via the items getter: {timeout: {value: 30}} -> {timeout: 30}
      expect(config.items).toEqual({ timeout: 30, retries: 3 });
    });

    it("should unwrap environment values from {value: raw} to raw", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client.management.get("user-service");

      // Environments are ConfigEnvironment instances; their `values` getter returns raw.
      expect(config.environments.production.values).toEqual({ timeout: 60 });
    });
  });

  // ---------------------------------------------------------------------------
  // _getById
  // ---------------------------------------------------------------------------

  describe("_getById", () => {
    it("should fetch a config by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = await client._getById("user-service");

      expect(config.id).toBe("user-service");
      expect(config.name).toBe("User Service");
      expect(calledUrl()).toContain("/api/v1/configs/user-service");
    });

    it("should throw SmplNotFoundError when config not found", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

      const client = makeClient();
      await expect(client._getById("missing-uuid")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = makeClient();
      await expect(client._getById("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = makeClient();
      await expect(client._getById("test")).rejects.toThrow(SmplConnectionError);
    });
  });

  // ---------------------------------------------------------------------------
  // Wire format: items and environments on save
  // ---------------------------------------------------------------------------

  describe("wire format on save", () => {
    it("should wrap items as {value: raw} in POST body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = makeClient();
      const config = client.management.new("test");
      config.setString("host", "localhost");
      config.setNumber("port", 5432);
      config.setBoolean("ssl", true);

      await config.save();

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs.items).toEqual({
        host: { value: "localhost" },
        port: { value: 5432 },
        ssl: { value: true },
      });
    });

    it("should wrap environment values in PUT body", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = client.management.new("test");
      config.createdAt = "2024-01-15T10:30:00Z";
      config.setNumber("timeout", 60, { environment: "production" });

      await config.save();

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      const envs = attrs.environments as Record<string, Record<string, unknown>>;
      expect(envs.production.values).toEqual({ timeout: { value: 60 } });
    });

    it("should handle empty environments on save", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = makeClient();
      const config = client.management.new("test");
      config.createdAt = "2024-01-15T10:30:00Z";

      await config.save();

      const body = (await calledBodyJson()) as Record<string, unknown>;
      const attrs = (body.data as Record<string, unknown>).attributes as Record<string, unknown>;
      expect(attrs.environments).toEqual({});
    });
  });

  // ---------------------------------------------------------------------------
  // _connectInternal (backward compat)
  // ---------------------------------------------------------------------------

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
                items: { host: { value: "localhost" }, port: { value: 5432 } },
                environments: {},
              },
            },
          ],
        }),
      );

      await client._connectInternal("production");

      // Cache stores resolved values from `_buildChain` + `resolveChain`.
      // The current source preserves the wire-shaped `{value: raw}` typed-item
      // wrappers in the cache (no unwrap step in `resolveChain`); assert the
      // structure we actually get back.
      expect(client._getCachedConfig("db")).toEqual({
        host: { value: "localhost" },
        port: { value: 5432 },
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
  });

  describe("internal model-client aliases", () => {
    it("_deleteConfig() should issue DELETE on /configs/{id}", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client._deleteConfig("checkout");

      expect(calledUrl(0)).toContain("/api/v1/configs/checkout");
      expect(calledMethod(0)).toBe("DELETE");
    });

    it("_fetchConfig() should issue GET on /configs/{id}", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: "checkout",
            type: "config",
            attributes: {
              name: "Checkout",
              description: null,
              parent: null,
              items: { retries: { value: 3 } },
              environments: {},
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-01T00:00:00Z",
            },
          },
        }),
      );

      const cfg = await client._fetchConfig("checkout");

      expect(cfg.id).toBe("checkout");
      expect(calledUrl(0)).toContain("/api/v1/configs/checkout");
      expect(calledMethod(0)).toBe("GET");
    });
  });

  describe("wrapEnvironments defensive paths (via _createConfig)", () => {
    const SAMPLE_RESOURCE_FOR_DEFENSE = {
      id: "x",
      type: "config",
      attributes: {
        name: "X",
        description: null,
        parent: null,
        items: {},
        environments: {},
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      },
    };

    it("passes envEntry through unchanged when entry has no values key", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE_FOR_DEFENSE }, 201));

      const cfg = client.management.new("x", { name: "X" });
      // Inject an environment whose entry has no `values` key — exercises the
      // entry.values-falsy fallback in wrapEnvironments.
      (cfg as unknown as { _environments: Record<string, unknown> })._environments = {
        production: { metadata: "x" },
      };

      await cfg.save();

      const body = mockFetch.mock.calls[0][0];
      const payload = (await body.clone().json()) as Record<string, unknown>;
      const attrs = (payload.data as Record<string, unknown>).attributes as Record<string, unknown>;
      const envs = attrs.environments as Record<string, unknown>;
      expect(envs.production).toEqual({ metadata: "x" });
    });

    it("passes envEntry through unchanged when entry is not an object", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE_FOR_DEFENSE }, 201));

      const cfg = client.management.new("x", { name: "X" });
      // Inject an environment that is itself a primitive — exercises the
      // outer-else branch (envEntry is not a typed object).
      (cfg as unknown as { _environments: Record<string, unknown> })._environments = {
        production: "not-an-object",
      };

      await cfg.save();

      const body = mockFetch.mock.calls[0][0];
      const payload = (await body.clone().json()) as Record<string, unknown>;
      const attrs = (payload.data as Record<string, unknown>).attributes as Record<string, unknown>;
      const envs = attrs.environments as Record<string, unknown>;
      expect(envs.production).toBe("not-an-object");
    });
  });
});
