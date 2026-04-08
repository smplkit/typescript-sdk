import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LoggingClient } from "../../../src/logging/client.js";
import { Logger, LogGroup } from "../../../src/logging/models.js";
import {
  SmplNotFoundError,
  SmplValidationError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplError,
} from "../../../src/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_test";

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

function makeClient(): LoggingClient {
  lastMockWs = createMockSharedWs();
  return new LoggingClient(API_KEY, () => lastMockWs as never, 30000);
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
// Sample JSON:API resources
// ---------------------------------------------------------------------------

const SAMPLE_LOGGER = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  type: "logger",
  attributes: {
    key: "sqlalchemy.engine",
    name: "SQLAlchemy Engine",
    level: "DEBUG",
    group: null,
    managed: true,
    sources: [{ service: "api-gateway", first_observed: "2026-04-01T10:00:00Z" }],
    environments: { production: { level: "WARN" } },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

const SAMPLE_GROUP = {
  id: "660e8400-e29b-41d4-a716-446655440000",
  type: "log_group",
  attributes: {
    key: "database-loggers",
    name: "Database Loggers",
    level: "WARN",
    group: null,
    environments: { production: { level: "ERROR" } },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

// ===========================================================================
// Logger management
// ===========================================================================

describe("LoggingClient — logger management", () => {
  // -----------------------------------------------------------------------
  // new()
  // -----------------------------------------------------------------------

  describe("new()", () => {
    it("should return a Logger with id: null", () => {
      const client = makeClient();
      const logger = client.new("sqlalchemy.engine");
      expect(logger).toBeInstanceOf(Logger);
      expect(logger.id).toBeNull();
    });

    it("should auto-generate a display name from the key", () => {
      const client = makeClient();
      const logger = client.new("payment-service");
      expect(logger.name).toBe("Payment Service");
    });

    it("should accept an explicit name", () => {
      const client = makeClient();
      const logger = client.new("sqlalchemy.engine", { name: "Custom Name" });
      expect(logger.name).toBe("Custom Name");
    });

    it("should default managed to false", () => {
      const client = makeClient();
      const logger = client.new("test");
      expect(logger.managed).toBe(false);
    });

    it("should accept managed option", () => {
      const client = makeClient();
      const logger = client.new("test", { managed: true });
      expect(logger.managed).toBe(true);
    });

    it("should initialize with empty sources and environments", () => {
      const client = makeClient();
      const logger = client.new("test");
      expect(logger.sources).toEqual([]);
      expect(logger.environments).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Logger.save() — POST (create)
  // -----------------------------------------------------------------------

  describe("Logger.save() — POST", () => {
    it("should POST when id is null", async () => {
      const client = makeClient();
      const logger = client.new("sqlalchemy.engine", { name: "SQLAlchemy Engine", managed: true });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));

      await logger.save();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request: Request = mockFetch.mock.calls[0][0];
      expect(request.method).toBe("POST");
      expect(request.url).toContain("/api/v1/loggers");
      expect(logger.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("should send JSON:API body with correct attributes", async () => {
      const client = makeClient();
      const logger = client.new("my-logger", { name: "My Logger", managed: false });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));

      await logger.save();

      const request: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await request.text());
      expect(body.data.type).toBe("logger");
      expect(body.data.attributes.key).toBe("my-logger");
      expect(body.data.attributes.name).toBe("My Logger");
      expect(body.data.attributes.managed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Logger.save() — PUT (update)
  // -----------------------------------------------------------------------

  describe("Logger.save() — PUT", () => {
    it("should PUT when id is set", async () => {
      const client = makeClient();
      // Simulate a logger that was previously fetched (has an id)
      const logger = client.new("sqlalchemy.engine");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
      await logger.save(); // POST sets the id

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: { ...SAMPLE_LOGGER, attributes: { ...SAMPLE_LOGGER.attributes, level: "ERROR" } },
        }),
      );

      logger.setLevel({ toString: () => "ERROR" } as never);
      await logger.save(); // PUT

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const putRequest: Request = mockFetch.mock.calls[1][0];
      expect(putRequest.method).toBe("PUT");
      expect(putRequest.url).toContain("/api/v1/loggers/550e8400-e29b-41d4-a716-446655440000");
    });
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe("get()", () => {
    it("should fetch a logger by key using filter[key]", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_LOGGER] }));

      const logger = await client.get("sqlalchemy.engine");

      expect(logger).toBeInstanceOf(Logger);
      expect(logger.key).toBe("sqlalchemy.engine");
      expect(logger.id).toBe("550e8400-e29b-41d4-a716-446655440000");
      expect(logger.level).toBe("DEBUG");
      expect(logger.managed).toBe(true);

      const request: Request = mockFetch.mock.calls[0][0];
      expect(request.url).toContain("filter[key]=sqlalchemy.engine");
    });

    it("should throw SmplNotFoundError when no results", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(client.get("nonexistent")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError on 404 response", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        textResponse(
          JSON.stringify({
            errors: [{ status: "404", title: "Not Found", detail: "Logger not found" }],
          }),
          404,
        ),
      );

      await expect(client.get("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe("list()", () => {
    it("should return an array of Logger instances", async () => {
      const client = makeClient();
      const secondLogger = {
        ...SAMPLE_LOGGER,
        id: "uuid-2",
        attributes: { ...SAMPLE_LOGGER.attributes, key: "uvicorn.access" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_LOGGER, secondLogger] }));

      const loggers = await client.list();

      expect(loggers).toHaveLength(2);
      expect(loggers[0]).toBeInstanceOf(Logger);
      expect(loggers[1]).toBeInstanceOf(Logger);
      expect(loggers[0].key).toBe("sqlalchemy.engine");
      expect(loggers[1].key).toBe("uvicorn.access");
    });

    it("should return empty array when no loggers exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const loggers = await client.list();
      expect(loggers).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // delete()
  // -----------------------------------------------------------------------

  describe("delete()", () => {
    it("should resolve key to UUID then DELETE", async () => {
      const client = makeClient();
      // First call: get() to resolve key -> UUID
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_LOGGER] }));
      // Second call: DELETE by UUID
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.delete("sqlalchemy.engine");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const deleteRequest: Request = mockFetch.mock.calls[1][0];
      expect(deleteRequest.method).toBe("DELETE");
      expect(deleteRequest.url).toContain("/api/v1/loggers/550e8400-e29b-41d4-a716-446655440000");
    });

    it("should throw SmplNotFoundError if key does not exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(client.delete("nonexistent")).rejects.toThrow(SmplNotFoundError);
    });
  });
});

// ===========================================================================
// LogGroup management
// ===========================================================================

describe("LoggingClient — log group management", () => {
  // -----------------------------------------------------------------------
  // newGroup()
  // -----------------------------------------------------------------------

  describe("newGroup()", () => {
    it("should return a LogGroup with id: null", () => {
      const client = makeClient();
      const group = client.newGroup("database-loggers");
      expect(group).toBeInstanceOf(LogGroup);
      expect(group.id).toBeNull();
    });

    it("should auto-generate a display name from the key", () => {
      const client = makeClient();
      const group = client.newGroup("database-loggers");
      expect(group.name).toBe("Database Loggers");
    });

    it("should accept an explicit name", () => {
      const client = makeClient();
      const group = client.newGroup("db", { name: "Custom Group" });
      expect(group.name).toBe("Custom Group");
    });

    it("should accept a parent group option", () => {
      const client = makeClient();
      const group = client.newGroup("child", { group: "parent-uuid" });
      expect(group.group).toBe("parent-uuid");
    });

    it("should default group to null", () => {
      const client = makeClient();
      const group = client.newGroup("top-level");
      expect(group.group).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // LogGroup.save() — POST / PUT
  // -----------------------------------------------------------------------

  describe("LogGroup.save()", () => {
    it("should POST when id is null", async () => {
      const client = makeClient();
      const group = client.newGroup("database-loggers", { name: "Database Loggers" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_GROUP }));

      await group.save();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request: Request = mockFetch.mock.calls[0][0];
      expect(request.method).toBe("POST");
      expect(request.url).toContain("/api/v1/log_groups");
      expect(group.id).toBe("660e8400-e29b-41d4-a716-446655440000");
    });

    it("should PUT when id is set", async () => {
      const client = makeClient();
      const group = client.newGroup("database-loggers");

      // POST to create
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_GROUP }));
      await group.save();

      // PUT to update
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            ...SAMPLE_GROUP,
            attributes: { ...SAMPLE_GROUP.attributes, level: "FATAL" },
          },
        }),
      );
      await group.save();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const putRequest: Request = mockFetch.mock.calls[1][0];
      expect(putRequest.method).toBe("PUT");
      expect(putRequest.url).toContain("/api/v1/log_groups/660e8400-e29b-41d4-a716-446655440000");
    });

    it("should send JSON:API body with correct attributes", async () => {
      const client = makeClient();
      const group = client.newGroup("my-group", { name: "My Group" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_GROUP }));

      await group.save();

      const request: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await request.text());
      expect(body.data.type).toBe("log_group");
      expect(body.data.attributes.key).toBe("my-group");
      expect(body.data.attributes.name).toBe("My Group");
    });
  });

  // -----------------------------------------------------------------------
  // getGroup()
  // -----------------------------------------------------------------------

  describe("getGroup()", () => {
    it("should list all groups and find by key", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));

      const group = await client.getGroup("database-loggers");

      expect(group).toBeInstanceOf(LogGroup);
      expect(group.key).toBe("database-loggers");
      expect(group.id).toBe("660e8400-e29b-41d4-a716-446655440000");
    });

    it("should throw SmplNotFoundError when key not found", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));

      await expect(client.getGroup("nonexistent")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError when no groups exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(client.getGroup("anything")).rejects.toThrow(SmplNotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // listGroups()
  // -----------------------------------------------------------------------

  describe("listGroups()", () => {
    it("should return an array of LogGroup instances", async () => {
      const client = makeClient();
      const secondGroup = {
        ...SAMPLE_GROUP,
        id: "group-uuid-2",
        attributes: { ...SAMPLE_GROUP.attributes, key: "http-loggers" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP, secondGroup] }));

      const groups = await client.listGroups();

      expect(groups).toHaveLength(2);
      expect(groups[0]).toBeInstanceOf(LogGroup);
      expect(groups[1]).toBeInstanceOf(LogGroup);
      expect(groups[0].key).toBe("database-loggers");
      expect(groups[1].key).toBe("http-loggers");
    });

    it("should return empty array when no groups exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const groups = await client.listGroups();
      expect(groups).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // deleteGroup()
  // -----------------------------------------------------------------------

  describe("deleteGroup()", () => {
    it("should resolve key to UUID then DELETE", async () => {
      const client = makeClient();
      // First call: listGroups() to resolve key -> UUID
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));
      // Second call: DELETE by UUID
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.deleteGroup("database-loggers");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const deleteRequest: Request = mockFetch.mock.calls[1][0];
      expect(deleteRequest.method).toBe("DELETE");
      expect(deleteRequest.url).toContain(
        "/api/v1/log_groups/660e8400-e29b-41d4-a716-446655440000",
      );
    });

    it("should throw SmplNotFoundError if key does not exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(client.deleteGroup("nonexistent")).rejects.toThrow(SmplNotFoundError);
    });
  });
});

// ===========================================================================
// Runtime: start() and onChange()
// ===========================================================================

describe("LoggingClient — runtime", () => {
  describe("start()", () => {
    it("should be idempotent", async () => {
      const client = makeClient();

      await client.start();
      await client.start();

      // _ensureWs should only be called once (the mock ws.on is called once)
      expect(lastMockWs.on).toHaveBeenCalledTimes(1);
    });

    it("should wire a WebSocket listener for logger_changed", async () => {
      const client = makeClient();
      await client.start();

      expect(lastMockWs.on).toHaveBeenCalledWith("logger_changed", expect.any(Function));
    });
  });

  describe("onChange()", () => {
    it("should register a global listener", async () => {
      const client = makeClient();
      const cb = vi.fn();
      client.onChange(cb);

      await client.start();

      // Simulate a logger_changed event
      lastMockWs._emit("logger_changed", { key: "test.logger", level: "INFO" });

      expect(cb).toHaveBeenCalledWith({
        key: "test.logger",
        level: "INFO",
        source: "websocket",
      });
    });

    it("should register a key-scoped listener", async () => {
      const client = makeClient();
      const cb = vi.fn();
      client.onChange("test.logger", cb);

      await client.start();

      lastMockWs._emit("logger_changed", { key: "test.logger", level: "DEBUG" });
      lastMockWs._emit("logger_changed", { key: "other.logger", level: "WARN" });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({
        key: "test.logger",
        level: "DEBUG",
        source: "websocket",
      });
    });

    it("should throw when key-scoped onChange is called without a callback", () => {
      const client = makeClient();
      expect(() => client.onChange("my-key", undefined as never)).toThrow(SmplError);
    });
  });

  describe("_close()", () => {
    it("should unregister from the WebSocket", async () => {
      const client = makeClient();
      await client.start();

      client._close();

      expect(lastMockWs.off).toHaveBeenCalledWith("logger_changed", expect.any(Function));
    });

    it("should allow start() again after close", async () => {
      const client = makeClient();
      await client.start();
      client._close();

      // Reset mock to track new calls
      lastMockWs.on.mockClear();
      await client.start();

      expect(lastMockWs.on).toHaveBeenCalledTimes(1);
    });
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe("LoggingClient — error handling", () => {
  it("should throw SmplValidationError on 422", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          errors: [{ status: "422", title: "Validation Error", detail: "Key is required" }],
        }),
        422,
      ),
    );

    const logger = client.new("bad-logger");
    await expect(logger.save()).rejects.toThrow(SmplValidationError);
  });

  it("should throw SmplNotFoundError on 404 for get()", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      textResponse(
        JSON.stringify({
          errors: [{ status: "404", title: "Not Found", detail: "Not found" }],
        }),
        404,
      ),
    );

    await expect(client.get("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should throw SmplConnectionError on network TypeError", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(client.get("anything")).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on generic Error via wrapFetchError", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("Something unexpected"));

    await expect(client.get("anything")).rejects.toThrow(SmplConnectionError);
    mockFetch.mockRejectedValueOnce(new Error("Something unexpected"));
    await expect(client.get("anything")).rejects.toThrow("Request failed: Something unexpected");
  });

  it("should throw SmplError on unexpected HTTP status", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Internal Server Error", 500));

    await expect(client.list()).rejects.toThrow(SmplError);
  });

  it("should throw SmplTimeoutError when request times out", async () => {
    // Create client with a very short timeout
    lastMockWs = createMockSharedWs();
    const client = new LoggingClient(API_KEY, () => lastMockWs as never, 1);

    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    mockFetch.mockRejectedValueOnce(abortErr);

    await expect(client.list()).rejects.toThrow(SmplTimeoutError);
  });

  it("should throw SmplConnectionError on delete() network error", async () => {
    const client = makeClient();
    // get() succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_LOGGER] }));
    // DELETE fails with network error
    mockFetch.mockRejectedValueOnce(new TypeError("connection refused"));

    await expect(client.delete("sqlalchemy.engine")).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on listGroups() network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("network down"));

    await expect(client.listGroups()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on deleteGroup() network error", async () => {
    const client = makeClient();
    // listGroups succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));
    // DELETE fails
    mockFetch.mockRejectedValueOnce(new TypeError("connection refused"));

    await expect(client.deleteGroup("database-loggers")).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on Logger.save() POST network error", async () => {
    const client = makeClient();
    const logger = client.new("test-logger");
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(logger.save()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on Logger.save() PUT network error", async () => {
    const client = makeClient();
    const logger = client.new("test-logger");

    // POST succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    await logger.save();

    // PUT fails
    mockFetch.mockRejectedValueOnce(new TypeError("connection reset"));

    await expect(logger.save()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on LogGroup.save() POST network error", async () => {
    const client = makeClient();
    const group = client.newGroup("test-group");
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(group.save()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on LogGroup.save() PUT network error", async () => {
    const client = makeClient();
    const group = client.newGroup("test-group");

    // POST succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_GROUP }));
    await group.save();

    // PUT fails
    mockFetch.mockRejectedValueOnce(new TypeError("connection reset"));

    await expect(group.save()).rejects.toThrow(SmplConnectionError);
  });
});

// ===========================================================================
// Listener error swallowing
// ===========================================================================

describe("LoggingClient — listener error swallowing", () => {
  it("should swallow errors thrown by global listeners", async () => {
    const client = makeClient();
    const throwingCb = vi.fn(() => {
      throw new Error("listener boom");
    });
    const goodCb = vi.fn();

    client.onChange(throwingCb);
    client.onChange(goodCb);

    await client.start();

    lastMockWs._emit("logger_changed", { key: "test", level: "INFO" });

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("should swallow errors thrown by key-scoped listeners", async () => {
    const client = makeClient();
    const throwingCb = vi.fn(() => {
      throw new Error("key listener boom");
    });
    const goodCb = vi.fn();

    client.onChange("test", throwingCb);
    client.onChange("test", goodCb);

    await client.start();

    lastMockWs._emit("logger_changed", { key: "test", level: "DEBUG" });

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("should ignore events without a key field", async () => {
    const client = makeClient();
    const cb = vi.fn();
    client.onChange(cb);

    await client.start();

    lastMockWs._emit("logger_changed", { level: "INFO" });

    expect(cb).not.toHaveBeenCalled();
  });
});
