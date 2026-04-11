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

// Mock global fetch so connect() can work
const mockFetch = vi.fn();

beforeEach(() => {
  wsInstances = [];
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SmplClient WebSocket lifecycle", () => {
  it("should create shared WS on flags._connectInternal and close it", async () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "test-svc",
    });

    // Mock the flags list response for _connectInternal()
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await client.flags._connectInternal("staging");

    // A WebSocket should have been created
    expect(wsInstances).toHaveLength(1);

    // close() should stop the shared WS
    client.close();
    expect(wsInstances[0].close).toHaveBeenCalled();
  });

  it("should reuse the shared WS across connects", async () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "test-svc",
    });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.flags._connectInternal("staging");
    const wsCountAfterFirst = wsInstances.length;

    // Disconnect flags and reconnect — should reuse the same SharedWebSocket
    await client.flags.disconnect();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.flags._connectInternal("production");

    // No additional WS constructor calls since SharedWebSocket is already running
    expect(wsInstances).toHaveLength(wsCountAfterFirst);

    client.close();
  });

  it("should be safe to close twice", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "test-svc",
    });
    // no WS created yet
    client.close();
    client.close();
  });
});

describe("SharedWebSocket — metrics gauge on connect/disconnect", () => {
  it("should record gauge 1 on connected message and 0 on close", () => {
    const metrics = new MetricsReporter({
      apiKey: "sk_test",
      environment: "test",
      service: "test-svc",
    });
    const gaugeSpy = vi.spyOn(metrics, "recordGauge");

    const ws = new SharedWebSocket("https://app.smplkit.com", "sk_test", metrics);
    ws.start();

    // The mock WS constructor should have been called
    expect(wsInstances).toHaveLength(1);
    const mockWsInstance = wsInstances[0];

    // Find the message handler and simulate "connected"
    const messageCall = mockWsInstance.on.mock.calls.find((c: any[]) => c[0] === "message");
    expect(messageCall).toBeDefined();
    const messageHandler = messageCall![1];

    // Simulate connected message
    messageHandler(JSON.stringify({ type: "connected" }));
    expect(gaugeSpy).toHaveBeenCalledWith("platform.websocket_connections", 1, "connections");

    // Find the close handler and simulate close
    gaugeSpy.mockClear();
    const closeCall = mockWsInstance.on.mock.calls.find((c: any[]) => c[0] === "close");
    expect(closeCall).toBeDefined();
    const closeHandler = closeCall![1];

    closeHandler();
    expect(gaugeSpy).toHaveBeenCalledWith("platform.websocket_connections", 0, "connections");

    ws.stop();
    metrics.close();
  });
});
