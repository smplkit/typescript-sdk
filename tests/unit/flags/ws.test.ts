import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Part 1: SharedWebSocket tests (unchanged)
// ---------------------------------------------------------------------------

let wsInstances: MockWsInstance[] = [];

interface MockWsInstance {
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  _listeners: Record<string, ((...args: unknown[]) => void)[]>;
  _emit: (event: string, ...args: unknown[]) => void;
}

function createMockWs(): MockWsInstance {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const instance: MockWsInstance = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    send: vi.fn(),
    close: vi.fn(),
    _listeners: listeners,
    _emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners[event] ?? []) cb(...args);
    },
  };
  wsInstances.push(instance);
  return instance;
}

vi.mock("ws", () => {
  const MockWebSocket = vi.fn().mockImplementation(() => createMockWs());
  return { default: MockWebSocket };
});

const { SharedWebSocket } = await import("../../../src/ws.js");
const WsMock = (await import("ws")).default as unknown as ReturnType<typeof vi.fn>;

function getLastWsInstance(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  wsInstances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SharedWebSocket", () => {
  it("should start and create a WebSocket connection", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    expect(wsInstances).toHaveLength(1);
    ws.stop();
  });

  it("should dispatch events by the event field", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    const events: Record<string, unknown>[] = [];
    ws.on("flag_changed", (data) => events.push(data));
    ws.start();

    const mock = getLastWsInstance();
    // Simulate connected message
    mock._emit("message", JSON.stringify({ type: "connected" }));

    // Simulate flag_changed event
    mock._emit("message", JSON.stringify({ event: "flag_changed", id: "my-flag" }));

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("my-flag");

    ws.stop();
  });

  it("should route config_changed to config listeners", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    const configEvents: Record<string, unknown>[] = [];
    const flagEvents: Record<string, unknown>[] = [];
    ws.on("config_changed", (data) => configEvents.push(data));
    ws.on("flag_changed", (data) => flagEvents.push(data));
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("message", JSON.stringify({ type: "connected" }));
    mock._emit("message", JSON.stringify({ event: "config_changed", config_id: "c-1" }));

    expect(configEvents).toHaveLength(1);
    expect(flagEvents).toHaveLength(0);

    ws.stop();
  });

  it("should respond to ping with pong", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("message", "ping");

    expect(mock.send).toHaveBeenCalledWith("pong");
    ws.stop();
  });

  it("should unregister listeners with off", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    const events: unknown[] = [];
    const cb = (data: Record<string, unknown>) => events.push(data);
    ws.on("flag_changed", cb);
    ws.off("flag_changed", cb);
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("message", JSON.stringify({ type: "connected" }));
    mock._emit("message", JSON.stringify({ event: "flag_changed", id: "x" }));

    expect(events).toHaveLength(0);
    ws.stop();
  });

  it("should set connection status to connected after confirmation", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("open");
    expect(ws.connectionStatus).toBe("connecting"); // not yet connected

    mock._emit("message", JSON.stringify({ type: "connected" }));
    expect(ws.connectionStatus).toBe("connected");

    ws.stop();
  });

  it("should schedule reconnect on close event", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("close");

    expect(ws.connectionStatus).toBe("connecting");

    // Advance past first backoff
    vi.advanceTimersByTime(1100);
    expect(wsInstances).toHaveLength(2);

    ws.stop();
  });

  it("should not reconnect after stop", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();
    ws.stop();

    const initialCount = wsInstances.length;
    vi.advanceTimersByTime(120_000);
    expect(wsInstances.length).toBe(initialCount);
  });

  it("should report disconnected after stop", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();
    ws.stop();
    expect(ws.connectionStatus).toBe("disconnected");
  });

  it("should ignore unparseable JSON messages", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    // Should not throw on invalid JSON
    mock._emit("message", "not-json{{{");

    ws.stop();
  });

  it("should ignore error events (close handles reconnect)", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    // error event should not throw
    mock._emit("error", new Error("connection reset"));

    ws.stop();
  });

  it("should ignore error-type messages from server", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    const events: unknown[] = [];
    ws.on("error", (data) => events.push(data));
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("message", JSON.stringify({ type: "error", message: "bad request" }));

    // error type messages are swallowed, not dispatched
    expect(events).toHaveLength(0);
    ws.stop();
  });

  it("should handle URL without protocol prefix", () => {
    const ws = new SharedWebSocket("app.smplkit.com", "sk_test");
    ws.start();
    // Should not throw — falls through to the "wss://" + url path
    expect(wsInstances).toHaveLength(1);
    ws.stop();
  });

  it("should close WS if open event fires after stop", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    ws.stop();

    // Simulate delayed "open" event after stop
    mock._emit("open");
    expect(mock.close).toHaveBeenCalled();
  });

  it("should cancel pending reconnect timer on stop", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    // Trigger close to start reconnect timer
    mock._emit("close");
    expect(ws.connectionStatus).toBe("connecting");

    // Stop before the reconnect fires — should clear the timer
    ws.stop();
    expect(ws.connectionStatus).toBe("disconnected");

    // Even after a long wait, no new connections
    vi.advanceTimersByTime(120_000);
    expect(wsInstances).toHaveLength(1);
  });

  it("should handle http:// URL by converting to ws://", () => {
    const ws = new SharedWebSocket("http://localhost:3000", "sk_test");
    ws.start();
    expect(wsInstances).toHaveLength(1);
    ws.stop();
  });

  it("should handle WS error followed by close for reconnect", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    // Simulate an error followed by close
    mock._emit("error", new Error("ECONNREFUSED"));
    mock._emit("close");

    // Should schedule reconnect
    expect(ws.connectionStatus).toBe("connecting");

    vi.advanceTimersByTime(1100);
    expect(wsInstances).toHaveLength(2);

    ws.stop();
  });

  it("should schedule reconnect when WebSocket constructor throws", () => {
    // Make the mock constructor throw on the next invocation
    WsMock.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });

    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    // Constructor threw, so should schedule reconnect
    expect(ws.connectionStatus).toBe("connecting");

    // Restore normal mock behavior for the reconnect
    WsMock.mockImplementation(() => createMockWs());

    // Advance past backoff — should reconnect
    vi.advanceTimersByTime(1100);
    expect(wsInstances).toHaveLength(1); // only the reconnect succeeds

    ws.stop();
  });

  it("should not schedule reconnect when constructor throws after stop", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();
    ws.stop();

    expect(ws.connectionStatus).toBe("disconnected");
  });

  it("should swallow errors thrown by event listeners", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.on("flag_changed", () => {
      throw new Error("listener error");
    });
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("message", JSON.stringify({ type: "connected" }));

    // Should not throw when dispatching to a listener that throws
    mock._emit("message", JSON.stringify({ event: "flag_changed", id: "x" }));

    ws.stop();
  });
});

// ---------------------------------------------------------------------------
// Part 2: FlagsClient change listeners
// ---------------------------------------------------------------------------

import { FlagsClient, FlagChangeEvent } from "../../../src/flags/client.js";
import { SmplError } from "../../../src/errors.js";

const mockFetch = vi.fn();

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
  return new FlagsClient("sk_test", () => lastMockWs as never, 30000);
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFlagListResponse(flags: Array<{ id: string; default?: unknown }>) {
  return jsonResponse({
    data: flags.map((f) => ({
      id: f.id,
      type: "flag",
      attributes: {
        name: f.id,
        type: "BOOLEAN",
        default: f.default ?? false,
        values: [],
        environments: {},
      },
    })),
  });
}

function makeFlagSingleResponse(flag: { id: string; default?: unknown }) {
  return jsonResponse({
    data: {
      id: flag.id,
      type: "flag",
      attributes: {
        name: flag.id,
        type: "BOOLEAN",
        default: flag.default ?? false,
        values: [],
        environments: {},
      },
    },
  });
}

describe("FlagsClient change listeners", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    mockFetch.mockReset();
  });

  describe("onChange(callback) — global listener", () => {
    it("should register a global listener", async () => {
      const client = makeFlagsClient();
      const events: FlagChangeEvent[] = [];
      client.onChange((e) => events.push(e));

      // Connect
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await client._connectInternal("staging");

      // Refresh fires change events
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag", default: true }]));
      await client.refresh();

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("my-flag");
      expect(events[0].source).toBe("manual");
    });

    it("should fire for all flag changes on refresh", async () => {
      const client = makeFlagsClient();
      const keys: string[] = [];
      client.onChange((e) => keys.push(e.id));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a" }, { id: "flag-b" }]));
      await client._connectInternal("staging");

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a" }, { id: "flag-b" }]));
      await client.refresh();

      expect(keys).toContain("flag-a");
      expect(keys).toContain("flag-b");
    });
  });

  describe("onChange(key, callback) — key-scoped listener", () => {
    it("should register a key-scoped listener", async () => {
      const client = makeFlagsClient();
      const events: FlagChangeEvent[] = [];
      client.onChange("my-flag", (e) => events.push(e));

      mockFetch.mockResolvedValueOnce(
        makeFlagListResponse([{ id: "my-flag" }, { id: "other-flag" }]),
      );
      await client._connectInternal("staging");

      mockFetch.mockResolvedValueOnce(
        makeFlagListResponse([{ id: "my-flag" }, { id: "other-flag" }]),
      );
      await client.refresh();

      // Should only have fired for "my-flag"
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("my-flag");
    });

    it("should not fire for other keys", async () => {
      const client = makeFlagsClient();
      const events: FlagChangeEvent[] = [];
      client.onChange("flag-a", (e) => events.push(e));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-b" }]));
      await client._connectInternal("staging");

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-b" }]));
      await client.refresh();

      expect(events).toHaveLength(0);
    });

    it("should throw if callback is missing", () => {
      const client = makeFlagsClient();
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).onChange("my-flag"),
      ).toThrow(SmplError);
    });
  });

  describe("WebSocket _fetchSingleFlag error handling", () => {
    it("should not crash if single flag fetch throws a network error", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await client._connectInternal("staging");

      // Network error during scoped fetch
      mockFetch.mockRejectedValueOnce(new TypeError("network error"));
      // Should not throw
      lastMockWs._emit("flag_changed", { id: "my-flag" });
      await vi.advanceTimersByTimeAsync(100);
    });
  });

  describe("WebSocket event name registration", () => {
    it("should register listeners for flag_changed and flag_deleted on the shared WS", async () => {
      const client = makeFlagsClient();

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await client._connectInternal("staging");

      expect(lastMockWs.on).toHaveBeenCalledWith("flag_changed", expect.any(Function));
      expect(lastMockWs.on).toHaveBeenCalledWith("flag_deleted", expect.any(Function));
    });
  });

  describe("WebSocket flag_changed event", () => {
    it("should fire global and key-scoped listeners when content changed", async () => {
      const client = makeFlagsClient();
      const globalEvents: string[] = [];
      const keyEvents: string[] = [];

      client.onChange((e) => globalEvents.push(e.id));
      client.onChange("my-flag", (e) => keyEvents.push(e.id));

      // Initial state: default = false
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag", default: false }]));
      await client._connectInternal("staging");

      // Scoped re-fetch returns changed content (default = true)
      mockFetch.mockResolvedValueOnce(makeFlagSingleResponse({ id: "my-flag", default: true }));
      lastMockWs._emit("flag_changed", { id: "my-flag" });

      await vi.waitFor(() => {
        expect(globalEvents).toContain("my-flag");
        expect(keyEvents).toContain("my-flag");
      });
    });

    it("should NOT fire listeners when content is unchanged", async () => {
      const client = makeFlagsClient();
      const events: string[] = [];
      client.onChange((e) => events.push(e.id));

      // Initial state: default = false
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag", default: false }]));
      await client._connectInternal("staging");

      // Scoped re-fetch returns same content (default = false)
      mockFetch.mockResolvedValueOnce(makeFlagSingleResponse({ id: "my-flag", default: false }));
      lastMockWs._emit("flag_changed", { id: "my-flag" });

      // Wait for async to settle without running periodic timers
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toHaveLength(0);
    });

    it("should include source 'websocket' in the event", async () => {
      const client = makeFlagsClient();
      const sources: string[] = [];
      client.onChange((e) => sources.push(e.source));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag", default: false }]));
      await client._connectInternal("staging");

      // Return changed content so listener fires
      mockFetch.mockResolvedValueOnce(makeFlagSingleResponse({ id: "my-flag", default: true }));
      lastMockWs._emit("flag_changed", { id: "my-flag" });

      await vi.waitFor(() => expect(sources).toContain("websocket"));
    });

    it("should ignore events without an id field", async () => {
      const client = makeFlagsClient();
      const events: string[] = [];
      client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await client._connectInternal("staging");

      lastMockWs._emit("flag_changed", { type: "flag_changed" });
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toHaveLength(0);
    });
  });

  describe("WebSocket flag_deleted event", () => {
    it("should remove from store and fire listener with deleted=true", async () => {
      const client = makeFlagsClient();
      const receivedEvents: Array<{ id: string; deleted?: boolean }> = [];
      client.onChange((e) => receivedEvents.push({ id: e.id, deleted: e.deleted }));
      client.onChange("del-flag", (e) => receivedEvents.push({ id: e.id, deleted: e.deleted }));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "del-flag" }]));
      await client._connectInternal("staging");

      // flag_deleted should NOT trigger an HTTP fetch
      lastMockWs._emit("flag_deleted", { id: "del-flag" });

      await vi.advanceTimersByTimeAsync(100);
      // Both global and key-scoped listeners fired
      expect(receivedEvents.length).toBeGreaterThanOrEqual(2);
      expect(receivedEvents.every((e) => e.deleted === true)).toBe(true);
      // Should NOT have made another fetch call
      expect(mockFetch).toHaveBeenCalledTimes(1); // only the initial list fetch
    });

    it("should swallow errors from global listeners on flag_deleted", async () => {
      const client = makeFlagsClient();
      const throwingCb = vi.fn(() => {
        throw new Error("global throws on delete");
      });
      const goodCb = vi.fn();
      client.onChange(throwingCb);
      client.onChange(goodCb);

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "del-flag" }]));
      await client._connectInternal("staging");

      lastMockWs._emit("flag_deleted", { id: "del-flag" });
      await vi.advanceTimersByTimeAsync(100);

      expect(throwingCb).toHaveBeenCalledTimes(1);
      expect(goodCb).toHaveBeenCalledTimes(1);
    });

    it("should swallow errors from per-key listeners on flag_deleted", async () => {
      const client = makeFlagsClient();
      const throwingCb = vi.fn(() => {
        throw new Error("key throws on delete");
      });
      const goodCb = vi.fn();
      client.onChange("del-flag", throwingCb);
      client.onChange("del-flag", goodCb);

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "del-flag" }]));
      await client._connectInternal("staging");

      lastMockWs._emit("flag_deleted", { id: "del-flag" });
      await vi.advanceTimersByTimeAsync(100);

      expect(throwingCb).toHaveBeenCalledTimes(1);
      expect(goodCb).toHaveBeenCalledTimes(1);
    });

    it("should fire listeners on flag_deleted even if key is not in store", async () => {
      const client = makeFlagsClient();
      const events: string[] = [];
      client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([]));
      await client._connectInternal("staging");

      lastMockWs._emit("flag_deleted", { id: "unknown-flag" });
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toContain("unknown-flag");
      // Still no additional fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("WebSocket flags_changed event", () => {
    it("should register listener for flags_changed on the shared WS", async () => {
      const client = makeFlagsClient();
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([]));
      await client._connectInternal("staging");

      expect(lastMockWs.on).toHaveBeenCalledWith("flags_changed", expect.any(Function));
    });

    it("should do full list fetch and fire global once + per-key for changed keys", async () => {
      const client = makeFlagsClient();
      const globalEvents: string[] = [];
      const keyAEvents: string[] = [];
      const keyBEvents: string[] = [];

      client.onChange((e) => globalEvents.push(e.id));
      client.onChange("flag-a", (e) => keyAEvents.push(e.id));
      client.onChange("flag-b", (e) => keyBEvents.push(e.id));

      // Initial: flag-a default=false, flag-b default=false
      mockFetch.mockResolvedValueOnce(
        makeFlagListResponse([
          { id: "flag-a", default: false },
          { id: "flag-b", default: false },
        ]),
      );
      await client._connectInternal("staging");

      // Full re-fetch: flag-a unchanged, flag-b changed
      mockFetch.mockResolvedValueOnce(
        makeFlagListResponse([
          { id: "flag-a", default: false },
          { id: "flag-b", default: true },
        ]),
      );
      lastMockWs._emit("flags_changed", {});

      await vi.waitFor(() => {
        // Global fires exactly once
        expect(globalEvents).toHaveLength(1);
        // Per-key: only flag-b changed
        expect(keyAEvents).toHaveLength(0);
        expect(keyBEvents).toHaveLength(1);
      });
    });

    it("should swallow errors from global listeners on flags_changed", async () => {
      const client = makeFlagsClient();
      const throwingCb = vi.fn(() => {
        throw new Error("global throws");
      });
      const goodCb = vi.fn();
      client.onChange(throwingCb);
      client.onChange(goodCb);

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a", default: false }]));
      await client._connectInternal("staging");

      // Content changed to trigger listeners
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a", default: true }]));
      lastMockWs._emit("flags_changed", {});

      await vi.waitFor(() => {
        expect(throwingCb).toHaveBeenCalledTimes(1);
        expect(goodCb).toHaveBeenCalledTimes(1);
      });
    });

    it("should swallow errors from per-key listeners on flags_changed", async () => {
      const client = makeFlagsClient();
      const throwingCb = vi.fn(() => {
        throw new Error("key throws");
      });
      const goodCb = vi.fn();
      client.onChange("flag-a", throwingCb);
      client.onChange("flag-a", goodCb);

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a", default: false }]));
      await client._connectInternal("staging");

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a", default: true }]));
      lastMockWs._emit("flags_changed", {});

      await vi.waitFor(() => {
        expect(throwingCb).toHaveBeenCalledTimes(1);
        expect(goodCb).toHaveBeenCalledTimes(1);
      });
    });

    it("should NOT fire listeners when nothing changed on flags_changed", async () => {
      const client = makeFlagsClient();
      const events: string[] = [];
      client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a", default: false }]));
      await client._connectInternal("staging");

      // Same content
      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-a", default: false }]));
      lastMockWs._emit("flags_changed", {});

      await vi.advanceTimersByTimeAsync(100);
      expect(events).toHaveLength(0);
    });
  });

  describe("Listener error handling", () => {
    it("should swallow errors from global listeners", async () => {
      const client = makeFlagsClient();
      client.onChange(() => {
        throw new Error("listener error");
      });

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await client._connectInternal("staging");

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await expect(client.refresh()).resolves.not.toThrow();
    });

    it("should swallow errors from key-scoped listeners", async () => {
      const client = makeFlagsClient();
      client.onChange("my-flag", () => {
        throw new Error("scoped listener error");
      });

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await client._connectInternal("staging");

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "my-flag" }]));
      await expect(client.refresh()).resolves.not.toThrow();
    });

    it("should still fire other listeners after one throws", async () => {
      const client = makeFlagsClient();
      const events: string[] = [];

      client.onChange(() => {
        throw new Error("first throws");
      });
      client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-1" }]));
      await client._connectInternal("staging");

      mockFetch.mockResolvedValueOnce(makeFlagListResponse([{ id: "flag-1" }]));
      await client.refresh();

      // The second listener should still fire
      expect(events).toContain("flag-1");
    });
  });

  describe("FlagChangeEvent", () => {
    it("should expose id and source", () => {
      const event = new FlagChangeEvent("my-flag", "websocket");
      expect(event.id).toBe("my-flag");
      expect(event.source).toBe("websocket");
    });
  });
});
