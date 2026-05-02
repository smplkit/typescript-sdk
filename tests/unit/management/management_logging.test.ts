/**
 * Tests for LoggersClient (mgmt.loggers.*), LogGroupsClient (mgmt.logGroups.*),
 * and LoggerRegistrationBuffer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplManagementClient } from "../../../src/management/client.js";
import {
  LoggersClient,
  LogGroupsClient,
  LoggerRegistrationBuffer,
} from "../../../src/management/logging.js";
import { Logger, LogGroup } from "../../../src/logging/models.js";
import { LogLevel, LoggerSource, LoggerEnvironment } from "../../../src/logging/types.js";
import {
  SmplNotFoundError,
  SmplConnectionError,
  SmplValidationError,
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

const API_KEY = "sk_log_test";

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

const SAMPLE_LOGGER = {
  id: "sqlalchemy.engine",
  type: "logger",
  attributes: {
    name: "sqlalchemy.engine",
    level: "WARN",
    group: "db",
    managed: true,
    sources: [{ service: "api", environment: "production", resolved_level: "WARN" }],
    environments: { production: { level: "ERROR" } },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
  },
};

const SAMPLE_BARE_LOGGER = {
  id: "minimal",
  type: "logger",
  attributes: {
    // intentionally minimal — exercises null fall-throughs
  },
};

const SAMPLE_LOG_GROUP = {
  id: "db",
  type: "log_group",
  attributes: {
    name: "Database",
    level: "INFO",
    parent_id: null,
    environments: { production: { level: "WARN" } },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
  },
};

const SAMPLE_BARE_LOG_GROUP = {
  id: "minimal-group",
  type: "log_group",
  attributes: {},
};

// ===========================================================================
// LoggerRegistrationBuffer
// ===========================================================================

describe("LoggerRegistrationBuffer", () => {
  it("add() queues a source", () => {
    const buf = new LoggerRegistrationBuffer();
    const src = new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO });
    buf.add(src);
    expect(buf.pendingCount).toBe(1);
  });

  it("add() deduplicates by name", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add(new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }));
    buf.add(new LoggerSource("logger.a", { resolvedLevel: LogLevel.WARN }));
    expect(buf.pendingCount).toBe(1);
  });

  it("drain() returns pending items and clears", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add(new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }));
    buf.add(new LoggerSource("logger.b", { resolvedLevel: LogLevel.DEBUG }));
    const batch = buf.drain();
    expect(batch).toHaveLength(2);
    expect(buf.pendingCount).toBe(0);
  });

  it("preserves level/service/environment when set", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add(
      new LoggerSource("logger.a", {
        resolvedLevel: LogLevel.INFO,
        level: LogLevel.WARN,
        service: "svc",
        environment: "prod",
      }),
    );
    const batch = buf.drain();
    expect(batch[0]).toMatchObject({
      id: "logger.a",
      resolved_level: LogLevel.INFO,
      level: LogLevel.WARN,
      service: "svc",
      environment: "prod",
    });
  });

  it("omits level/service/environment when null", () => {
    const buf = new LoggerRegistrationBuffer();
    buf.add(new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }));
    const batch = buf.drain();
    expect(batch[0]).toMatchObject({ id: "logger.a", resolved_level: LogLevel.INFO });
    expect(batch[0].level).toBeUndefined();
    expect(batch[0].service).toBeUndefined();
    expect(batch[0].environment).toBeUndefined();
  });

  it("drains an empty buffer to an empty array", () => {
    const buf = new LoggerRegistrationBuffer();
    expect(buf.drain()).toEqual([]);
  });
});

// ===========================================================================
// LoggersClient.new()
// ===========================================================================

describe("LoggersClient.new()", () => {
  it("returns an unsaved Logger with managed=true by default", () => {
    const client = makeClient();
    const logger = client.loggers.new("sqlalchemy.engine");
    expect(logger).toBeInstanceOf(Logger);
    expect(logger.id).toBe("sqlalchemy.engine");
    expect(logger.name).toBe("sqlalchemy.engine");
    expect(logger.managed).toBe(true);
    expect(logger.level).toBeNull();
    expect(logger.group).toBeNull();
    expect(logger.sources).toEqual([]);
    expect(logger.createdAt).toBeNull();
  });

  it("accepts managed=false", () => {
    const client = makeClient();
    const logger = client.loggers.new("sqlalchemy.engine", { managed: false });
    expect(logger.managed).toBe(false);
  });
});

// ===========================================================================
// LoggersClient.list() / get()
// ===========================================================================

describe("LoggersClient.list()", () => {
  it("returns an array of Loggers", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_LOGGER] }));

    const loggers = await client.loggers.list();
    expect(loggers).toHaveLength(1);
    expect(loggers[0]).toBeInstanceOf(Logger);
    expect(loggers[0].id).toBe("sqlalchemy.engine");
    expect(loggers[0].level).toBe(LogLevel.WARN);
    expect(loggers[0].group).toBe("db");
    expect(loggers[0].managed).toBe(true);
    expect(loggers[0].sources).toHaveLength(1);
  });

  it("returns empty array when no data", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const loggers = await client.loggers.list();
    expect(loggers).toEqual([]);
  });

  it("issues GET to /api/v1/loggers", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.loggers.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/loggers");
  });

  it("handles a logger with bare attributes", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_BARE_LOGGER] }));
    const loggers = await client.loggers.list();
    expect(loggers[0].id).toBe("minimal");
    expect(loggers[0].name).toBe("");
    expect(loggers[0].level).toBeNull();
    expect(loggers[0].group).toBeNull();
    expect(loggers[0].managed).toBeNull();
    expect(loggers[0].sources).toEqual([]);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.loggers.list()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplConnectionError on generic error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    await expect(client.loggers.list()).rejects.toThrow(SmplConnectionError);
  });

  it("wraps non-Error rejections (string)", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce("string-rejection");
    await expect(client.loggers.list()).rejects.toThrow(SmplConnectionError);
  });

  it("propagates SmplValidationError on 422", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("invalid", 422));
    await expect(client.loggers.list()).rejects.toThrow(SmplValidationError);
  });
});

describe("LoggersClient.get()", () => {
  it("returns a Logger by id", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));

    const logger = await client.loggers.get("sqlalchemy.engine");
    expect(logger).toBeInstanceOf(Logger);
    expect(logger.id).toBe("sqlalchemy.engine");
    expect(logger.environments.production).toBeInstanceOf(LoggerEnvironment);
    expect(logger.environments.production.level).toBe(LogLevel.ERROR);
  });

  it("issues GET to /api/v1/loggers/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    await client.loggers.get("sqlalchemy.engine");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/loggers/sqlalchemy.engine");
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.loggers.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplNotFoundError when response body is empty", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(client.loggers.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.loggers.get("foo")).rejects.toThrow(SmplConnectionError);
  });
});

// ===========================================================================
// LoggersClient.delete()
// ===========================================================================

describe("LoggersClient.delete()", () => {
  it("resolves on 204", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.loggers.delete("sqlalchemy.engine")).resolves.toBeUndefined();
  });

  it("resolves on 200", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(client.loggers.delete("foo")).resolves.toBeUndefined();
  });

  it("issues DELETE to /api/v1/loggers/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.loggers.delete("sqlalchemy.engine");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/api/v1/loggers/sqlalchemy.engine");
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.loggers.delete("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.loggers.delete("missing")).rejects.toThrow(SmplConnectionError);
  });

  it("Logger.delete() routes through the client", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    const logger = await client.loggers.get("sqlalchemy.engine");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(logger.delete()).resolves.toBeUndefined();
    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("DELETE");
  });
});

// ===========================================================================
// LoggersClient.register / flush / threshold-based auto-flush
// ===========================================================================

describe("LoggersClient.register()", () => {
  it("buffers a single source without flushing", async () => {
    const client = makeClient();
    await client.loggers.register(new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(client.loggers.pendingCount).toBe(1);
  });

  it("buffers an array of sources", async () => {
    const client = makeClient();
    await client.loggers.register([
      new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }),
      new LoggerSource("logger.b", { resolvedLevel: LogLevel.DEBUG }),
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(client.loggers.pendingCount).toBe(2);
  });

  it("flushes immediately when flush: true", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.loggers.register(new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }), {
      flush: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.url).toContain("/api/v1/loggers/bulk");
    expect(client.loggers.pendingCount).toBe(0);
  });

  it("auto-flushes when buffer hits 50 items", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValue(jsonResponse({}));

    for (let i = 0; i < 49; i++) {
      await client.loggers.register(
        new LoggerSource(`logger.${i}`, { resolvedLevel: LogLevel.INFO }),
      );
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(client.loggers.pendingCount).toBe(49);

    await client.loggers.register(new LoggerSource("logger.49", { resolvedLevel: LogLevel.INFO }));
    // drain() runs synchronously inside flush() before the first await.
    expect(client.loggers.pendingCount).toBe(0);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("LoggersClient.flush()", () => {
  it("POSTs buffered sources to /api/v1/loggers/bulk", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await client.loggers.register(
      new LoggerSource("logger.a", {
        service: "svc",
        environment: "prod",
        resolvedLevel: LogLevel.INFO,
        level: LogLevel.WARN,
      }),
    );
    await client.loggers.register(new LoggerSource("logger.b", { resolvedLevel: LogLevel.DEBUG }));
    await client.loggers.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.loggers).toHaveLength(2);
    expect(body.loggers[0].id).toBe("logger.a");
    expect(body.loggers[0].level).toBe(LogLevel.WARN);
    expect(body.loggers[0].service).toBe("svc");
    expect(body.loggers[1].id).toBe("logger.b");
    expect(body.loggers[1].level).toBeUndefined();
  });

  it("is a no-op when buffer is empty", async () => {
    const client = makeClient();
    await client.loggers.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("clears buffer after flush", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.loggers.register(new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }));
    await client.loggers.flush();
    expect(client.loggers.pendingCount).toBe(0);
  });

  it("silently swallows network errors", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("network"));
    await client.loggers.register(new LoggerSource("logger.a", { resolvedLevel: LogLevel.INFO }));
    await expect(client.loggers.flush()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// Logger.save() — _saveLogger uses PUT only (upsert)
// ===========================================================================

describe("Logger.save() — upsert via PUT", () => {
  it("uses PUT for new (unsaved) loggers — no POST", async () => {
    const client = makeClient();
    const logger = client.loggers.new("sqlalchemy.engine");
    expect(logger.createdAt).toBeNull();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    await logger.save();

    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("/api/v1/loggers/sqlalchemy.engine");
  });

  it("uses PUT for existing (createdAt set) loggers", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    const logger = await client.loggers.get("sqlalchemy.engine");
    logger.setLevel(LogLevel.DEBUG);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    await logger.save();

    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("/api/v1/loggers/sqlalchemy.engine");
  });

  it("sends JSON:API body with attributes", async () => {
    const client = makeClient();
    const logger = client.loggers.new("app.server");
    logger.setLevel(LogLevel.INFO);
    logger.setLevel(LogLevel.DEBUG, { environment: "production" });
    logger.group = "app";

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    await logger.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.type).toBe("logger");
    expect(body.data.id).toBe("app.server");
    expect(body.data.attributes.name).toBe("app.server");
    expect(body.data.attributes.level).toBe(LogLevel.INFO);
    expect(body.data.attributes.group).toBe("app");
    expect(body.data.attributes.managed).toBe(true);
    expect(body.data.attributes.environments).toEqual({
      production: { level: LogLevel.DEBUG },
    });
  });

  it("omits null level/group/managed and empty environments", async () => {
    const client = makeClient();
    const logger = client.loggers.new("bare", { managed: false });
    logger.managed = null;
    expect(logger.level).toBeNull();
    expect(logger.group).toBeNull();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    await logger.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.level).toBeUndefined();
    expect(body.data.attributes.group).toBeUndefined();
    expect(body.data.attributes.managed).toBeUndefined();
    expect(body.data.attributes.environments).toBeUndefined();
  });

  it("applies response fields after save", async () => {
    const client = makeClient();
    const logger = client.loggers.new("sqlalchemy.engine");

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOGGER }));
    await logger.save();

    expect(logger.id).toBe("sqlalchemy.engine");
    expect(logger.level).toBe(LogLevel.WARN);
    expect(logger.createdAt).toBe("2026-04-01T10:00:00Z");
  });

  it("throws SmplValidationError when server returns no data", async () => {
    const client = makeClient();
    const logger = client.loggers.new("sqlalchemy.engine");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(logger.save()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    const logger = client.loggers.new("sqlalchemy.engine");

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(logger.save()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplValidationError on 422", async () => {
    const client = makeClient();
    const logger = client.loggers.new("sqlalchemy.engine");

    mockFetch.mockResolvedValueOnce(textResponse("invalid", 422));
    await expect(logger.save()).rejects.toThrow(SmplValidationError);
  });
});

// ===========================================================================
// _saveLogger — guard against null id
// ===========================================================================

describe("_saveLogger() guard", () => {
  it("throws when called on a Logger with no id", async () => {
    const client = makeClient();
    const logger = new Logger(client.loggers as LoggersClient, {
      id: null,
      name: "x",
      level: null,
      group: null,
      managed: null,
      sources: [],
      environments: null,
      createdAt: null,
      updatedAt: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client.loggers as any)._saveLogger(logger)).rejects.toThrow(
      "Cannot save a Logger with no id",
    );
  });
});

// ===========================================================================
// LogGroupsClient.new() / list() / get() / delete()
// ===========================================================================

describe("LogGroupsClient.new()", () => {
  it("returns an unsaved LogGroup with sensible defaults", () => {
    const client = makeClient();
    const group = client.logGroups.new("db");
    expect(group).toBeInstanceOf(LogGroup);
    expect(group.id).toBe("db");
    expect(group.name).toBe("db");
    expect(group.level).toBeNull();
    expect(group.group).toBeNull();
    expect(group.createdAt).toBeNull();
  });

  it("accepts custom name and parent group", () => {
    const client = makeClient();
    const group = client.logGroups.new("db", { name: "Database", group: "infra" });
    expect(group.name).toBe("Database");
    expect(group.group).toBe("infra");
  });
});

describe("LogGroupsClient.list()", () => {
  it("returns an array of LogGroups", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_LOG_GROUP] }));

    const groups = await client.logGroups.list();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toBeInstanceOf(LogGroup);
    expect(groups[0].id).toBe("db");
    expect(groups[0].name).toBe("Database");
    expect(groups[0].level).toBe(LogLevel.INFO);
    expect(groups[0].environments.production.level).toBe(LogLevel.WARN);
  });

  it("returns empty array when no data", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const groups = await client.logGroups.list();
    expect(groups).toEqual([]);
  });

  it("issues GET to /api/v1/log_groups", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.logGroups.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/log_groups");
  });

  it("handles a log group with bare attributes", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_BARE_LOG_GROUP] }));
    const groups = await client.logGroups.list();
    expect(groups[0].id).toBe("minimal-group");
    expect(groups[0].name).toBe("");
    expect(groups[0].level).toBeNull();
    expect(groups[0].group).toBeNull();
    expect(groups[0].createdAt).toBeNull();
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.logGroups.list()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplConnectionError on generic error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("boom"));
    await expect(client.logGroups.list()).rejects.toThrow(SmplConnectionError);
  });

  it("wraps non-Error rejections (string)", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce("string-rejection");
    await expect(client.logGroups.list()).rejects.toThrow(SmplConnectionError);
  });

  it("propagates SmplValidationError on 422", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("invalid", 422));
    await expect(client.logGroups.list()).rejects.toThrow(SmplValidationError);
  });
});

describe("LogGroupsClient.get()", () => {
  it("returns a LogGroup by id", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));

    const group = await client.logGroups.get("db");
    expect(group).toBeInstanceOf(LogGroup);
    expect(group.id).toBe("db");
    expect(group.level).toBe(LogLevel.INFO);
  });

  it("issues GET to /api/v1/log_groups/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    await client.logGroups.get("db");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/log_groups/db");
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.logGroups.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplNotFoundError when response body is empty", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(client.logGroups.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.logGroups.get("foo")).rejects.toThrow(SmplConnectionError);
  });
});

describe("LogGroupsClient.delete()", () => {
  it("resolves on 204", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.logGroups.delete("db")).resolves.toBeUndefined();
  });

  it("resolves on 200", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(client.logGroups.delete("db")).resolves.toBeUndefined();
  });

  it("issues DELETE to /api/v1/log_groups/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.logGroups.delete("db");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/api/v1/log_groups/db");
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.logGroups.delete("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.logGroups.delete("missing")).rejects.toThrow(SmplConnectionError);
  });

  it("LogGroup.delete() routes through the client", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    const group = await client.logGroups.get("db");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(group.delete()).resolves.toBeUndefined();
    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("DELETE");
  });
});

// ===========================================================================
// LogGroup.save() — _saveGroup uses PUT only (upsert)
// ===========================================================================

describe("LogGroup.save() — upsert via PUT", () => {
  it("uses PUT for new (unsaved) groups — no POST", async () => {
    const client = makeClient();
    const group = client.logGroups.new("db");
    expect(group.createdAt).toBeNull();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    await group.save();

    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("/api/v1/log_groups/db");
  });

  it("uses PUT for existing groups", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    const group = await client.logGroups.get("db");
    group.setLevel(LogLevel.DEBUG);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    await group.save();

    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("/api/v1/log_groups/db");
  });

  it("sends JSON:API body with attributes including parent_id", async () => {
    const client = makeClient();
    const group = client.logGroups.new("db", { name: "Database", group: "infra" });
    group.setLevel(LogLevel.INFO);
    group.setLevel(LogLevel.DEBUG, { environment: "production" });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    await group.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.type).toBe("log_group");
    expect(body.data.id).toBe("db");
    expect(body.data.attributes.name).toBe("Database");
    expect(body.data.attributes.level).toBe(LogLevel.INFO);
    // parent_id (not "group") on the wire.
    expect(body.data.attributes.parent_id).toBe("infra");
    expect(body.data.attributes.environments).toEqual({
      production: { level: LogLevel.DEBUG },
    });
  });

  it("omits null level/parent_id and empty environments", async () => {
    const client = makeClient();
    const group = client.logGroups.new("bare");
    expect(group.level).toBeNull();
    expect(group.group).toBeNull();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    await group.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.level).toBeUndefined();
    expect(body.data.attributes.parent_id).toBeUndefined();
    expect(body.data.attributes.environments).toBeUndefined();
  });

  it("applies response fields after save", async () => {
    const client = makeClient();
    const group = client.logGroups.new("db");

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_LOG_GROUP }));
    await group.save();

    expect(group.id).toBe("db");
    expect(group.name).toBe("Database");
    expect(group.level).toBe(LogLevel.INFO);
    expect(group.createdAt).toBe("2026-04-01T10:00:00Z");
  });

  it("throws SmplValidationError when server returns no data", async () => {
    const client = makeClient();
    const group = client.logGroups.new("db");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(group.save()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    const group = client.logGroups.new("db");

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(group.save()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplValidationError on 422", async () => {
    const client = makeClient();
    const group = client.logGroups.new("db");

    mockFetch.mockResolvedValueOnce(textResponse("invalid", 422));
    await expect(group.save()).rejects.toThrow(SmplValidationError);
  });
});

// ===========================================================================
// _saveGroup — guard against null id
// ===========================================================================

describe("_saveGroup() guard", () => {
  it("throws when called on a LogGroup with no id", async () => {
    const client = makeClient();
    const group = new LogGroup(client.logGroups as LogGroupsClient, {
      id: null,
      name: "x",
      level: null,
      group: null,
      environments: null,
      createdAt: null,
      updatedAt: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client.logGroups as any)._saveGroup(group)).rejects.toThrow(
      "Cannot save a LogGroup with no id",
    );
  });
});
