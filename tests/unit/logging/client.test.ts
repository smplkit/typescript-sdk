import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LoggingClient, LoggerRegistrationBuffer } from "../../../src/logging/client.js";
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
  id: "sqlalchemy.engine",
  type: "logger",
  attributes: {
    name: "SQLAlchemy Engine",
    level: "DEBUG",
    group: null,
    managed: true,
    environments: { production: { level: "WARN" } },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

const SAMPLE_GROUP = {
  id: "database-loggers",
  type: "log_group",
  attributes: {
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
    it("should return a Logger with createdAt: null", () => {
      const client = makeClient();
      const logger = client.management.new("sqlalchemy.engine");
      expect(logger).toBeInstanceOf(Logger);
      expect(logger.createdAt).toBeNull();
    });

    it("should auto-generate a display name from the id", () => {
      const client = makeClient();
      const logger = client.management.new("payment-service");
      expect(logger.name).toBe("Payment Service");
    });

    it("should accept an explicit name", () => {
      const client = makeClient();
      const logger = client.management.new("sqlalchemy.engine", { name: "Custom Name" });
      expect(logger.name).toBe("Custom Name");
    });

    it("should default managed to false", () => {
      const client = makeClient();
      const logger = client.management.new("test");
      expect(logger.managed).toBe(false);
    });

    it("should accept managed option", () => {
      const client = makeClient();
      const logger = client.management.new("test", { managed: true });
      expect(logger.managed).toBe(true);
    });

    it("should initialize with empty sources and environments", () => {
      const client = makeClient();
      const logger = client.management.new("test");
      expect(logger.sources).toEqual([]);
      expect(logger.environments).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Logger.save() — create (new logger: PUT upsert)
  // -----------------------------------------------------------------------

  describe("Logger.save() — create (PUT upsert)", () => {
    it("should PUT directly when createdAt is null (upsert — server creates if not found)", async () => {
      const client = makeClient();
      const logger = client.management.new("sqlalchemy.engine", {
        name: "SQLAlchemy Engine",
        managed: true,
      });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));

      await logger.save();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const putRequest: Request = mockFetch.mock.calls[0][0];
      expect(putRequest.method).toBe("PUT");
      expect(putRequest.url).toContain("/api/v1/loggers/sqlalchemy.engine");
      expect(logger.id).toBe("sqlalchemy.engine");
    });

    it("should send JSON:API body with correct attributes", async () => {
      const client = makeClient();
      const logger = client.management.new("my-logger", { name: "My Logger", managed: false });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));

      await logger.save();

      const putRequest: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await putRequest.text());
      expect(body.data.type).toBe("logger");
      expect(body.data.id).toBe("my-logger");
      expect(body.data.attributes.name).toBe("My Logger");
      expect(body.data.attributes.managed).toBe(false);
    });

    it("should send null level when level is not set", async () => {
      const client = makeClient();
      const logger = client.management.new("app.payments", { name: "Payments", managed: true });
      expect(logger.level).toBeNull();

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
      await logger.save();

      const putRequest: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await putRequest.text());
      expect(body.data.attributes.level).toBeNull();
    });

    it("should throw SmplConnectionError when PUT throws a network error", async () => {
      const client = makeClient();
      const logger = client.management.new("my-logger", { name: "My Logger" });

      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      await expect(logger.save()).rejects.toThrow(SmplConnectionError);
    });
  });

  // -----------------------------------------------------------------------
  // Logger.save() — PUT (update existing logger)
  // -----------------------------------------------------------------------

  describe("Logger.save() — PUT (update)", () => {
    it("should PUT when createdAt is set", async () => {
      const client = makeClient();
      // Fetch an existing logger (has createdAt set from server).
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
      const logger = await client.management.get("sqlalchemy.engine");
      expect(logger.createdAt).not.toBeNull();

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: { ...SAMPLE_LOGGER, attributes: { ...SAMPLE_LOGGER.attributes, level: "ERROR" } },
        }),
      );

      logger.setLevel({ toString: () => "ERROR" } as never);
      await logger.save(); // PUT only (logger already exists)

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const putRequest: Request = mockFetch.mock.calls[1][0];
      expect(putRequest.method).toBe("PUT");
      expect(putRequest.url).toContain("/api/v1/loggers/sqlalchemy.engine");
    });
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe("get()", () => {
    it("should fetch a logger by id using direct GET", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));

      const logger = await client.management.get("sqlalchemy.engine");

      expect(logger).toBeInstanceOf(Logger);
      expect(logger.id).toBe("sqlalchemy.engine");
      expect(logger.level).toBe("DEBUG");
      expect(logger.managed).toBe(true);

      const request: Request = mockFetch.mock.calls[0][0];
      expect(request.url).toContain("/api/v1/loggers/sqlalchemy.engine");
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

      await expect(client.management.get("missing")).rejects.toThrow(SmplNotFoundError);
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
        id: "uvicorn.access",
        attributes: { ...SAMPLE_LOGGER.attributes, name: "Uvicorn Access" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_LOGGER, secondLogger] }));

      const loggers = await client.management.list();

      expect(loggers).toHaveLength(2);
      expect(loggers[0]).toBeInstanceOf(Logger);
      expect(loggers[1]).toBeInstanceOf(Logger);
      expect(loggers[0].id).toBe("sqlalchemy.engine");
      expect(loggers[1].id).toBe("uvicorn.access");
    });

    it("should return empty array when no loggers exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const loggers = await client.management.list();
      expect(loggers).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // delete()
  // -----------------------------------------------------------------------

  describe("delete()", () => {
    it("should DELETE by id directly", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.management.delete("sqlalchemy.engine");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const deleteRequest: Request = mockFetch.mock.calls[0][0];
      expect(deleteRequest.method).toBe("DELETE");
      expect(deleteRequest.url).toContain("/api/v1/loggers/sqlalchemy.engine");
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

      await expect(client.management.delete("nonexistent")).rejects.toThrow(SmplNotFoundError);
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
    it("should return a LogGroup with createdAt: null", () => {
      const client = makeClient();
      const group = client.management.newGroup("database-loggers");
      expect(group).toBeInstanceOf(LogGroup);
      expect(group.createdAt).toBeNull();
    });

    it("should auto-generate a display name from the id", () => {
      const client = makeClient();
      const group = client.management.newGroup("database-loggers");
      expect(group.name).toBe("Database Loggers");
    });

    it("should accept an explicit name", () => {
      const client = makeClient();
      const group = client.management.newGroup("db", { name: "Custom Group" });
      expect(group.name).toBe("Custom Group");
    });

    it("should accept a parent group option", () => {
      const client = makeClient();
      const group = client.management.newGroup("child", { group: "parent-group" });
      expect(group.group).toBe("parent-group");
    });

    it("should default group to null", () => {
      const client = makeClient();
      const group = client.management.newGroup("top-level");
      expect(group.group).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // LogGroup.save() — POST / PUT
  // -----------------------------------------------------------------------

  describe("LogGroup.save()", () => {
    it("should POST when createdAt is null", async () => {
      const client = makeClient();
      const group = client.management.newGroup("database-loggers", { name: "Database Loggers" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_GROUP }));

      await group.save();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request: Request = mockFetch.mock.calls[0][0];
      expect(request.method).toBe("POST");
      expect(request.url).toContain("/api/v1/log_groups");
      expect(group.id).toBe("database-loggers");
    });

    it("should PUT when createdAt is set", async () => {
      const client = makeClient();
      const group = client.management.newGroup("database-loggers");

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
      expect(putRequest.url).toContain("/api/v1/log_groups/database-loggers");
    });

    it("should send JSON:API body with correct attributes", async () => {
      const client = makeClient();
      const group = client.management.newGroup("my-group", { name: "My Group" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_GROUP }));

      await group.save();

      const request: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await request.text());
      expect(body.data.type).toBe("log_group");
      expect(body.data.id).toBe("my-group");
      expect(body.data.attributes.name).toBe("My Group");
    });
  });

  // -----------------------------------------------------------------------
  // getGroup()
  // -----------------------------------------------------------------------

  describe("getGroup()", () => {
    it("should list all groups and find by id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));

      const group = await client.management.getGroup("database-loggers");

      expect(group).toBeInstanceOf(LogGroup);
      expect(group.id).toBe("database-loggers");
    });

    it("should throw SmplNotFoundError when id not found", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));

      await expect(client.management.getGroup("nonexistent")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplNotFoundError when no groups exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(client.management.getGroup("anything")).rejects.toThrow(SmplNotFoundError);
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
        id: "http-loggers",
        attributes: { ...SAMPLE_GROUP.attributes, name: "HTTP Loggers" },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP, secondGroup] }));

      const groups = await client.management.listGroups();

      expect(groups).toHaveLength(2);
      expect(groups[0]).toBeInstanceOf(LogGroup);
      expect(groups[1]).toBeInstanceOf(LogGroup);
      expect(groups[0].id).toBe("database-loggers");
      expect(groups[1].id).toBe("http-loggers");
    });

    it("should return empty array when no groups exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const groups = await client.management.listGroups();
      expect(groups).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // deleteGroup()
  // -----------------------------------------------------------------------

  describe("deleteGroup()", () => {
    it("should resolve id via listGroups then DELETE", async () => {
      const client = makeClient();
      // First call: listGroups() to find by id
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));
      // Second call: DELETE by id
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await client.management.deleteGroup("database-loggers");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const deleteRequest: Request = mockFetch.mock.calls[1][0];
      expect(deleteRequest.method).toBe("DELETE");
      expect(deleteRequest.url).toContain("/api/v1/log_groups/database-loggers");
    });

    it("should throw SmplNotFoundError if id does not exist", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await expect(client.management.deleteGroup("nonexistent")).rejects.toThrow(SmplNotFoundError);
    });
  });
});

// ===========================================================================
// Runtime: start() and onChange()
// ===========================================================================

describe("LoggingClient — runtime", () => {
  /**
   * Helper to make start() work with the expanded pipeline.
   * Registers an empty mock adapter and stubs fetch for list/listGroups.
   */
  function prepareForStart(client: LoggingClient): void {
    // Register a no-op adapter to skip auto-loading
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    // Mock the HTTP calls made during start (list + listGroups).
    // Use mockImplementation to create fresh Response objects per call.
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
  }

  describe("start()", () => {
    it("should be idempotent", async () => {
      const client = makeClient();
      prepareForStart(client);

      await client.start();
      await client.start();

      // _ensureWs should only be called once (4 ws.on calls for logger_changed/deleted and group_changed/deleted)
      expect(lastMockWs.on).toHaveBeenCalledTimes(4);
    });

    it("should wire a WebSocket listener for logger_changed", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();

      expect(lastMockWs.on).toHaveBeenCalledWith("logger_changed", expect.any(Function));
    });

    it("should wire a WebSocket listener for logger_deleted", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();

      expect(lastMockWs.on).toHaveBeenCalledWith("logger_deleted", expect.any(Function));
    });

    it("should log console.warn when bulk logger registration fails", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const client = makeClient();
      client.registerAdapter({
        name: "failing-adapter",
        discover: () => [{ name: "bad.logger", level: "INFO" }],
        applyLevel: () => {},
        installHook: () => {},
        uninstallHook: () => {},
      });
      // bulk call returns 400; list + listGroups return empty arrays
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        // First call: bulk register (fails)
        if (callCount === 1) {
          return Promise.resolve(jsonResponse({ errors: [{ detail: "Invalid" }] }, 400));
        }
        // Remaining calls: list + listGroups
        return Promise.resolve(jsonResponse({ data: [] }));
      });

      await client.start();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[smplkit] Logger bulk registration failed"),
      );
      warnSpy.mockRestore();
    });

    it("should send bulk payload with level and resolved_level for each discovered logger", async () => {
      const client = makeClient();
      client.registerAdapter({
        name: "test-adapter",
        discover: () => [
          { name: "app.server", level: "INFO" },
          { name: "app.db", level: "WARN" },
        ],
        applyLevel: () => {},
        installHook: () => {},
        uninstallHook: () => {},
      });

      // First call: bulk register (succeeds); remaining: list + listGroups
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(jsonResponse({ registered: 2 }));
        }
        return Promise.resolve(jsonResponse({ data: [] }));
      });

      await client.start();

      const bulkRequest: Request = mockFetch.mock.calls[0][0];
      expect(bulkRequest.method).toBe("POST");
      expect(bulkRequest.url).toContain("/api/v1/loggers/bulk");

      const body = JSON.parse(await bulkRequest.text());
      expect(body.loggers).toHaveLength(2);

      const serverLogger = body.loggers.find((l: { id: string }) => l.id === "app.server");
      expect(serverLogger).toBeDefined();
      expect(serverLogger.level).toBe("INFO");
      expect(serverLogger.resolved_level).toBe("INFO");

      const dbLogger = body.loggers.find((l: { id: string }) => l.id === "app.db");
      expect(dbLogger).toBeDefined();
      expect(dbLogger.level).toBe("WARN");
      expect(dbLogger.resolved_level).toBe("WARN");
    });

    it("should include service and environment in bulk payload when parent is set", async () => {
      const ws = createMockSharedWs();
      const client = new LoggingClient(API_KEY, () => ws as never, 30000);
      (client as any)._parent = {
        _environment: "production",
        _service: "api-gateway",
        _metrics: null,
      };
      client.registerAdapter({
        name: "test-adapter",
        discover: () => [{ name: "my.logger", level: "DEBUG" }],
        applyLevel: () => {},
        installHook: () => {},
        uninstallHook: () => {},
      });

      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(jsonResponse({ registered: 1 }));
        }
        return Promise.resolve(jsonResponse({ data: [] }));
      });

      await client.start();

      const bulkRequest: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await bulkRequest.text());
      expect(body.loggers[0].service).toBe("api-gateway");
      expect(body.loggers[0].environment).toBe("production");
    });

    it("should skip bulk call when no loggers are discovered", async () => {
      const client = makeClient();
      prepareForStart(client); // registers noop adapter with empty discover()
      // Only list + listGroups calls should happen
      mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));

      await client.start();

      // No bulk call — only list and listGroups
      const calls = mockFetch.mock.calls as Array<[Request]>;
      const bulkCalls = calls.filter(([req]) => req.url?.includes("/api/v1/loggers/bulk"));
      expect(bulkCalls).toHaveLength(0);
    });
  });

  describe("onChange()", () => {
    it("should register a global listener", async () => {
      const client = makeClient();
      prepareForStart(client);
      const cb = vi.fn();
      client.onChange(cb);

      await client.start();

      // Simulate a logger_changed event
      lastMockWs._emit("logger_changed", { id: "test.logger", level: "INFO" });

      expect(cb).toHaveBeenCalledWith({
        id: "test.logger",
        level: "INFO",
        source: "websocket",
      });
    });

    it("should register an id-scoped listener", async () => {
      const client = makeClient();
      prepareForStart(client);
      const cb = vi.fn();
      client.onChange("test.logger", cb);

      await client.start();

      lastMockWs._emit("logger_changed", { id: "test.logger", level: "DEBUG" });
      lastMockWs._emit("logger_changed", { id: "other.logger", level: "WARN" });

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb).toHaveBeenCalledWith({
        id: "test.logger",
        level: "DEBUG",
        source: "websocket",
      });
    });

    it("should throw when id-scoped onChange is called without a callback", () => {
      const client = makeClient();
      expect(() => client.onChange("my-id", undefined as never)).toThrow(SmplError);
    });

    it("should wire a WebSocket listener for group_changed and group_deleted", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();

      expect(lastMockWs.on).toHaveBeenCalledWith("group_changed", expect.any(Function));
      expect(lastMockWs.on).toHaveBeenCalledWith("group_deleted", expect.any(Function));
    });

    it("should trigger re-fetch when group_changed fires", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();

      const initialCallCount = mockFetch.mock.calls.length;
      // Simulate a group_changed event
      lastMockWs._emit("group_changed", { id: "my-group" });

      // Allow the async promise to settle
      await new Promise((r) => setTimeout(r, 10));
      // At least 2 more calls (list + listGroups) should have been made
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount);
    });

    it("should handle fetch error in group event handler without throwing", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();

      // Make subsequent fetches fail
      mockFetch.mockRejectedValue(new Error("network error"));
      // Should not throw — errors are swallowed in the group handler
      lastMockWs._emit("group_changed", { id: "my-group" });
      await new Promise((r) => setTimeout(r, 10));
    });

    it("should handle fetch error in logger_changed handler without throwing", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();

      // Make subsequent fetches fail
      mockFetch.mockRejectedValue(new Error("network error"));
      // Should not throw — errors are swallowed
      lastMockWs._emit("logger_changed", { id: "test.logger", level: "DEBUG" });
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe("_close()", () => {
    it("should unregister from the WebSocket", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();

      client._close();

      expect(lastMockWs.off).toHaveBeenCalledWith("logger_changed", expect.any(Function));
    });

    it("should allow start() again after close", async () => {
      const client = makeClient();
      prepareForStart(client);
      await client.start();
      client._close();

      // Reset mock to track new calls
      lastMockWs.on.mockClear();
      mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
      // Re-register adapter since _close resets state but _explicitAdapters stays true
      await client.start();

      expect(lastMockWs.on).toHaveBeenCalledTimes(4);
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
          errors: [{ status: "422", title: "Validation Error", detail: "Id is required" }],
        }),
        422,
      ),
    );

    const logger = client.management.new("bad-logger");
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

    await expect(client.management.get("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should throw SmplConnectionError on network TypeError", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await expect(client.management.get("anything")).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on generic Error via wrapFetchError", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("Something unexpected"));

    await expect(client.management.get("anything")).rejects.toThrow(SmplConnectionError);
    mockFetch.mockRejectedValueOnce(new Error("Something unexpected"));
    await expect(client.management.get("anything")).rejects.toThrow(
      "Request failed: Something unexpected",
    );
  });

  it("should throw SmplNotFoundError when get() response has no data", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await expect(client.management.get("nonexistent")).rejects.toThrow(SmplNotFoundError);
  });

  it("should throw SmplConnectionError on deleteGroup() network error", async () => {
    const client = makeClient();
    // First call is getGroup (list groups) — succeeds
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_GROUP] }));
    // Second call is the actual DELETE — fails
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client.management.deleteGroup("database-loggers")).rejects.toThrow(
      SmplConnectionError,
    );
  });

  it("should throw SmplError on unexpected HTTP status", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Internal Server Error", 500));

    await expect(client.management.list()).rejects.toThrow(SmplError);
  });

  it("should throw SmplTimeoutError when request times out", async () => {
    // Create client with a very short timeout
    lastMockWs = createMockSharedWs();
    const client = new LoggingClient(API_KEY, () => lastMockWs as never, 1);

    const abortErr = new DOMException("The operation was aborted.", "AbortError");
    mockFetch.mockRejectedValueOnce(abortErr);

    await expect(client.management.list()).rejects.toThrow(SmplTimeoutError);
  });

  it("should throw SmplConnectionError on delete() network error", async () => {
    const client = makeClient();
    // DELETE fails with network error
    mockFetch.mockRejectedValueOnce(new TypeError("connection refused"));

    await expect(client.management.delete("sqlalchemy.engine")).rejects.toThrow(
      SmplConnectionError,
    );
  });

  it("should throw SmplConnectionError on listGroups() network error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("network down"));

    await expect(client.management.listGroups()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on deleteGroup() network error", async () => {
    const client = makeClient();
    // listGroups fails with network error
    mockFetch.mockRejectedValueOnce(new TypeError("connection refused"));

    await expect(client.management.deleteGroup("database-loggers")).rejects.toThrow(
      SmplConnectionError,
    );
  });

  it("should throw SmplConnectionError on Logger.save() PUT network error (new logger)", async () => {
    const client = makeClient();
    const logger = client.management.new("test-logger");
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(logger.save()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on Logger.save() PUT network error (existing logger)", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    const logger = await client.management.get("test-logger");

    mockFetch.mockRejectedValueOnce(new TypeError("connection reset"));

    await expect(logger.save()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on LogGroup.save() POST network error", async () => {
    const client = makeClient();
    const group = client.management.newGroup("test-group");
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(group.save()).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplConnectionError on LogGroup.save() PUT network error", async () => {
    const client = makeClient();
    const group = client.management.newGroup("test-group");

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
  function prepareForStart(client: LoggingClient): void {
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
  }

  it("should swallow errors thrown by global listeners", async () => {
    const client = makeClient();
    prepareForStart(client);
    const throwingCb = vi.fn(() => {
      throw new Error("listener boom");
    });
    const goodCb = vi.fn();

    client.onChange(throwingCb);
    client.onChange(goodCb);

    await client.start();

    lastMockWs._emit("logger_changed", { id: "test", level: "INFO" });

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("should swallow errors thrown by id-scoped listeners", async () => {
    const client = makeClient();
    prepareForStart(client);
    const throwingCb = vi.fn(() => {
      throw new Error("id listener boom");
    });
    const goodCb = vi.fn();

    client.onChange("test", throwingCb);
    client.onChange("test", goodCb);

    await client.start();

    lastMockWs._emit("logger_changed", { id: "test", level: "DEBUG" });

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("should ignore events without an id field", async () => {
    const client = makeClient();
    prepareForStart(client);
    const cb = vi.fn();
    client.onChange(cb);

    await client.start();

    lastMockWs._emit("logger_changed", { level: "INFO" });

    expect(cb).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// LoggerRegistrationBuffer
// ===========================================================================

describe("LoggerRegistrationBuffer", () => {
  it("should add a new entry and report pendingCount", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("app.server", "INFO", "INFO", null, null);
    expect(buf.pendingCount).toBe(1);
  });

  it("should deduplicate entries with the same id", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("app.server", "INFO", "INFO", null, null);
    buf.add("app.server", "WARN", "WARN", null, null);
    expect(buf.pendingCount).toBe(1);
  });

  it("should add multiple distinct entries", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("app.a", "INFO", "INFO", null, null);
    buf.add("app.b", "WARN", "WARN", null, null);
    buf.add("app.c", "ERROR", "ERROR", null, null);
    expect(buf.pendingCount).toBe(3);
  });

  it("drain() should return all pending entries and reset to empty", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("app.a", "INFO", "INFO", "my-service", "staging");
    buf.add("app.b", "WARN", "WARN", null, null);

    const batch = buf.drain();
    expect(batch).toHaveLength(2);
    expect(batch[0]).toEqual({
      id: "app.a",
      level: "INFO",
      resolved_level: "INFO",
      service: "my-service",
      environment: "staging",
    });
    expect(batch[1]).toEqual({ id: "app.b", level: "WARN", resolved_level: "WARN" });
    expect(buf.pendingCount).toBe(0);
  });

  it("drain() on empty buffer should return empty array", () => {
    const buf = new LoggerRegistrationBuffer();
    expect(buf.drain()).toEqual([]);
  });

  it("should omit service/environment when null", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("app.x", "DEBUG", "DEBUG", null, null);
    const [item] = buf.drain();
    expect(item).not.toHaveProperty("service");
    expect(item).not.toHaveProperty("environment");
  });

  it("previously drained ids remain deduplicated", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("app.x", "INFO", "INFO", null, null);
    buf.drain();
    buf.add("app.x", "WARN", "WARN", null, null);
    expect(buf.pendingCount).toBe(0);
  });
});

// ===========================================================================
// Post-startup logger discovery: _onAdapterNewLogger and _flushLoggerBuffer
// ===========================================================================

describe("LoggingClient — post-startup logger discovery", () => {
  function prepareForStart(client: LoggingClient): void {
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
  }

  it("_onAdapterNewLogger should add to buffer and NOT call management CRUD", async () => {
    const client = makeClient();
    const mgNewSpy = vi.spyOn(client.management, "new");

    let capturedHook: ((name: string, level: string) => void) | null = null;
    client.registerAdapter({
      name: "test",
      discover: () => [],
      applyLevel: () => {},
      installHook: (cb) => {
        capturedHook = cb;
      },
      uninstallHook: () => {},
    });

    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Fire the hook as if a new logger was created in the framework
    capturedHook!("runtime.logger", "INFO");

    expect(mgNewSpy).not.toHaveBeenCalled();
    // Buffer should now have 1 pending item
    expect((client as any)._loggerBuffer.pendingCount).toBe(1);

    client._close();
  });

  it("_onAdapterNewLogger should not create managed loggers", async () => {
    const client = makeClient();
    const mgNewSpy = vi.spyOn(client.management, "new");

    let capturedHook: ((name: string, level: string) => void) | null = null;
    client.registerAdapter({
      name: "test",
      discover: () => [],
      applyLevel: () => {},
      installHook: (cb) => {
        capturedHook = cb;
      },
      uninstallHook: () => {},
    });

    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    capturedHook!("runtime.logger", "WARN");

    // management.new() must never be called for auto-discovered loggers
    expect(mgNewSpy).not.toHaveBeenCalled();

    client._close();
  });

  it("_flushLoggerBuffer should POST to /api/v1/loggers/bulk", async () => {
    const client = makeClient();
    (client as any)._parent = { _environment: "prod", _service: "svc", _metrics: null };

    let capturedHook: ((name: string, level: string) => void) | null = null;
    client.registerAdapter({
      name: "test",
      discover: () => [],
      applyLevel: () => {},
      installHook: (cb) => {
        capturedHook = cb;
      },
      uninstallHook: () => {},
    });

    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Reset fetch mock to capture the flush call
    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 1 }));

    capturedHook!("new.logger", "DEBUG");
    await (client as any)._flushLoggerBuffer();

    const bulkRequest: Request = mockFetch.mock.calls[0][0];
    expect(bulkRequest.method).toBe("POST");
    expect(bulkRequest.url).toContain("/api/v1/loggers/bulk");

    const body = JSON.parse(await bulkRequest.text());
    expect(body.loggers).toHaveLength(1);
    expect(body.loggers[0]).toMatchObject({
      id: "new.logger",
      level: "DEBUG",
      resolved_level: "DEBUG",
      service: "svc",
      environment: "prod",
    });

    client._close();
  });

  it("_flushLoggerBuffer should warn on error response", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient();
    prepareForStart(client);
    await client.start();

    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [{ detail: "bad" }] }, 400));

    // Manually add to buffer and flush
    (client as any)._loggerBuffer.add("x", "INFO", "INFO", null, null);
    await (client as any)._flushLoggerBuffer();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[smplkit] Logger bulk registration failed"),
    );

    warnSpy.mockRestore();
    client._close();
  });

  it("_flushLoggerBuffer should warn on network error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient();
    prepareForStart(client);
    await client.start();

    mockFetch.mockClear();
    mockFetch.mockRejectedValueOnce(new TypeError("connection refused"));

    (client as any)._loggerBuffer.add("x", "INFO", "INFO", null, null);
    await (client as any)._flushLoggerBuffer();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[smplkit] Logger bulk registration failed"),
    );

    warnSpy.mockRestore();
    client._close();
  });

  it("should trigger immediate flush at threshold of 50", async () => {
    const client = makeClient();

    let capturedHook: ((name: string, level: string) => void) | null = null;
    client.registerAdapter({
      name: "test",
      discover: () => [],
      applyLevel: () => {},
      installHook: (cb) => {
        capturedHook = cb;
      },
      uninstallHook: () => {},
    });

    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Reset fetch mock
    mockFetch.mockClear();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ registered: 50 })));

    const flushSpy = vi.spyOn(client as any, "_flushLoggerBuffer");

    // Fire 49 hooks — should not trigger immediate flush
    for (let i = 0; i < 49; i++) {
      capturedHook!(`logger.${i}`, "INFO");
    }
    expect(flushSpy).not.toHaveBeenCalled();

    // 50th logger triggers immediate flush
    capturedHook!("logger.49", "INFO");
    expect(flushSpy).toHaveBeenCalledTimes(1);

    client._close();
  });
});

// ===========================================================================
// Timer: setInterval started and cleared
// ===========================================================================

describe("LoggingClient — flush timer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should start a 30-second flush timer after start()", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const client = makeClient();
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));

    await client.start();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect((client as any)._loggerFlushTimer).not.toBeNull();

    client._close();
  });

  it("should clear the flush timer on _close()", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const client = makeClient();
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));

    await client.start();
    const timer = (client as any)._loggerFlushTimer;
    client._close();

    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    expect((client as any)._loggerFlushTimer).toBeNull();
  });

  it("should call _flushLoggerBuffer when timer fires", async () => {
    const client = makeClient();
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));

    await client.start();
    const flushSpy = vi.spyOn(client as any, "_flushLoggerBuffer");

    // Advance time by 30 seconds to trigger the interval
    await vi.advanceTimersByTimeAsync(30_000);

    expect(flushSpy).toHaveBeenCalledTimes(1);

    client._close();
  });
});
