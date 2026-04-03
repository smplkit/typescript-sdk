import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      wsInstances.push(this as any);
    }
  }
  return { default: MockWebSocket };
});

const { SmplClient } = await import("../../src/client.js");

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
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });

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
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });

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
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    // no WS created yet
    client.close();
    client.close();
  });
});
