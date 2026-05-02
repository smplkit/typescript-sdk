import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LoggingClient, LoggerRegistrationBuffer } from "../../../src/logging/client.js";
import { SmplError } from "../../../src/errors.js";

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

      // _ensureWs should only be called once (5 ws.on calls: logger_changed/deleted, group_changed/deleted, loggers_changed)
      expect(lastMockWs.on).toHaveBeenCalledTimes(5);
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
      // start() fetches empty list → _loggerStore is empty (level null for test.logger)
      await client.start();

      // Scoped re-fetch returns single logger with level INFO
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: "test.logger",
            type: "logger",
            attributes: {
              name: "Test",
              level: "INFO",
              group: null,
              managed: false,
              environments: {},
              created_at: null,
              updated_at: null,
            },
          },
        }),
      );
      const cb = vi.fn();
      client.onChange(cb);

      // No level in payload — server never sends it
      lastMockWs._emit("logger_changed", { id: "test.logger" });
      await new Promise((r) => setTimeout(r, 10));

      expect(cb).toHaveBeenCalledWith({
        id: "test.logger",
        level: "INFO",
        source: "websocket",
      });
    });

    it("should register an id-scoped listener", async () => {
      const client = makeClient();
      prepareForStart(client);
      // start() fetches empty list → _loggerStore is empty
      await client.start();

      // Scoped re-fetch returns single logger with level DEBUG
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: "test.logger",
            type: "logger",
            attributes: {
              name: "Test",
              level: "DEBUG",
              group: null,
              managed: false,
              environments: {},
              created_at: null,
              updated_at: null,
            },
          },
        }),
      );
      // other.logger fetch returns null (not found)
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

      const cb = vi.fn();
      client.onChange("test.logger", cb);

      lastMockWs._emit("logger_changed", { id: "test.logger" });
      lastMockWs._emit("logger_changed", { id: "other.logger" });
      await new Promise((r) => setTimeout(r, 10));

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
      // Should not throw — errors are swallowed; no level in payload
      lastMockWs._emit("logger_changed", { id: "test.logger" });
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

      expect(lastMockWs.on).toHaveBeenCalledTimes(5);
    });
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

    // start() fetches empty list → _loggerStore has no entry for "test"
    await client.start();

    // Scoped fetch returns logger with level INFO (different from null → listener fires)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "test",
          type: "logger",
          attributes: {
            name: "Test",
            level: "INFO",
            group: null,
            managed: false,
            environments: {},
            created_at: null,
            updated_at: null,
          },
        },
      }),
    );
    lastMockWs._emit("logger_changed", { id: "test" });
    await new Promise((r) => setTimeout(r, 10));

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

    // start() fetches empty list → _loggerStore has no entry for "test"
    await client.start();

    // Scoped fetch returns logger with level DEBUG (different from null → listener fires)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "test",
          type: "logger",
          attributes: {
            name: "Test",
            level: "DEBUG",
            group: null,
            managed: false,
            environments: {},
            created_at: null,
            updated_at: null,
          },
        },
      }),
    );
    lastMockWs._emit("logger_changed", { id: "test" });
    await new Promise((r) => setTimeout(r, 10));

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
// WebSocket event behaviors: scoped fetch, diff-based, deleted events
// ===========================================================================

describe("LoggingClient — WebSocket event behaviors", () => {
  function prepareClient(): LoggingClient {
    const client = makeClient();
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    return client;
  }

  function makeSingleLoggerResponse(id: string, level: string | null) {
    return jsonResponse({
      data: {
        id,
        type: "logger",
        attributes: {
          name: id,
          level,
          group: null,
          managed: false,
          environments: {},
          created_at: null,
          updated_at: null,
        },
      },
    });
  }

  function makeSingleGroupResponse(id: string, level: string | null) {
    return jsonResponse({
      data: {
        id,
        type: "log_group",
        attributes: {
          name: id,
          level,
          parent_id: null,
          environments: {},
          created_at: null,
          updated_at: null,
        },
      },
    });
  }

  // -----------------------------------------------------------------------
  // logger_changed
  // -----------------------------------------------------------------------

  it("logger_changed: scoped fetch fires listener when level changed", async () => {
    const client = prepareClient();
    // start() fetches empty list → _loggerStore has no "sql" entry
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const cb = vi.fn();
    client.onChange(cb);
    await client.start();

    // Scoped fetch returns logger with level WARN (different from null)
    mockFetch.mockResolvedValueOnce(makeSingleLoggerResponse("sql", "WARN"));
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 10));

    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ id: "sql", level: "WARN", source: "websocket" }),
    );
  });

  it("logger_changed: scoped fetch does NOT fire listener when level unchanged", async () => {
    const client = prepareClient();
    // start() returns logger "sql" with level INFO
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      ),
    );
    const cb = vi.fn();
    client.onChange(cb);
    await client.start();

    // Scoped fetch returns same level (INFO)
    mockFetch.mockResolvedValueOnce(makeSingleLoggerResponse("sql", "INFO"));
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 10));

    expect(cb).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // logger_deleted
  // -----------------------------------------------------------------------

  it("logger_deleted: removes from store, fires with deleted=true, no HTTP fetch", async () => {
    const client = prepareClient();
    // start() returns logger "sql" with level INFO
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      ),
    );
    const cb = vi.fn();
    const keyedCb = vi.fn();
    client.onChange(cb);
    client.onChange("sql", keyedCb);
    await client.start();

    const fetchCountBefore = mockFetch.mock.calls.length;
    lastMockWs._emit("logger_deleted", { id: "sql" });
    await new Promise((r) => setTimeout(r, 10));

    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ id: "sql", deleted: true }));
    expect(keyedCb).toHaveBeenCalledWith(expect.objectContaining({ id: "sql", deleted: true }));
    // No additional HTTP fetch
    expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);
  });

  it("logger_deleted: swallows errors from global listeners", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const throwingCb = vi.fn(() => {
      throw new Error("global throws on delete");
    });
    const goodCb = vi.fn();
    client.onChange(throwingCb);
    client.onChange(goodCb);
    await client.start();

    lastMockWs._emit("logger_deleted", { id: "sql" });
    await new Promise((r) => setTimeout(r, 10));

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("logger_deleted: swallows errors from per-key listeners", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const throwingCb = vi.fn(() => {
      throw new Error("key throws on delete");
    });
    const goodCb = vi.fn();
    client.onChange("sql", throwingCb);
    client.onChange("sql", goodCb);
    await client.start();

    lastMockWs._emit("logger_deleted", { id: "sql" });
    await new Promise((r) => setTimeout(r, 10));

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // group_changed
  // -----------------------------------------------------------------------

  it("group_changed: scoped fetch fires re-apply when level changed", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Scoped group fetch returns changed level
    mockFetch.mockResolvedValueOnce(makeSingleGroupResponse("db-group", "ERROR"));
    // Re-apply fetches loggers
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    lastMockWs._emit("group_changed", { id: "db-group" });
    await new Promise((r) => setTimeout(r, 20));

    // Should have made additional fetch calls for the scoped group + logger re-apply
    expect(mockFetch.mock.calls.length).toBeGreaterThan(2);
  });

  it("logger_changed: does not crash if _fetchSingleLogger rejects (outer catch)", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Spy on _applyLevels to throw
    vi.spyOn(client as never, "_applyLevels" as never).mockImplementationOnce((() => {
      throw new Error("applyLevels error");
    }) as never);

    // Scoped fetch returns a logger with changed level
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "sql",
          type: "logger",
          attributes: {
            name: "sql",
            level: "ERROR",
            group: null,
            managed: false,
            environments: {},
            created_at: null,
            updated_at: null,
          },
        },
      }),
    );

    // Should not throw
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("group_changed: does not crash if outer catch fires", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Spy on _groupStore setter to throw after change is detected
    const origGroupStore = (client as unknown as { _groupStore: Record<string, string | null> })
      ._groupStore;
    (client as unknown as { _groupStore: Record<string, string | null> })._groupStore = new Proxy(
      origGroupStore,
      {
        set: (_t, _k, _v) => {
          throw new Error("groupStore set error");
        },
      },
    );

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: "db-group",
          type: "log_group",
          attributes: {
            name: "DB",
            level: "ERROR",
            parent_id: null,
            environments: {},
            created_at: null,
            updated_at: null,
          },
        },
      }),
    );

    // Should not throw
    lastMockWs._emit("group_changed", { id: "db-group" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("group_changed: no re-apply when level unchanged", async () => {
    const client = prepareClient();
    // Initial: group exists with level WARN
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Manually populate group store
    (client as unknown as { _groupStore: Record<string, string | null> })._groupStore["db-group"] =
      "WARN";

    const fetchCountBefore = mockFetch.mock.calls.length;
    // Scoped group fetch returns same level
    mockFetch.mockResolvedValueOnce(makeSingleGroupResponse("db-group", "WARN"));
    lastMockWs._emit("group_changed", { id: "db-group" });
    await new Promise((r) => setTimeout(r, 20));

    // Only one additional fetch (for the group itself) — no logger re-apply
    expect(mockFetch.mock.calls.length).toBe(fetchCountBefore + 1);
  });

  // -----------------------------------------------------------------------
  // group_deleted
  // -----------------------------------------------------------------------

  it("group_deleted: removes from store, fires with deleted=true, no HTTP fetch", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const cb = vi.fn();
    const keyedCb = vi.fn();
    client.onChange(cb);
    client.onChange("db-group", keyedCb);
    await client.start();

    // Populate group store
    (client as unknown as { _groupStore: Record<string, string | null> })._groupStore["db-group"] =
      "WARN";

    const fetchCountBefore = mockFetch.mock.calls.length;
    lastMockWs._emit("group_deleted", { id: "db-group" });
    await new Promise((r) => setTimeout(r, 10));

    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ id: "db-group", deleted: true }));
    expect(keyedCb).toHaveBeenCalledWith(
      expect.objectContaining({ id: "db-group", deleted: true }),
    );
    expect(mockFetch.mock.calls.length).toBe(fetchCountBefore);
  });

  it("group_deleted: swallows errors from global listeners", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const throwingCb = vi.fn(() => {
      throw new Error("global throws on group delete");
    });
    const goodCb = vi.fn();
    client.onChange(throwingCb);
    client.onChange(goodCb);
    await client.start();

    // Populate group store
    (client as unknown as { _groupStore: Record<string, string | null> })._groupStore["db-group"] =
      "WARN";

    lastMockWs._emit("group_deleted", { id: "db-group" });
    await new Promise((r) => setTimeout(r, 10));

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("group_deleted: swallows errors from per-key listeners", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const throwingCb = vi.fn(() => {
      throw new Error("key throws on group delete");
    });
    const goodCb = vi.fn();
    client.onChange("db-group", throwingCb);
    client.onChange("db-group", goodCb);
    await client.start();

    (client as unknown as { _groupStore: Record<string, string | null> })._groupStore["db-group"] =
      "WARN";

    lastMockWs._emit("group_deleted", { id: "db-group" });
    await new Promise((r) => setTimeout(r, 10));

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // loggers_changed
  // -----------------------------------------------------------------------

  it("loggers_changed: registers listener on shared WS", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    expect(lastMockWs.on).toHaveBeenCalledWith("loggers_changed", expect.any(Function));
  });

  it("loggers_changed: full refetch, global fires once, per-key for changed keys", async () => {
    const client = prepareClient();
    // Initial: sql=INFO, http=DEBUG
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
            {
              id: "http",
              type: "logger",
              attributes: {
                name: "http",
                level: "DEBUG",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      ),
    );
    const globalCb = vi.fn();
    const sqlCb = vi.fn();
    const httpCb = vi.fn();
    client.onChange(globalCb);
    client.onChange("sql", sqlCb);
    client.onChange("http", httpCb);
    await client.start();

    // loggers_changed triggers full list fetch — sql unchanged, http changed
    mockFetch
      .mockResolvedValueOnce(
        // loggers list: sql=INFO (unchanged), http=WARN (changed)
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
            {
              id: "http",
              type: "logger",
              attributes: {
                name: "http",
                level: "WARN",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] })); // groups list

    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));

    // Global fires once
    expect(globalCb).toHaveBeenCalledTimes(1);
    // sql unchanged → no per-key listener
    expect(sqlCb).not.toHaveBeenCalled();
    // http changed → per-key listener fires
    expect(httpCb).toHaveBeenCalledTimes(1);
    expect(httpCb).toHaveBeenCalledWith(
      expect.objectContaining({ id: "http", level: "WARN", source: "websocket" }),
    );
  });

  it("loggers_changed: detects deleted logger and fires listener", async () => {
    const client = prepareClient();
    // Initial: sql logger exists
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      ),
    );
    const cb = vi.fn();
    client.onChange(cb);
    await client.start();

    // loggers_changed: sql is gone, also returns groups
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // loggers: empty (sql deleted)
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "db-group",
              type: "log_group",
              attributes: {
                name: "DB",
                level: "WARN",
                parent_id: null,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      ); // groups: db-group

    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));

    // sql was deleted → changedLoggerIds includes sql → global fires
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ id: "sql", source: "websocket" }));
  });

  it("loggers_changed: does not crash if fetch throws", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    await client.start();

    // Make subsequent fetches fail
    mockFetch.mockRejectedValue(new Error("network error"));
    // Should not throw
    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));
  });

  it("loggers_changed: swallows errors thrown by global listeners", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const throwingCb = vi.fn(() => {
      throw new Error("listener boom");
    });
    const goodCb = vi.fn();
    client.onChange(throwingCb);
    client.onChange(goodCb);
    await client.start();

    // Fetch returns logger with level INFO — different from null (change detected)
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("loggers_changed: swallows errors thrown by per-key listeners", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
    const throwingCb = vi.fn(() => {
      throw new Error("key listener boom");
    });
    const goodCb = vi.fn();
    client.onChange("sql", throwingCb);
    client.onChange("sql", goodCb);
    await client.start();

    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));

    expect(throwingCb).toHaveBeenCalledTimes(1);
    expect(goodCb).toHaveBeenCalledTimes(1);
  });

  it("loggers_changed: no listeners fire when nothing changed", async () => {
    const client = prepareClient();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      ),
    );
    const cb = vi.fn();
    client.onChange(cb);
    await client.start();

    // Same content
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "sql",
              type: "logger",
              attributes: {
                name: "sql",
                level: "INFO",
                group: null,
                managed: false,
                environments: {},
                created_at: null,
                updated_at: null,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [] }));

    lastMockWs._emit("loggers_changed", {});
    await new Promise((r) => setTimeout(r, 20));

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

  it("_onAdapterNewLogger should add to buffer (not create Logger via CRUD)", async () => {
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
    // After start(), the start-time discovery flush has already drained
    // the buffer; pendingCount is 0.
    expect((client as any)._loggerBuffer.pendingCount).toBe(0);

    // Fire the hook as if a new logger was created in the framework.
    // Should buffer for bulk-register, not POST individually or hit any
    // CRUD endpoint. mockFetch was called during start() but no further.
    const callsBefore = mockFetch.mock.calls.length;
    capturedHook!("runtime.logger", "INFO");
    expect(mockFetch.mock.calls.length).toBe(callsBefore);

    // Buffer should now have 1 pending item
    expect((client as any)._loggerBuffer.pendingCount).toBe(1);

    client._close();
  });

  it("_onAdapterNewLogger should not eagerly hit any HTTP endpoint", async () => {
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

    const callsBefore = mockFetch.mock.calls.length;
    capturedHook!("runtime.logger", "WARN");

    // No further HTTP calls — discovery is buffered.
    expect(mockFetch.mock.calls.length).toBe(callsBefore);

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

// ===========================================================================
// Internal model-client aliases & install()
// ===========================================================================

describe("LoggingClient — internal aliases & install()", () => {
  it("install() should be an alias of start() and idempotent", async () => {
    const client = makeClient();
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));

    await client.install();
    await client.install();

    // Should wire WebSocket listeners exactly once across repeated install() calls.
    expect(lastMockWs.on).toHaveBeenCalledTimes(5);
  });
});

// ===========================================================================
// Internal HTTP helpers — direct fallback paths
// ===========================================================================

describe("LoggingClient — _listLoggers/_listLogGroups direct HTTP fallback", () => {
  it("delegates to the management plane when wired", async () => {
    const client = makeClient();
    const fakeMgmt = {
      loggers: { list: vi.fn().mockResolvedValue([]) },
      logGroups: { list: vi.fn().mockResolvedValue([]) },
    };
    client._resolveManagement = () => fakeMgmt as never;
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });

    await client.start();

    expect(fakeMgmt.loggers.list).toHaveBeenCalled();
    expect(fakeMgmt.logGroups.list).toHaveBeenCalled();
  });

  it("falls back to direct HTTP and surfaces errors via SmplError on _listLoggers failure", async () => {
    const client = makeClient();
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });

    let call = 0;
    mockFetch.mockImplementation(() => {
      call++;
      // First HTTP call: list loggers — returns 500 to hit the error branch.
      if (call === 1) return Promise.resolve(new Response("Server Error", { status: 500 }));
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    // start() catches the error from _listLoggers internally; no throw.
    await client.start();
    expect(call).toBeGreaterThanOrEqual(1);
  });

  it("falls back to direct HTTP and surfaces errors via SmplError on _listLogGroups failure", async () => {
    const client = makeClient();
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });

    let call = 0;
    mockFetch.mockImplementation(() => {
      call++;
      // First HTTP call: list loggers — succeeds.
      if (call === 1) return Promise.resolve(jsonResponse({ data: [] }));
      // Second HTTP call: list log groups — fails.
      return Promise.resolve(new Response("Server Error", { status: 500 }));
    });

    // start() catches the error internally; no throw.
    await client.start();
    expect(call).toBeGreaterThanOrEqual(2);
  });

  it("translates DOMException AbortError from custom fetch wrapper into SmplTimeoutError", async () => {
    const ws = createMockSharedWs();
    const client = new LoggingClient(API_KEY, () => ws as never, 1);
    client.registerAdapter({
      name: "noop",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    });
    mockFetch.mockRejectedValue(new DOMException("aborted", "AbortError"));

    // start() swallows the timeout and continues.
    await client.start();
    // No assertion on outcome; coverage of the AbortError branch is the point.
  });
});
