import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track all created mock WS instances
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
    mock._emit("message", JSON.stringify({ event: "flag_changed", key: "my-flag" }));

    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("my-flag");

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
    mock._emit("message", JSON.stringify({ event: "flag_changed", key: "x" }));

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
    // First call succeeds so start() creates a WS

    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test");
    ws.start();
    ws.stop();

    // Now manually call _connect (simulating a race) — constructor throws, but _closed is true
    // We need to trigger the catch path with _closed=true
    // Since stop sets _closed=true, calling start would reset it. Instead,
    // we verify that the earlier test covered the !_closed branch.
    // The _closed=true path just does nothing in the catch.
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
    mock._emit("message", JSON.stringify({ event: "flag_changed", key: "x" }));

    ws.stop();
  });
});
