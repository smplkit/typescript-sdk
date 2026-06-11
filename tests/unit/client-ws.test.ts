import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsReporter } from "../../src/_metrics.js";

// Mock the ws module before importing SmplClient
let wsInstances: Array<{
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("ws", () => {
  class MockWebSocket {
    on = vi.fn();
    send = vi.fn();
    close = vi.fn();
    constructor() {
      wsInstances.push(this as unknown as (typeof wsInstances)[number]);
    }
  }
  return { default: MockWebSocket };
});

const { SmplClient } = await import("../../src/client.js");
const { SharedWebSocket } = await import("../../src/ws.js");

// Mock global fetch so the fire-and-forget service-context registration and any
// connect() calls have something to resolve against.
const mockFetch = vi.fn();

const DEFAULT_OPTS = {
  apiKey: "sk_api_test",
  environment: "test",
  service: "test-svc",
  disableTelemetry: true,
};

beforeEach(() => {
  wsInstances = [];
  vi.stubGlobal("fetch", mockFetch);
  // Fresh Response per call — a single shared Response body can only be read once.
  mockFetch.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SmplClient WebSocket lifecycle", () => {
  it("lazily creates the shared WS on _ensureWs() and tears it down on close()", () => {
    const client = new SmplClient(DEFAULT_OPTS);

    // No WS yet — construction is side-effect-free.
    expect(wsInstances).toHaveLength(0);

    const ws = client._ensureWs();
    expect(ws).toBeInstanceOf(SharedWebSocket);
    // The underlying mock WebSocket was constructed by SharedWebSocket.start().
    expect(wsInstances).toHaveLength(1);

    // close() should stop the shared WS (mock .close() invoked).
    client.close();
    expect(wsInstances[0].close).toHaveBeenCalled();
  });

  it("reuses the same shared WS across repeated _ensureWs() calls", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    const first = client._ensureWs();
    const second = client._ensureWs();
    expect(second).toBe(first);
    expect(wsInstances).toHaveLength(1);
    client.close();
  });

  it("opens the shared WS when flags connect lazily", async () => {
    const client = new SmplClient(DEFAULT_OPTS);
    await client.flags._ensureConnected();
    expect(wsInstances.length).toBeGreaterThanOrEqual(1);
    client.close();
  });

  it("is safe to close before any WS is created", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(wsInstances).toHaveLength(0);
    expect(() => client.close()).not.toThrow();
  });

  it("is safe to close twice", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    client._ensureWs();
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});

describe("SharedWebSocket — metrics gauge on connect/disconnect", () => {
  it("records gauge 1 on connected message and 0 on close", () => {
    const metrics = new MetricsReporter({
      apiKey: "sk_test",
      environment: "test",
      service: "test-svc",
    });
    const gaugeSpy = vi.spyOn(metrics, "recordGauge");

    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test", metrics);
    ws.start();

    expect(wsInstances).toHaveLength(1);
    const mockWsInstance = wsInstances[0];

    // Find the message handler and simulate "connected".
    const messageCall = mockWsInstance.on.mock.calls.find((c: unknown[]) => c[0] === "message");
    expect(messageCall).toBeDefined();
    const messageHandler = messageCall![1];
    messageHandler(JSON.stringify({ type: "connected" }));
    expect(gaugeSpy).toHaveBeenCalledWith("platform.websocket_connections", 1, "connections");

    // Find the close handler and simulate close.
    gaugeSpy.mockClear();
    const closeCall = mockWsInstance.on.mock.calls.find((c: unknown[]) => c[0] === "close");
    expect(closeCall).toBeDefined();
    const closeHandler = closeCall![1];
    closeHandler();
    expect(gaugeSpy).toHaveBeenCalledWith("platform.websocket_connections", 0, "connections");

    ws.stop();
    metrics.close();
  });
});
