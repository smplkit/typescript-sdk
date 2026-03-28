import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import { Transport } from "../../../src/transport.js";
import {
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
  SmplConnectionError,
  SmplTimeoutError,
} from "../../../src/errors.js";

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeTransport() {
  return new Transport({
    apiKey: "sk_api_test",
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

const SAMPLE_RESOURCE = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "config",
  attributes: {
    name: "User Service",
    key: "user_service",
    description: "Configuration for the user service",
    parent: null,
    values: { timeout: 30, retries: 3 },
    environments: { production: { timeout: 60 } },
    created_at: "2024-01-15T10:30:00Z",
    updated_at: "2024-01-16T14:00:00Z",
  },
};

describe("ConfigClient", () => {
  describe("get", () => {
    it("should fetch a config by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = new ConfigClient(makeTransport());
      const config = await client.get({ id: "550e8400-e29b-41d4-a716-446655440000" });

      expect(config.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(config.name).toBe("User Service");
      expect(config.key).toBe("user_service");
      expect(config.description).toBe("Configuration for the user service");
      expect(config.parent).toBeNull();
      expect(config.values).toEqual({ timeout: 30, retries: 3 });
      expect(config.environments).toEqual({ production: { timeout: 60 } });
      expect(config.createdAt).toBeInstanceOf(Date);
      expect(config.updatedAt).toBeInstanceOf(Date);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/v1/configs/550e8400-e29b-41d4-a716-446655440000");
      expect(options.headers.Authorization).toBe("Bearer sk_api_test");
    });

    it("should fetch a config by key using filter query param", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_RESOURCE] }));

      const client = new ConfigClient(makeTransport());
      const config = await client.get({ key: "user_service" });

      expect(config.key).toBe("user_service");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/v1/configs");
      expect(url).toContain("filter%5Bkey%5D=user_service");
    });

    it("should throw if neither key nor id is provided", async () => {
      const client = new ConfigClient(makeTransport());
      await expect(client.get({})).rejects.toThrow(
        "Exactly one of 'key' or 'id' must be provided.",
      );
    });

    it("should throw if both key and id are provided", async () => {
      const client = new ConfigClient(makeTransport());
      await expect(client.get({ key: "test", id: "abc" })).rejects.toThrow(
        "Exactly one of 'key' or 'id' must be provided.",
      );
    });

    it("should throw SmplNotFoundError when get by key returns empty array", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const client = new ConfigClient(makeTransport());
      await expect(client.get({ key: "nonexistent" })).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError when get by id returns no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));

      const client = new ConfigClient(makeTransport());
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

      const client = new ConfigClient(makeTransport());
      const configs = await client.list();

      expect(configs).toHaveLength(2);
      expect(configs[0].name).toBe("User Service");
      expect(configs[1].name).toBe("Other Service");
    });

    it("should return an empty array when no configs exist", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const client = new ConfigClient(makeTransport());
      const configs = await client.list();

      expect(configs).toEqual([]);
    });
  });

  describe("create", () => {
    it("should send correct body and return the created config", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = new ConfigClient(makeTransport());
      const config = await client.create({
        name: "User Service",
        key: "user_service",
        description: "Configuration for the user service",
        values: { timeout: 30, retries: 3 },
      });

      expect(config.name).toBe("User Service");
      expect(config.key).toBe("user_service");

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.data.type).toBe("config");
      expect(body.data.attributes.name).toBe("User Service");
      expect(body.data.attributes.key).toBe("user_service");
      expect(body.data.attributes.description).toBe("Configuration for the user service");
      expect(body.data.attributes.values).toEqual({ timeout: 30, retries: 3 });
    });

    it("should create with only required fields", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = new ConfigClient(makeTransport());
      await client.create({ name: "Minimal Config" });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.data.attributes.name).toBe("Minimal Config");
      expect(body.data.attributes.key).toBeUndefined();
      expect(body.data.attributes.description).toBeUndefined();
    });

    it("should throw SmplValidationError when data is missing from response", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 201));

      const client = new ConfigClient(makeTransport());
      await expect(client.create({ name: "test" })).rejects.toThrow(SmplValidationError);
    });
  });

  describe("delete", () => {
    it("should send a DELETE request and return void", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const client = new ConfigClient(makeTransport());
      const result = await client.delete("550e8400-e29b-41d4-a716-446655440000");

      expect(result).toBeUndefined();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain("/api/v1/configs/550e8400-e29b-41d4-a716-446655440000");
      expect(options.method).toBe("DELETE");
    });
  });

  describe("error handling", () => {
    it("should throw SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      const client = new ConfigClient(makeTransport());
      await expect(client.get({ id: "missing" })).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConflictError on 409", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Conflict", 409));

      const client = new ConfigClient(makeTransport());
      await expect(client.delete("has-children")).rejects.toThrow(SmplConflictError);
    });

    it("should throw SmplValidationError on 422", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

      const client = new ConfigClient(makeTransport());
      await expect(client.create({ name: "" })).rejects.toThrow(SmplValidationError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      const client = new ConfigClient(makeTransport());
      await expect(client.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplTimeoutError on abort", async () => {
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      const client = new ConfigClient(makeTransport());
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

      const client = new ConfigClient(makeTransport());
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.description).toBeNull();
      expect(config.parent).toBeNull();
    });

    it("should handle null values and environments", async () => {
      const resource = {
        ...SAMPLE_RESOURCE,
        attributes: {
          ...SAMPLE_RESOURCE.attributes,
          values: null,
          environments: null,
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: resource }));

      const client = new ConfigClient(makeTransport());
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.values).toEqual({});
      expect(config.environments).toEqual({});
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

      const client = new ConfigClient(makeTransport());
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.createdAt).toBeNull();
      expect(config.updatedAt).toBeNull();
    });

    it("should parse timestamps as Date objects", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }));

      const client = new ConfigClient(makeTransport());
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

      const client = new ConfigClient(makeTransport());
      const config = await client.get({ id: SAMPLE_RESOURCE.id });

      expect(config.key).toBe("");
    });
  });

  describe("create with optional fields", () => {
    it("should include parent in request body when provided", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_RESOURCE }, 201));

      const client = new ConfigClient(makeTransport());
      await client.create({ name: "Child Config", parent: "parent-uuid-123" });

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.data.attributes.parent).toBe("parent-uuid-123");
    });
  });
});
