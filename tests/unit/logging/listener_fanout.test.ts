/**
 * Diagnostic tests for the change-listener fanout contract.
 *
 * Rules under test:
 *   - Global listeners fire once per logger whose effective level moved
 *     (one trigger that moves N loggers fires the global listener N times,
 *     not once with a summary).
 *   - Key-scoped listeners fire once per matching id, with the same
 *     payload the global listener receives.
 *   - Event payloads carry the affected logger's id and newly-applied
 *     effective level — no `deleted` flag, no synthetic ids.
 *   - Deletion events (logger_deleted / group_deleted) fire nothing for
 *     the deleted id itself; dependents that re-resolve fire normally.
 *   - A no-op edit (only a name/description moved, effective level
 *     unchanged) fires nothing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import createClient from "openapi-fetch";
import { LoggingClient } from "../../../src/logging/client.js";
import type { LoggingParent } from "../../../src/logging/client.js";
import type { SharedWebSocket } from "../../../src/ws.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type WsCallback = (data: Record<string, unknown>) => void;

interface MockSharedWs {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
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
    off: vi.fn(),
    connectionStatus: "connected",
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
  };
}

/** Build a logging transport driven by the stubbed global fetch. */
function makeTransport(): any {
  return createClient<import("../../../src/generated/logging.d.ts").paths>({
    baseUrl: "https://logging.smplkit.com",
    headers: { Authorization: "Bearer sk_test", Accept: "application/json" },
  });
}

let lastMockWs: MockSharedWs;

function makeParent(): LoggingParent {
  lastMockWs = createMockSharedWs();
  return {
    _environment: "production",
    _service: "svc",
    _ensureStarted: vi.fn(),
    _ensureWs: () => lastMockWs as unknown as SharedWebSocket,
  };
}

function makeClient(): LoggingClient {
  return new LoggingClient({ parent: makeParent(), transport: makeTransport(), metrics: null });
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loggerResource(id: string, level: string | null, group: string | null = null) {
  return {
    id,
    type: "logger",
    attributes: {
      name: id,
      level,
      group,
      managed: true,
      environments: {},
      created_at: null,
      updated_at: null,
    },
  };
}

function logGroupResource(id: string, level: string | null) {
  return {
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
  };
}

function setupClientWithKnownLoggers(names: string[]): LoggingClient {
  const client = makeClient();
  client.registerAdapter({
    name: "test-adapter",
    discover: () => names.map((name) => ({ name, level: "INFO" })),
    applyLevel: () => {},
    installHook: () => {},
    uninstallHook: () => {},
  });
  return client;
}

// ---------------------------------------------------------------------------
// Scenario 1: dot-ancestor cascade via logger_changed
// ---------------------------------------------------------------------------

describe("fanout — dot-ancestor cascade via logger_changed", () => {
  it("global fires once per descendant when an ancestor logger changes", async () => {
    // com.acme at WARN; 5 descendants com.acme.{a,b,c,d,e} with no own level.
    const descendants = ["com.acme.a", "com.acme.b", "com.acme.c", "com.acme.d", "com.acme.e"];
    const names = ["com.acme", ...descendants];
    const client = setupClientWithKnownLoggers(names);

    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(jsonResponse({ data: [loggerResource("com.acme", "WARN")] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    await client.install();
    const globalCb = vi.fn();
    client.onChange(globalCb);

    // logger_changed: com.acme → ERROR
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: loggerResource("com.acme", "ERROR") }));
    lastMockWs._emit("logger_changed", { id: "com.acme" });
    await new Promise((r) => setTimeout(r, 20));

    // 6 invocations: com.acme + 5 descendants.
    expect(globalCb).toHaveBeenCalledTimes(6);
    const idsAndLevels = globalCb.mock.calls
      .map((c) => ({ id: c[0].id, level: c[0].level }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(idsAndLevels).toEqual(names.sort().map((id) => ({ id, level: "ERROR" })));
    // No payload carries a deleted flag.
    for (const call of globalCb.mock.calls) {
      expect(call[0]).not.toHaveProperty("deleted");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: group cascade via group_changed
// ---------------------------------------------------------------------------

describe("fanout — group cascade via group_changed", () => {
  it("global fires once per group member when the group level changes", async () => {
    // app.db, app.queue, app.api all inherit from group "app" (WARN).
    const members = ["app.db", "app.queue", "app.api"];
    const client = setupClientWithKnownLoggers(members);

    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/log_groups") && !url.includes("/log_groups/")) {
        return Promise.resolve(jsonResponse({ data: [logGroupResource("app", "WARN")] }));
      }
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(
          jsonResponse({ data: members.map((m) => loggerResource(m, null, "app")) }),
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    await client.install();
    const globalCb = vi.fn();
    client.onChange(globalCb);

    // group_changed: app → ERROR
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: logGroupResource("app", "ERROR") }));
    lastMockWs._emit("group_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));

    expect(globalCb).toHaveBeenCalledTimes(3);
    const ids = globalCb.mock.calls.map((c) => c[0].id).sort();
    expect(ids).toEqual(members.slice().sort());
    for (const call of globalCb.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ level: "ERROR", source: "websocket" }));
      expect(call[0]).not.toHaveProperty("deleted");
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: deletion
// ---------------------------------------------------------------------------

describe("fanout — deletion via group_deleted", () => {
  it("global fires once per dependent re-resolving to fallback; no event for the deleted id", async () => {
    const members = ["app.db", "app.queue", "app.api"];
    const client = setupClientWithKnownLoggers(members);

    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/log_groups") && !url.includes("/log_groups/")) {
        return Promise.resolve(jsonResponse({ data: [logGroupResource("app", "WARN")] }));
      }
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(
          jsonResponse({ data: members.map((m) => loggerResource(m, null, "app")) }),
        );
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    await client.install();
    const globalCb = vi.fn();
    const groupCb = vi.fn();
    client.onChange(globalCb);
    client.onChange("app", groupCb); // listener on the group id itself

    lastMockWs._emit("group_deleted", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));

    // 3 dependents re-resolve WARN → INFO.
    expect(globalCb).toHaveBeenCalledTimes(3);
    for (const call of globalCb.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ level: "INFO", source: "websocket" }));
      expect(call[0]).not.toHaveProperty("deleted");
      expect(members).toContain(call[0].id);
      // The deleted group id never appears as an event id.
      expect(call[0].id).not.toBe("app");
    }
    // Listener scoped to the deleted group id never fires.
    expect(groupCb).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: no-op edit
// ---------------------------------------------------------------------------

describe("fanout — no-op edit", () => {
  it("a logger_changed with no effective-level delta fires nothing", async () => {
    const client = setupClientWithKnownLoggers(["sql"]);
    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(jsonResponse({ data: [loggerResource("sql", "INFO")] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    await client.install();
    const globalCb = vi.fn();
    const sqlCb = vi.fn();
    client.onChange(globalCb);
    client.onChange("sql", sqlCb);

    // Same level returned by scoped fetch — only metadata moved server-side.
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: loggerResource("sql", "INFO") }));
    lastMockWs._emit("logger_changed", { id: "sql" });
    await new Promise((r) => setTimeout(r, 20));

    expect(globalCb).not.toHaveBeenCalled();
    expect(sqlCb).not.toHaveBeenCalled();
  });

  it("a group_changed with no effective-level delta fires nothing", async () => {
    const client = setupClientWithKnownLoggers(["app.db"]);
    mockFetch.mockImplementation((req: Request) => {
      const url = req.url;
      if (url.includes("/log_groups") && !url.includes("/log_groups/")) {
        return Promise.resolve(jsonResponse({ data: [logGroupResource("app", "WARN")] }));
      }
      if (url.includes("/loggers") && !url.endsWith("/log_groups")) {
        return Promise.resolve(jsonResponse({ data: [loggerResource("app.db", null, "app")] }));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });

    await client.install();
    const globalCb = vi.fn();
    client.onChange(globalCb);

    // Scoped fetch returns same level — only the group's name changed.
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: logGroupResource("app", "WARN") }));
    lastMockWs._emit("group_changed", { id: "app" });
    await new Promise((r) => setTimeout(r, 20));

    expect(globalCb).not.toHaveBeenCalled();
  });
});
