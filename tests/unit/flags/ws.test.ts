import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Part 1: SharedWebSocket tests (shared transport infra — src/ws.ts)
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
    mock._emit("message", JSON.stringify({ type: "connected" }));
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
    expect(ws.connectionStatus).toBe("connecting");

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
    mock._emit("message", "not-json{{{");

    ws.stop();
  });

  it("should ignore error events (close handles reconnect)", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
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

    expect(events).toHaveLength(0);
    ws.stop();
  });

  it("should handle URL without protocol prefix", () => {
    const ws = new SharedWebSocket("app.smplkit.com", "sk_test");
    ws.start();
    expect(wsInstances).toHaveLength(1);
    ws.stop();
  });

  it("should close WS if open event fires after stop", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    ws.stop();

    mock._emit("open");
    expect(mock.close).toHaveBeenCalled();
  });

  it("should cancel pending reconnect timer on stop", () => {
    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    const mock = getLastWsInstance();
    mock._emit("close");
    expect(ws.connectionStatus).toBe("connecting");

    ws.stop();
    expect(ws.connectionStatus).toBe("disconnected");

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
    mock._emit("error", new Error("ECONNREFUSED"));
    mock._emit("close");

    expect(ws.connectionStatus).toBe("connecting");

    vi.advanceTimersByTime(1100);
    expect(wsInstances).toHaveLength(2);

    ws.stop();
  });

  it("should schedule reconnect when WebSocket constructor throws", () => {
    WsMock.mockImplementationOnce(() => {
      throw new Error("connection refused");
    });

    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();

    expect(ws.connectionStatus).toBe("connecting");

    WsMock.mockImplementation(() => createMockWs());

    vi.advanceTimersByTime(1100);
    expect(wsInstances).toHaveLength(1);

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
    mock._emit("message", JSON.stringify({ event: "flag_changed", id: "x" }));

    ws.stop();
  });
});

// ---------------------------------------------------------------------------
// Part 2: FlagsClient WebSocket event handlers + change listeners
// ---------------------------------------------------------------------------

import { FlagsClient, FlagChangeEvent } from "../../../src/flags/client.js";
import { SmplError } from "../../../src/errors.js";
import { makeWiredClient, flagListResponse, flagSingleResponse } from "./_helpers.js";

const mockFetch = vi.fn();

/** Connect a wired client (seeds the store from `initial`) and return its harness. */
async function connected(
  initial: Array<{ id: string; default?: unknown }>,
): Promise<ReturnType<typeof makeWiredClient>> {
  const harness = makeWiredClient();
  mockFetch.mockResolvedValueOnce(flagListResponse(initial));
  // _ensureConnected fetches definitions once and registers the WS handlers,
  // without the second fetch + listener fan-out that refresh() performs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (harness.client as any)._ensureConnected();
  return harness;
}

describe("FlagsClient change listeners", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    mockFetch.mockReset();
    vi.unstubAllGlobals();
  });

  describe("onChange(callback) — global listener", () => {
    it("fires on manual refresh", async () => {
      const { client } = await connected([{ id: "my-flag" }]);
      const events: FlagChangeEvent[] = [];
      await client.onChange((e) => events.push(e));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "my-flag", default: true }]));
      await client.refresh();

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("my-flag");
      expect(events[0].source).toBe("manual");
    });

    it("fires for every flag on refresh", async () => {
      const { client } = await connected([{ id: "flag-a" }, { id: "flag-b" }]);
      const keys: string[] = [];
      await client.onChange((e) => keys.push(e.id));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-a" }, { id: "flag-b" }]));
      await client.refresh();

      expect(keys).toContain("flag-a");
      expect(keys).toContain("flag-b");
    });
  });

  describe("onChange(key, callback) — key-scoped listener", () => {
    it("only fires for the matching key", async () => {
      const { client } = await connected([{ id: "my-flag" }, { id: "other" }]);
      const events: FlagChangeEvent[] = [];
      await client.onChange("my-flag", (e) => events.push(e));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "my-flag" }, { id: "other" }]));
      await client.refresh();

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("my-flag");
    });

    it("does not fire for unrelated keys", async () => {
      const { client } = await connected([{ id: "flag-b" }]);
      const events: FlagChangeEvent[] = [];
      await client.onChange("flag-a", (e) => events.push(e));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-b" }]));
      await client.refresh();

      expect(events).toHaveLength(0);
    });

    it("throws when the callback is missing", async () => {
      const { client } = await connected([]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((client as any).onChange("my-flag")).rejects.toThrow(SmplError);
    });
  });

  describe("flag_changed event", () => {
    it("fires global + key-scoped listeners when the content changed", async () => {
      const { client, ws } = await connected([{ id: "my-flag", default: false }]);
      const globalEvents: string[] = [];
      const keyEvents: string[] = [];
      await client.onChange((e) => globalEvents.push(e.id));
      await client.onChange("my-flag", (e) => keyEvents.push(e.id));

      mockFetch.mockResolvedValueOnce(flagSingleResponse({ id: "my-flag", default: true }));
      ws._emit("flag_changed", { id: "my-flag" });

      await vi.waitFor(() => {
        expect(globalEvents).toContain("my-flag");
        expect(keyEvents).toContain("my-flag");
      });
    });

    it("includes source 'websocket'", async () => {
      const { client, ws } = await connected([{ id: "my-flag", default: false }]);
      const sources: string[] = [];
      await client.onChange((e) => sources.push(e.source));

      mockFetch.mockResolvedValueOnce(flagSingleResponse({ id: "my-flag", default: true }));
      ws._emit("flag_changed", { id: "my-flag" });

      await vi.waitFor(() => expect(sources).toContain("websocket"));
    });

    it("does NOT fire listeners when content is unchanged", async () => {
      const { client, ws } = await connected([{ id: "my-flag", default: false }]);
      const events: string[] = [];
      await client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(flagSingleResponse({ id: "my-flag", default: false }));
      ws._emit("flag_changed", { id: "my-flag" });

      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(0);
    });

    it("ignores events without an id", async () => {
      const { client, ws } = await connected([{ id: "my-flag" }]);
      const events: string[] = [];
      await client.onChange((e) => events.push(e.id));

      ws._emit("flag_changed", { type: "flag_changed" });
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledTimes(1); // only the connect fetch
    });

    it("does not crash when the scoped re-fetch throws", async () => {
      const { ws } = await connected([{ id: "my-flag" }]);
      mockFetch.mockRejectedValueOnce(new TypeError("network error"));
      ws._emit("flag_changed", { id: "my-flag" });
      await new Promise((r) => setTimeout(r, 20));
    });

    it("does not crash when the scoped re-fetch returns a non-OK response", async () => {
      const { ws } = await connected([{ id: "my-flag" }]);
      mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
      ws._emit("flag_changed", { id: "my-flag" });
      await new Promise((r) => setTimeout(r, 20));
    });

    it("logs and recovers when the post-fetch update throws", async () => {
      const { client, ws } = await connected([{ id: "my-flag", default: false }]);
      // The single re-fetch resolves with fresh data, but clearing the cache
      // throws — the handler's .catch must swallow it.
      mockFetch.mockResolvedValueOnce(flagSingleResponse({ id: "my-flag", default: true }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any)._cache.clear = () => {
        throw new Error("cache boom");
      };
      expect(() => ws._emit("flag_changed", { id: "my-flag" })).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
    });
  });

  describe("flag_deleted event", () => {
    it("removes from the store and fires listeners with deleted=true (no fetch)", async () => {
      const { client, ws } = await connected([{ id: "del-flag" }]);
      const received: Array<{ id: string; deleted?: boolean }> = [];
      await client.onChange((e) => received.push({ id: e.id, deleted: e.deleted }));
      await client.onChange("del-flag", (e) => received.push({ id: e.id, deleted: e.deleted }));

      ws._emit("flag_deleted", { id: "del-flag" });
      await new Promise((r) => setTimeout(r, 20));

      expect(received.length).toBeGreaterThanOrEqual(2);
      expect(received.every((e) => e.deleted === true)).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1); // no extra fetch
    });

    it("ignores a delete event without an id", async () => {
      const { client, ws } = await connected([{ id: "del-flag" }]);
      const events: string[] = [];
      await client.onChange((e) => events.push(e.id));
      ws._emit("flag_deleted", {});
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(0);
    });

    it("does NOT fire when the key was not in the store", async () => {
      const { client, ws } = await connected([]);
      const events: string[] = [];
      await client.onChange((e) => events.push(e.id));
      ws._emit("flag_deleted", { id: "unknown" });
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(0);
    });

    it("swallows errors thrown by listeners on delete", async () => {
      const { client, ws } = await connected([{ id: "del-flag" }]);
      const good = vi.fn();
      await client.onChange(() => {
        throw new Error("global throws");
      });
      await client.onChange(good);
      await client.onChange("del-flag", () => {
        throw new Error("key throws");
      });
      const goodKey = vi.fn();
      await client.onChange("del-flag", goodKey);

      ws._emit("flag_deleted", { id: "del-flag" });
      await new Promise((r) => setTimeout(r, 20));

      expect(good).toHaveBeenCalled();
      expect(goodKey).toHaveBeenCalled();
    });
  });

  describe("flags_changed event", () => {
    it("re-fetches and fires global once + per-key for changed keys", async () => {
      const { client, ws } = await connected([
        { id: "flag-a", default: false },
        { id: "flag-b", default: false },
      ]);
      const globalEvents: string[] = [];
      const keyAEvents: string[] = [];
      const keyBEvents: string[] = [];
      await client.onChange((e) => globalEvents.push(e.id));
      await client.onChange("flag-a", (e) => keyAEvents.push(e.id));
      await client.onChange("flag-b", (e) => keyBEvents.push(e.id));

      mockFetch.mockResolvedValueOnce(
        flagListResponse([
          { id: "flag-a", default: false },
          { id: "flag-b", default: true },
        ]),
      );
      ws._emit("flags_changed", {});

      await vi.waitFor(() => {
        expect(globalEvents).toHaveLength(1);
        expect(keyAEvents).toHaveLength(0);
        expect(keyBEvents).toHaveLength(1);
      });
    });

    it("fires a per-key deleted event when a flag disappears", async () => {
      const { client, ws } = await connected([
        { id: "flag-a", default: false },
        { id: "gone", default: false },
      ]);
      const deletions: Array<{ id: string; deleted?: boolean }> = [];
      await client.onChange("gone", (e) => deletions.push({ id: e.id, deleted: e.deleted }));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-a", default: false }]));
      ws._emit("flags_changed", {});

      await vi.waitFor(() => {
        expect(deletions).toEqual([{ id: "gone", deleted: true }]);
      });
    });

    it("does NOT fire listeners when nothing changed", async () => {
      const { client, ws } = await connected([{ id: "flag-a", default: false }]);
      const events: string[] = [];
      await client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-a", default: false }]));
      ws._emit("flags_changed", {});

      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(0);
    });

    it("swallows errors thrown by global and per-key listeners", async () => {
      const { client, ws } = await connected([{ id: "flag-a", default: false }]);
      const goodGlobal = vi.fn();
      const goodKey = vi.fn();
      await client.onChange(() => {
        throw new Error("global throws");
      });
      await client.onChange(goodGlobal);
      await client.onChange("flag-a", () => {
        throw new Error("key throws");
      });
      await client.onChange("flag-a", goodKey);

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-a", default: true }]));
      ws._emit("flags_changed", {});

      await vi.waitFor(() => {
        expect(goodGlobal).toHaveBeenCalled();
        expect(goodKey).toHaveBeenCalled();
      });
    });

    it("does not crash when the re-fetch rejects", async () => {
      const { ws } = await connected([{ id: "flag-a" }]);
      mockFetch.mockRejectedValueOnce(new TypeError("network error"));
      ws._emit("flags_changed", {});
      await new Promise((r) => setTimeout(r, 20));
    });
  });

  describe("manual-refresh listener error handling", () => {
    it("swallows errors from global listeners on refresh", async () => {
      const { client } = await connected([{ id: "my-flag" }]);
      await client.onChange(() => {
        throw new Error("listener error");
      });
      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "my-flag" }]));
      await expect(client.refresh()).resolves.not.toThrow();
    });

    it("still fires other listeners after one throws", async () => {
      const { client } = await connected([{ id: "flag-1" }]);
      const events: string[] = [];
      await client.onChange(() => {
        throw new Error("first throws");
      });
      await client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-1" }]));
      await client.refresh();

      expect(events).toContain("flag-1");
    });

    it("swallows errors from key-scoped listeners on refresh", async () => {
      const { client } = await connected([{ id: "my-flag" }]);
      await client.onChange("my-flag", () => {
        throw new Error("scoped listener error");
      });
      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "my-flag" }]));
      await expect(client.refresh()).resolves.not.toThrow();
    });
  });

  describe("FlagChangeEvent", () => {
    it("exposes id, source, and deleted", () => {
      const event = new FlagChangeEvent({ id: "my-flag", source: "websocket", deleted: true });
      expect(event.id).toBe("my-flag");
      expect(event.source).toBe("websocket");
      expect(event.deleted).toBe(true);
    });
  });
});

// Keep the FlagsClient import referenced for type-only environments.
void FlagsClient;
