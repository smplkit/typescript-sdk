/**
 * Tests for the fused LoggingClient — the management sub-clients
 * (LoggersClient / LogGroupsClient), the logger-discovery buffer, and the
 * live surface (install / registerAdapter / onChange / refresh / close /
 * WebSocket handlers).
 *
 * HTTP is mocked by stubbing the global `fetch`; the wired clients borrow a
 * transport built from `openapi-fetch` driven by that stub. The shared
 * WebSocket is a hand-rolled mock that records handler registrations and can
 * replay events.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createClient from "openapi-fetch";
import {
  LoggingClient,
  LoggerRegistrationBuffer,
  type LoggingParent,
} from "../../../src/logging/client.js";
import { Logger, LogGroup } from "../../../src/logging/models.js";
import { LoggerSource, LogLevel } from "../../../src/logging/types.js";
import {
  SmplError,
  SmplNotFoundError,
  SmplValidationError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotInstalledError,
} from "../../../src/errors.js";
import type { LoggingAdapter } from "../../../src/logging/adapters/base.js";
import type { SharedWebSocket } from "../../../src/ws.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function makeTransport(): any {
  return createClient<import("../../../src/generated/logging.d.ts").paths>({
    baseUrl: "https://logging.smplkit.com",
    headers: { Authorization: "Bearer sk_test", Accept: "application/json" },
  });
}

type WsCallback = (data: Record<string, unknown>) => void;

interface MockSharedWs {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  connectionStatus: string;
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
      const arr = listeners[event];
      if (arr) {
        const i = arr.indexOf(cb);
        if (i !== -1) arr.splice(i, 1);
      }
    }),
    stop: vi.fn(),
    start: vi.fn(),
    connectionStatus: "connected",
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
  };
}

let lastMockWs: MockSharedWs;
let lastEnsureStarted: ReturnType<typeof vi.fn>;
let lastEnsureWs: ReturnType<typeof vi.fn>;

function makeParent(overrides: Partial<LoggingParent> = {}): LoggingParent {
  lastMockWs = createMockSharedWs();
  lastEnsureStarted = vi.fn();
  lastEnsureWs = vi.fn(() => lastMockWs as unknown as SharedWebSocket);
  return {
    _environment: "production",
    _service: "svc",
    _ensureStarted: lastEnsureStarted,
    _ensureWs: lastEnsureWs,
    ...overrides,
  };
}

/** Wired client (borrows a parent transport + parent WebSocket). */
function makeWiredClient(parentOverrides: Partial<LoggingParent> = {}): LoggingClient {
  return new LoggingClient({
    parent: makeParent(parentOverrides),
    transport: makeTransport(),
    metrics: null,
  });
}

function loggerResource(id: string, attrs: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: "logger",
    attributes: {
      name: id,
      level: null,
      group: null,
      managed: true,
      sources: [],
      environments: {},
      created_at: null,
      updated_at: null,
      ...attrs,
    },
  };
}

function logGroupResource(
  id: string,
  attrs: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: "log_group",
    attributes: {
      name: id,
      level: null,
      parent_id: null,
      environments: {},
      created_at: null,
      updated_at: null,
      ...attrs,
    },
  };
}

function makeAdapter(overrides?: Partial<LoggingAdapter>): LoggingAdapter {
  return {
    name: "mock",
    discover: vi.fn(() => []),
    applyLevel: vi.fn(),
    installHook: vi.fn(),
    uninstallHook: vi.fn(),
    ...overrides,
  };
}

// ===========================================================================
// LoggerRegistrationBuffer
// ===========================================================================

describe("LoggerRegistrationBuffer", () => {
  it("adds a new entry and reports pendingCount", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("sql", "DEBUG", "DEBUG", "svc", "production");
    expect(buf.pendingCount).toBe(1);
  });

  it("deduplicates entries with the same id", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("sql", "DEBUG", "DEBUG", "svc", "production");
    buf.add("sql", "WARN", "WARN", "svc", "production");
    expect(buf.pendingCount).toBe(1);
  });

  it("adds multiple distinct entries", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("a", "INFO", "INFO", null, null);
    buf.add("b", "INFO", "INFO", null, null);
    expect(buf.pendingCount).toBe(2);
  });

  it("drain() returns all pending entries and resets to empty", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("a", "INFO", "INFO", "svc", "production");
    const batch = buf.drain();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual({
      id: "a",
      level: "INFO",
      resolved_level: "INFO",
      service: "svc",
      environment: "production",
    });
    expect(buf.pendingCount).toBe(0);
  });

  it("drain() on empty buffer returns empty array", () => {
    const buf = new LoggerRegistrationBuffer();
    expect(buf.drain()).toEqual([]);
  });

  it("omits service/environment when null", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("a", "INFO", "INFO", null, null);
    const [item] = buf.drain();
    expect(item).toEqual({ id: "a", level: "INFO", resolved_level: "INFO" });
    expect("service" in item).toBe(false);
    expect("environment" in item).toBe(false);
  });

  it("previously-drained ids remain deduplicated", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add("a", "INFO", "INFO", null, null);
    buf.drain();
    buf.add("a", "WARN", "WARN", null, null);
    expect(buf.pendingCount).toBe(0);
  });
});

// ===========================================================================
// LoggersClient — CRUD
// ===========================================================================

describe("LoggersClient", () => {
  function makeClient(): LoggingClient {
    return makeWiredClient();
  }

  describe("new()", () => {
    it("returns an unsaved Logger with defaults", () => {
      const client = makeClient();
      const logger = client.loggers.new("sql.engine");
      expect(logger).toBeInstanceOf(Logger);
      expect(logger.id).toBe("sql.engine");
      expect(logger.name).toBe("sql.engine");
      expect(logger.managed).toBe(true);
    });

    it("honours the managed option", () => {
      const client = makeClient();
      const logger = client.loggers.new("sql.engine", { managed: false });
      expect(logger.managed).toBe(false);
    });
  });

  describe("list()", () => {
    it("returns Logger models from the collection", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [loggerResource("a"), loggerResource("b")] }),
      );
      const loggers = await client.loggers.list();
      expect(loggers.map((l) => l.id)).toEqual(["a", "b"]);
      expect(loggers[0]).toBeInstanceOf(Logger);
    });

    it("forwards pagination query params", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await client.loggers.list({ pageNumber: 2, pageSize: 50 });
      const url = mockFetch.mock.calls[0][0].url as string;
      expect(url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
      expect(url).toMatch(/page(\[|%5B)size(\]|%5D)=50/);
    });

    it("returns [] when the response has no body", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect(await client.loggers.list()).toEqual([]);
    });

    it("surfaces server errors via SmplError", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("boom", 500));
      await expect(client.loggers.list()).rejects.toThrow(SmplError);
    });

    it("maps sources that are not arrays to []", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [loggerResource("a", { sources: "nope" })] }),
      );
      const [logger] = await client.loggers.list();
      expect(logger.sources).toEqual([]);
    });
  });

  describe("get()", () => {
    it("fetches a single logger by id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: loggerResource("sql") }));
      const logger = await client.loggers.get("sql");
      expect(logger.id).toBe("sql");
    });

    it("throws SmplNotFoundError when the body has no data", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
      await expect(client.loggers.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("surfaces a 404 from the server", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("nope", 404));
      await expect(client.loggers.get("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  describe("delete()", () => {
    it("DELETEs the logger by id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await client.loggers.delete("sql");
      const req = mockFetch.mock.calls[0][0] as Request;
      expect(req.method).toBe("DELETE");
      expect(req.url).toContain("/api/v1/loggers/sql");
    });

    it("treats a 200 as success", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await expect(client.loggers.delete("sql")).resolves.toBeUndefined();
    });

    it("surfaces a non-204 error status", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("conflict", 409));
      await expect(client.loggers.delete("sql")).rejects.toThrow(SmplError);
    });
  });

  describe("_saveLogger() (via Logger.save)", () => {
    it("PUTs the logger body and returns the refreshed model", async () => {
      const client = makeClient();
      const logger = client.loggers.new("sql");
      logger.setLevel(LogLevel.WARN);
      logger.setLevel(LogLevel.ERROR, { environment: "production" });
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: loggerResource("sql", { level: "WARN" }) }),
      );
      await logger.save();
      const req = mockFetch.mock.calls[0][0] as Request;
      expect(req.method).toBe("PUT");
      const body = JSON.parse(await req.text());
      expect(body.data.attributes.level).toBe("WARN");
      expect(body.data.attributes.environments).toEqual({ production: { level: "ERROR" } });
      expect(logger.level).toBe("WARN");
    });

    it("includes group and managed flags when set", async () => {
      const client = makeClient();
      const logger = client.loggers.new("sql");
      logger.group = "db";
      logger.managed = false;
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: loggerResource("sql") }));
      await logger.save();
      const body = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
      expect(body.data.attributes.group).toBe("db");
      expect(body.data.attributes.managed).toBe(false);
    });

    it("throws when saving a logger with a null id", async () => {
      const client = makeClient();
      const logger = new Logger(client.loggers, { id: null, name: "anon" });
      await expect(logger.save()).rejects.toThrow(/Cannot save a Logger with no id/);
    });

    it("throws SmplValidationError when the response has no data", async () => {
      const client = makeClient();
      const logger = client.loggers.new("sql");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
      await expect(logger.save()).rejects.toThrow(SmplValidationError);
    });

    it("surfaces a server error during save", async () => {
      const client = makeClient();
      const logger = client.loggers.new("sql");
      mockFetch.mockResolvedValueOnce(textResponse("bad", 422));
      await expect(logger.save()).rejects.toThrow(SmplValidationError);
    });
  });

  describe("register() + flush() + pendingCount", () => {
    it("buffers a single source and reports pendingCount", async () => {
      const client = makeClient();
      await client.loggers.register(
        new LoggerSource("sql", { resolvedLevel: LogLevel.WARN, service: "svc" }),
      );
      expect(client.loggers.pendingCount).toBe(1);
      expect(client._buffer.pendingCount).toBe(1);
    });

    it("buffers an array of sources", async () => {
      const client = makeClient();
      await client.loggers.register([
        new LoggerSource("a", { resolvedLevel: LogLevel.INFO }),
        new LoggerSource("b", { resolvedLevel: LogLevel.INFO }),
      ]);
      expect(client.loggers.pendingCount).toBe(2);
    });

    it("uses resolvedLevel as the level when no explicit level given", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 1 }));
      await client.loggers.register(
        new LoggerSource("a", { resolvedLevel: LogLevel.WARN, service: "svc" }),
        { flush: true },
      );
      const body = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
      expect(body.loggers[0].level).toBe("WARN");
      expect(body.loggers[0].resolved_level).toBe("WARN");
    });

    it("flushes immediately when { flush: true }", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 1 }));
      await client.loggers.register(new LoggerSource("a", { resolvedLevel: LogLevel.INFO }), {
        flush: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const req = mockFetch.mock.calls[0][0] as Request;
      expect(req.url).toContain("/api/v1/loggers/bulk");
      expect(client.loggers.pendingCount).toBe(0);
    });

    it("flush() is a no-op when the buffer is empty", async () => {
      const client = makeClient();
      await client.loggers.flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("flush() swallows a POST error", async () => {
      const client = makeClient();
      await client.loggers.register(new LoggerSource("a", { resolvedLevel: LogLevel.INFO }));
      mockFetch.mockRejectedValueOnce(new Error("network"));
      await expect(client.loggers.flush()).resolves.toBeUndefined();
    });

    it("auto-flushes when the buffer reaches the batch size of 50", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));
      const sources = Array.from(
        { length: 50 },
        (_, i) => new LoggerSource(`logger-${i}`, { resolvedLevel: LogLevel.INFO }),
      );
      await client.loggers.register(sources);
      // The void flush() fires asynchronously; allow it to run.
      await new Promise((r) => setTimeout(r, 10));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0].url).toContain("/api/v1/loggers/bulk");
    });
  });
});

// ===========================================================================
// LogGroupsClient — CRUD
// ===========================================================================

describe("LogGroupsClient", () => {
  function makeClient(): LoggingClient {
    return makeWiredClient();
  }

  describe("new()", () => {
    it("returns an unsaved LogGroup with a humanized default name", () => {
      const client = makeClient();
      const group = client.logGroups.new("database-loggers");
      expect(group).toBeInstanceOf(LogGroup);
      expect(group.id).toBe("database-loggers");
      expect(group.name).toBe("Database Loggers");
    });

    it("honours explicit name and group options", () => {
      const client = makeClient();
      const group = client.logGroups.new("db", { name: "DB", group: "parent" });
      expect(group.name).toBe("DB");
      expect(group.group).toBe("parent");
    });
  });

  describe("list()", () => {
    it("returns LogGroup models", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [logGroupResource("g1"), logGroupResource("g2")] }),
      );
      const groups = await client.logGroups.list();
      expect(groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    });

    it("forwards pagination params", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await client.logGroups.list({ pageNumber: 3, pageSize: 10 });
      const url = mockFetch.mock.calls[0][0].url as string;
      expect(url).toMatch(/page(\[|%5B)number(\]|%5D)=3/);
      expect(url).toMatch(/page(\[|%5B)size(\]|%5D)=10/);
    });

    it("returns [] when the body is empty", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect(await client.logGroups.list()).toEqual([]);
    });

    it("maps parent_id to the group field", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [logGroupResource("g1", { parent_id: "root", level: "WARN" })] }),
      );
      const [group] = await client.logGroups.list();
      expect(group.group).toBe("root");
      expect(group.level).toBe("WARN");
    });

    it("surfaces server errors", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("boom", 500));
      await expect(client.logGroups.list()).rejects.toThrow(SmplError);
    });
  });

  describe("get()", () => {
    it("fetches a single group", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: logGroupResource("g1") }));
      const group = await client.logGroups.get("g1");
      expect(group.id).toBe("g1");
    });

    it("throws SmplNotFoundError when no data", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
      await expect(client.logGroups.get("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  describe("delete()", () => {
    it("DELETEs the group by id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await client.logGroups.delete("g1");
      const req = mockFetch.mock.calls[0][0] as Request;
      expect(req.method).toBe("DELETE");
      expect(req.url).toContain("/api/v1/log_groups/g1");
    });

    it("surfaces a non-204 error", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("conflict", 409));
      await expect(client.logGroups.delete("g1")).rejects.toThrow(SmplError);
    });
  });

  describe("_createGroup() (via LogGroup.save on a new group)", () => {
    it("POSTs a create body and applies the result", async () => {
      const client = makeClient();
      const group = client.logGroups.new("db");
      group.setLevel(LogLevel.WARN);
      group.setLevel(LogLevel.ERROR, { environment: "production" });
      group.group = "parent";
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: logGroupResource("db", { created_at: "2026-01-01T00:00:00Z" }) }),
      );
      await group.save();
      const req = mockFetch.mock.calls[0][0] as Request;
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v1/log_groups");
      const body = JSON.parse(await req.text());
      expect(body.data.id).toBe("db");
      expect(body.data.attributes.level).toBe("WARN");
      expect(body.data.attributes.parent_id).toBe("parent");
      expect(body.data.attributes.environments).toEqual({ production: { level: "ERROR" } });
      expect(group.createdAt).toBe("2026-01-01T00:00:00Z");
    });

    it("omits environments from the body when there are no overrides", async () => {
      const client = makeClient();
      const group = client.logGroups.new("db");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: logGroupResource("db") }));
      await group.save();
      const body = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
      expect("environments" in body.data.attributes).toBe(false);
    });

    it("throws SmplValidationError when the create response has no data", async () => {
      const client = makeClient();
      const group = client.logGroups.new("db");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
      await expect(group.save()).rejects.toThrow(SmplValidationError);
    });
  });

  describe("_updateGroup() (via LogGroup.save on an existing group)", () => {
    it("PUTs an update body and applies the result", async () => {
      const client = makeClient();
      const group = new LogGroup(client.logGroups, {
        id: "db",
        name: "DB",
        level: LogLevel.WARN,
        createdAt: "2026-01-01T00:00:00Z",
      });
      group.name = "Database";
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: logGroupResource("db", {
            name: "Database",
            level: "WARN",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-02-01T00:00:00Z",
          }),
        }),
      );
      await group.save();
      const req = mockFetch.mock.calls[0][0] as Request;
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/log_groups/db");
      expect(group.name).toBe("Database");
      expect(group.updatedAt).toBe("2026-02-01T00:00:00Z");
    });

    it("throws when updating a group with a null id", async () => {
      const client = makeClient();
      const group = new LogGroup(client.logGroups, {
        id: null,
        name: "DB",
        createdAt: "2026-01-01T00:00:00Z",
      });
      await expect(group.save()).rejects.toThrow(/Cannot update a LogGroup with no id/);
    });

    it("throws SmplValidationError when the update response has no data", async () => {
      const client = makeClient();
      const group = new LogGroup(client.logGroups, {
        id: "db",
        name: "DB",
        createdAt: "2026-01-01T00:00:00Z",
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }));
      await expect(group.save()).rejects.toThrow(SmplValidationError);
    });
  });
});

// ===========================================================================
// Error wrapping
// ===========================================================================

describe("LoggingClient — fetch-error wrapping", () => {
  it("wraps a TypeError as SmplConnectionError", async () => {
    const client = makeWiredClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.loggers.list()).rejects.toThrow(SmplConnectionError);
  });

  it("wraps a generic Error as SmplConnectionError", async () => {
    const client = makeWiredClient();
    mockFetch.mockRejectedValueOnce(new Error("kaput"));
    await expect(client.loggers.list()).rejects.toThrow(SmplConnectionError);
  });

  it("rethrows a typed SDK error unchanged", async () => {
    const client = makeWiredClient();
    mockFetch.mockResolvedValueOnce(textResponse("nope", 404));
    await expect(client.loggers.get("x")).rejects.toThrow(SmplNotFoundError);
  });
});

// ===========================================================================
// install() / registerAdapter / live-surface gating
// ===========================================================================

describe("LoggingClient — install() and the live-surface gate", () => {
  it("install() is idempotent and wires all five WS handlers", async () => {
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter());
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    await client.install(); // no-op second call
    expect(lastEnsureStarted).toHaveBeenCalled();
    for (const evt of [
      "logger_changed",
      "logger_deleted",
      "group_changed",
      "group_deleted",
      "loggers_changed",
    ]) {
      expect(lastMockWs.on).toHaveBeenCalledWith(evt, expect.any(Function));
    }
  });

  it("onChange() throws SmplNotInstalledError before install()", () => {
    const client = makeWiredClient();
    expect(() => client.onChange(() => {})).toThrow(SmplNotInstalledError);
  });

  it("refresh() throws SmplNotInstalledError before install()", async () => {
    const client = makeWiredClient();
    await expect(client.refresh()).rejects.toThrow(SmplNotInstalledError);
  });

  it("registerAdapter() before install() is allowed and disables auto-load", async () => {
    const client = makeWiredClient();
    const adapter = makeAdapter();
    client.registerAdapter(adapter);
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(adapter.discover).toHaveBeenCalled();
    expect(adapter.installHook).toHaveBeenCalled();
  });

  it("registerAdapter() after install() throws a plain Error", async () => {
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter());
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(() => client.registerAdapter(makeAdapter())).toThrow(
      "Cannot register adapters after install()",
    );
  });

  it("discovers loggers from adapters and applies fetched levels", async () => {
    const client = makeWiredClient();
    const adapter = makeAdapter({
      discover: vi.fn(() => [{ name: "my-app", level: "INFO" }]),
    });
    client.registerAdapter(adapter);
    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/loggers/bulk")) {
        return Promise.resolve(jsonResponse({ registered: 1 }));
      }
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(
          jsonResponse({ data: [loggerResource("my-app", { level: "WARN" })] }),
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    await client.install();
    expect(adapter.applyLevel).toHaveBeenCalledWith("my-app", "WARN");
  });

  it("applies an environment-specific override during install", async () => {
    const client = makeWiredClient();
    const adapter = makeAdapter({
      discover: vi.fn(() => [{ name: "my-app", level: "INFO" }]),
    });
    client.registerAdapter(adapter);
    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/loggers/bulk")) return Promise.resolve(jsonResponse({ registered: 1 }));
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              loggerResource("my-app", {
                level: "INFO",
                environments: { production: { level: "ERROR" } },
              }),
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    await client.install();
    expect(adapter.applyLevel).toHaveBeenCalledWith("my-app", "ERROR");
  });

  it("swallows adapter discover() errors", async () => {
    const client = makeWiredClient();
    client.registerAdapter(
      makeAdapter({
        discover: vi.fn(() => {
          throw new Error("discover boom");
        }),
      }),
    );
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await expect(client.install()).resolves.toBeUndefined();
  });

  it("swallows adapter installHook() errors", async () => {
    const client = makeWiredClient();
    client.registerAdapter(
      makeAdapter({
        installHook: vi.fn(() => {
          throw new Error("hook boom");
        }),
      }),
    );
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await expect(client.install()).resolves.toBeUndefined();
  });

  it("swallows adapter applyLevel() errors during install", async () => {
    const client = makeWiredClient();
    const adapter = makeAdapter({
      discover: vi.fn(() => [{ name: "my-app", level: "INFO" }]),
      applyLevel: vi.fn(() => {
        throw new Error("apply boom");
      }),
    });
    client.registerAdapter(adapter);
    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/loggers/bulk")) return Promise.resolve(jsonResponse({ registered: 1 }));
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(
          jsonResponse({ data: [loggerResource("my-app", { level: "WARN" })] }),
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    await expect(client.install()).resolves.toBeUndefined();
    expect(adapter.applyLevel).toHaveBeenCalled();
  });

  it("continues when the server is unreachable during install", async () => {
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter());
    mockFetch.mockRejectedValue(new TypeError("network error"));
    await expect(client.install()).resolves.toBeUndefined();
    // WS handlers are still wired.
    expect(lastMockWs.on).toHaveBeenCalledWith("logger_changed", expect.any(Function));
  });

  it("records a discovery metric when loggers are discovered", async () => {
    const metrics = { record: vi.fn(), recordGauge: vi.fn() } as any;
    const client = new LoggingClient({ parent: makeParent(), transport: makeTransport(), metrics });
    client.registerAdapter(
      makeAdapter({ discover: vi.fn(() => [{ name: "my-app", level: "INFO" }]) }),
    );
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(metrics.record).toHaveBeenCalledWith("logging.loggers_discovered", 1, "loggers");
  });

  it("auto-loads built-in adapters when none are registered", async () => {
    // winston + pino are devDependencies, so autoLoadAdapters succeeds and
    // returns real adapters; install() must complete and wire the WS.
    const client = makeWiredClient();
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(lastMockWs.on).toHaveBeenCalledWith("logger_changed", expect.any(Function));
  });
});

// ===========================================================================
// _onNewLogger — runtime discovery hook
// ===========================================================================

describe("LoggingClient — runtime logger discovery (_onNewLogger)", () => {
  it("buffers a newly-seen logger from the adapter hook and applies its level", async () => {
    const client = makeWiredClient();
    let hookCb: ((name: string, level: string) => void) | null = null;
    const adapter = makeAdapter({
      installHook: vi.fn((cb: (name: string, level: string) => void) => {
        hookCb = cb;
      }),
    });
    client.registerAdapter(adapter);
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();

    expect(hookCb).not.toBeNull();
    hookCb!("runtime.logger", "DEBUG");
    expect(client._buffer.pendingCount).toBe(1);
    // Already connected → an immediate applyLevel happens (resolves to INFO).
    expect(adapter.applyLevel).toHaveBeenCalledWith("runtime.logger", "INFO");
  });

  it("swallows applyLevel errors on a runtime-discovered logger", async () => {
    const client = makeWiredClient();
    let hookCb: ((name: string, level: string) => void) | null = null;
    const adapter = makeAdapter({
      installHook: vi.fn((cb: (name: string, level: string) => void) => {
        hookCb = cb;
      }),
      applyLevel: vi.fn(() => {
        throw new Error("apply boom");
      }),
    });
    client.registerAdapter(adapter);
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(() => hookCb!("runtime.logger", "DEBUG")).not.toThrow();
  });

  it("triggers an immediate flush when runtime discovery crosses the batch threshold", async () => {
    const client = makeWiredClient();
    let hookCb: ((name: string, level: string) => void) | null = null;
    const adapter = makeAdapter({
      installHook: vi.fn((cb: (name: string, level: string) => void) => {
        hookCb = cb;
      }),
    });
    client.registerAdapter(adapter);
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));

    for (let i = 0; i < 50; i++) hookCb!(`runtime.logger.${i}`, "INFO");
    await new Promise((r) => setTimeout(r, 10));
    const bulkCalls = mockFetch.mock.calls.filter((c) =>
      (c[0] as Request).url.includes("/loggers/bulk"),
    );
    expect(bulkCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// onChange validation + refresh
// ===========================================================================

describe("LoggingClient — onChange() / refresh()", () => {
  async function installed(): Promise<LoggingClient> {
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter({ discover: () => [{ name: "sql", level: "INFO" }] }));
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    mockFetch.mockReset();
    return client;
  }

  it("registers a global listener", async () => {
    const client = await installed();
    expect(() => client.onChange(() => {})).not.toThrow();
  });

  it("registers a key-scoped listener", async () => {
    const client = await installed();
    expect(() => client.onChange("sql", () => {})).not.toThrow();
  });

  it("appends to an existing key-scoped listener bucket", async () => {
    const client = await installed();
    client.onChange("sql", () => {});
    expect(() => client.onChange("sql", () => {})).not.toThrow();
  });

  it("throws when a key-scoped onChange is missing its callback", async () => {
    const client = await installed();
    expect(() => client.onChange("sql")).toThrow(SmplError);
  });

  it("refresh() re-fetches and fires 'manual' deltas", async () => {
    const client = await installed();
    const cb = vi.fn();
    client.onChange(cb);
    mockFetch.mockImplementation((req: Request) => {
      if (req.url.includes("/loggers") && !req.url.endsWith("/log_groups")) {
        return Promise.resolve(jsonResponse({ data: [loggerResource("sql", { level: "DEBUG" })] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    await client.refresh();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].source).toBe("manual");
    expect(cb.mock.calls[0][0].level).toBe("DEBUG");
  });

  it("refresh() propagates fetch errors (does not swallow)", async () => {
    const client = await installed();
    mockFetch.mockResolvedValue(textResponse("boom", 500));
    await expect(client.refresh()).rejects.toThrow(SmplError);
  });
});

// ===========================================================================
// WebSocket handlers
// ===========================================================================

describe("LoggingClient — WebSocket handlers", () => {
  async function installedWithLoggers(names: string[]): Promise<LoggingClient> {
    const client = makeWiredClient();
    client.registerAdapter({
      name: "t",
      discover: () => names.map((name) => ({ name, level: "INFO" })),
      applyLevel: vi.fn(),
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    mockFetch.mockReset();
    return client;
  }

  it("logger_changed: refetches and fires when the level changed", async () => {
    const client = await installedWithLoggers(["sql"]);
    const cb = vi.fn();
    client.onChange(cb);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: loggerResource("sql", { level: "DEBUG" }) }),
    );
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 20));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ id: "sql", level: "DEBUG" }));
  });

  it("logger_changed: ignores an event with no id", async () => {
    const client = await installedWithLoggers(["sql"]);
    const cb = vi.fn();
    client.onChange(cb);
    lastMockWs._emit("logger_changed", {});
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
  });

  it("logger_changed: a null scoped fetch evicts the logger from the cache", async () => {
    const client = await installedWithLoggers(["sql"]);
    const cb = vi.fn();
    client.onChange(cb);
    // 404 on the scoped fetch → _fetchSingleLogger returns null → eviction.
    mockFetch.mockResolvedValueOnce(textResponse("nope", 404));
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("logger_deleted: evicts the cache; the deleted id fires nothing", async () => {
    const client = await installedWithLoggers(["sql"]);
    const cb = vi.fn();
    const sqlCb = vi.fn();
    client.onChange(cb);
    client.onChange("sql", sqlCb);
    lastMockWs._emit("logger_deleted", { id: "sql" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sqlCb).not.toHaveBeenCalled();
  });

  it("logger_deleted: ignores an event with no id", async () => {
    await installedWithLoggers(["sql"]);
    lastMockWs._emit("logger_deleted", {});
    await new Promise((r) => setTimeout(r, 10));
  });

  it("group_changed: refetches and re-applies without throwing", async () => {
    const client = await installedWithLoggers(["app.db"]);
    const cb = vi.fn();
    client.onChange(cb);
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: logGroupResource("app", { level: "ERROR" }) }),
    );
    lastMockWs._emit("group_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("group_changed: ignores an event with no id", async () => {
    await installedWithLoggers(["app.db"]);
    lastMockWs._emit("group_changed", {});
    await new Promise((r) => setTimeout(r, 10));
  });

  it("group_changed: a null scoped fetch evicts the group from the cache", async () => {
    await installedWithLoggers(["app.db"]);
    mockFetch.mockResolvedValueOnce(textResponse("nope", 404));
    lastMockWs._emit("group_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("group_deleted: evicts the group cache; deleted id fires nothing", async () => {
    const client = await installedWithLoggers(["app.db"]);
    const groupCb = vi.fn();
    client.onChange("app", groupCb);
    lastMockWs._emit("group_deleted", { id: "app" });
    await new Promise((r) => setTimeout(r, 10));
    expect(groupCb).not.toHaveBeenCalled();
  });

  it("group_deleted: ignores an event with no id", async () => {
    await installedWithLoggers(["app.db"]);
    lastMockWs._emit("group_deleted", {});
    await new Promise((r) => setTimeout(r, 10));
  });

  it("loggers_changed: triggers a full re-resolution and fires deltas", async () => {
    const client = await installedWithLoggers(["sql"]);
    const cb = vi.fn();
    client.onChange(cb);
    mockFetch.mockImplementation((req: Request) => {
      if (req.url.includes("/loggers") && !req.url.endsWith("/log_groups")) {
        return Promise.resolve(jsonResponse({ data: [loggerResource("sql", { level: "WARN" })] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ id: "sql", level: "WARN" }));
  });

  it("loggers_changed: swallows fetch errors", async () => {
    const client = await installedWithLoggers(["sql"]);
    const cb = vi.fn();
    client.onChange(cb);
    mockFetch.mockResolvedValue(textResponse("boom", 500));
    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(cb).not.toHaveBeenCalled();
  });

  it("swallows errors thrown by a global listener", async () => {
    const client = await installedWithLoggers(["sql"]);
    client.onChange(() => {
      throw new Error("listener boom");
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: loggerResource("sql", { level: "DEBUG" }) }),
    );
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("swallows errors thrown by a key-scoped listener", async () => {
    const client = await installedWithLoggers(["sql"]);
    client.onChange("sql", () => {
      throw new Error("key listener boom");
    });
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: loggerResource("sql", { level: "DEBUG" }) }),
    );
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 20));
  });
});

// ===========================================================================
// Paging in _listLoggers / _listLogGroups (via install)
// ===========================================================================

describe("LoggingClient — paging on install", () => {
  it("pages loggers and groups until a short page is returned", async () => {
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter());
    const PAGE = 1000;
    const fullLoggers = Array.from({ length: PAGE }, (_, i) => loggerResource(`l-${i}`));
    const fullGroups = Array.from({ length: PAGE }, (_, i) => logGroupResource(`g-${i}`));
    let loggerPage = 0;
    let groupPage = 0;
    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/log_groups")) {
        groupPage++;
        return Promise.resolve(
          jsonResponse({ data: groupPage === 1 ? fullGroups : [logGroupResource("g-last")] }),
        );
      }
      if (url.includes("/loggers") && !url.includes("/bulk")) {
        loggerPage++;
        return Promise.resolve(
          jsonResponse({ data: loggerPage === 1 ? fullLoggers : [loggerResource("l-last")] }),
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
    await client.install();
    expect(loggerPage).toBe(2);
    expect(groupPage).toBe(2);
  });
});

// ===========================================================================
// close()
// ===========================================================================

describe("LoggingClient — close()", () => {
  it("unregisters all five WS handlers and uninstalls adapter hooks", async () => {
    const client = makeWiredClient();
    const adapter = makeAdapter();
    client.registerAdapter(adapter);
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    client.close();
    expect(adapter.uninstallHook).toHaveBeenCalledTimes(1);
    for (const evt of [
      "logger_changed",
      "logger_deleted",
      "group_changed",
      "group_deleted",
      "loggers_changed",
    ]) {
      expect(lastMockWs.off).toHaveBeenCalledWith(evt, expect.any(Function));
    }
  });

  it("does not stop the parent's WebSocket (wired client borrows it)", async () => {
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter());
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    client.close();
    expect(lastMockWs.stop).not.toHaveBeenCalled();
  });

  it("swallows adapter uninstallHook() errors", async () => {
    const client = makeWiredClient();
    client.registerAdapter(
      makeAdapter({
        uninstallHook: vi.fn(() => {
          throw new Error("unhook boom");
        }),
      }),
    );
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(() => client.close()).not.toThrow();
  });

  it("is a no-op when called before install()", () => {
    const client = makeWiredClient();
    expect(() => client.close()).not.toThrow();
  });

  it("allows install() again after close()", async () => {
    const client = makeWiredClient();
    client.registerAdapter(makeAdapter());
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    client.close();
    await expect(client.install()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Standalone construction (owns its transport + WebSocket)
// ===========================================================================

describe("LoggingClient — standalone construction", () => {
  it("builds its own transport from an apiKey and sends a Bearer token", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });
    const client = new LoggingClient({
      apiKey: "sk_standalone",
      environment: "production",
      baseUrl: "https://logging.example.com/",
      extraHeaders: { "X-Test": "v" },
    });
    await client.loggers.list();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toContain("logging.example.com");
    expect(seen[0].headers.get("authorization")).toBe("Bearer sk_standalone");
    expect(seen[0].headers.get("x-test")).toBe("v");
  });

  it("maps a request timeout (AbortError) to SmplTimeoutError", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    const client = new LoggingClient({
      apiKey: "sk_standalone",
      environment: "production",
      baseUrl: "https://logging.example.com",
      timeout: 5,
    });
    await expect(client.loggers.list()).rejects.toThrow(SmplTimeoutError);
  });

  it("rethrows non-abort fetch errors from the timeout wrapper", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("network down"));
    const client = new LoggingClient({
      apiKey: "sk_standalone",
      environment: "production",
      baseUrl: "https://logging.example.com",
    });
    await expect(client.loggers.list()).rejects.toThrow(SmplConnectionError);
  });

  it("opens and owns its own WebSocket on install, and stops it on close", async () => {
    const fakeWs = createMockSharedWs();
    const startSpy = fakeWs.start;
    const stopSpy = fakeWs.stop;
    const SharedWsModule = await import("../../../src/ws.js");
    const ctorSpy = vi
      .spyOn(SharedWsModule, "SharedWebSocket")
      .mockImplementation(() => fakeWs as unknown as SharedWebSocket);

    const client = new LoggingClient({
      apiKey: "sk_standalone",
      environment: "production",
      baseUrl: "https://logging.example.com",
    });
    client.registerAdapter(makeAdapter());
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.install();
    expect(ctorSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledTimes(1);

    client.close();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
