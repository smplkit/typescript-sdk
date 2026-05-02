/**
 * Tests for FlagsClient runtime helpers — initialize, disconnect, refresh,
 * evaluate, contextProvider, connectionStatus, change listeners, and
 * fetch-error wrapping.
 *
 * Management/CRUD on flags lives in tests/unit/management/management_flags.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagsClient } from "../../../src/flags/client.js";
import { Context } from "../../../src/flags/types.js";
import { SmplConnectionError } from "../../../src/errors.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

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

function makeFlagsClient(): FlagsClient {
  const ws = createMockSharedWs();
  return new FlagsClient(API_KEY, () => ws as never, 30000);
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("FlagsClient runtime", () => {
  it("should connect via _connectInternal and evaluate flags", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "My Flag",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: {
                staging: { enabled: true, rules: [] },
              },
            },
          },
        ],
      }),
    );

    await client._connectInternal("staging");

    const handle = client.booleanFlag("my-flag", false);
    expect(handle.get()).toBe(false);
  });

  it("should disconnect and clear state", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.disconnect();

    expect(client.connectionStatus()).toBe("disconnected");
  });

  it("should initialize idempotently", async () => {
    const client = makeFlagsClient();
    client._parent = { _environment: "staging", _service: null, _metrics: null };

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.initialize();

    // Second call should not make another fetch
    await client.initialize();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should evaluate without being initialized (fetch-on-demand)", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "color",
            type: "flag",
            attributes: {
              name: "Color",
              type: "STRING",
              default: "red",
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: "blue" }],
                },
              },
            },
          },
        ],
      }),
    );

    const result = await client.evaluate("color", {
      environment: "staging",
      context: [new Context("user", "u-1", { plan: "enterprise" })],
    });
    expect(result).toBe("blue");
  });

  it("should return null for unknown flag in evaluate()", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const result = await client.evaluate("nonexistent", {
      environment: "staging",
      context: [new Context("user", "u-1")],
    });
    expect(result).toBeNull();
  });

  it("should use local store for evaluate() once initialized", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "color",
            type: "flag",
            attributes: {
              name: "Color",
              type: "STRING",
              default: "red",
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: "blue" }],
                },
              },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    const result = await client.evaluate("color", {
      environment: "staging",
      context: [new Context("user", "u-1", { plan: "enterprise" })],
    });
    expect(result).toBe("blue");

    // Only 1 fetch (for _connectInternal), not 2
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should auto-inject service context in evaluate()", async () => {
    const client = makeFlagsClient();
    client._parent = { _environment: "staging", _service: "my-svc", _metrics: null };

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "svc-flag",
            type: "flag",
            attributes: {
              name: "Service Flag",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: {
                staging: {
                  enabled: true,
                  rules: [{ logic: { "==": [{ var: "service.key" }, "my-svc"] }, value: true }],
                },
              },
            },
          },
        ],
      }),
    );

    const result = await client.evaluate("svc-flag", {
      environment: "staging",
      context: [],
    });
    expect(result).toBe(true);
  });

  it("should refresh and fire listeners", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: {},
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    const changes: string[] = [];
    client.onChange((e) => changes.push(e.id));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: true,
              values: [],
              environments: {},
            },
          },
        ],
      }),
    );
    await client.refresh();

    expect(changes).toContain("my-flag");
  });

  it("should return WS connectionStatus when connected", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    expect(client.connectionStatus()).toBe("connected");
  });

  it("should support contextProvider decorator-style alias", () => {
    const client = makeFlagsClient();

    const fn = client.contextProvider(() => [new Context("user", "u-1", { plan: "free" })]);
    expect(fn).toBeTypeOf("function");
    expect(fn()).toHaveLength(1);
  });

  it("should return code default when flag evaluates to null", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "null-flag",
            type: "flag",
            attributes: {
              name: "NF",
              type: "STRING",
              default: null,
              values: [],
              environments: {
                staging: { enabled: true, rules: [] },
              },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    const handle = client.stringFlag("null-flag", "fallback");
    expect(handle.get()).toBe("fallback");
  });

  it("should wrap _fetchFlagsList errors via wrapFetchError", async () => {
    const client = makeFlagsClient();

    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(client._connectInternal("staging")).rejects.toThrow(SmplConnectionError);
  });

  it("should auto-flush context buffer when it reaches batch size", async () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: { staging: { enabled: true, rules: [] } },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    for (let i = 0; i < 100; i++) {
      buffer.observe([new Context("user", `u-${i}`, { plan: "free" })]);
    }

    client.setContextProvider(() => [new Context("user", "u-trigger", { plan: "enterprise" })]);

    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    const handle = client.booleanFlag("my-flag", false);
    handle.get();

    await new Promise((r) => setTimeout(r, 10));
  });

  it("should silently swallow errors from auto-flush context POST", async () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "my-flag",
            type: "flag",
            attributes: {
              name: "F",
              type: "BOOLEAN",
              default: false,
              values: [],
              environments: { staging: { enabled: true, rules: [] } },
            },
          },
        ],
      }),
    );
    await client._connectInternal("staging");

    // Fill buffer past the auto-flush threshold
    for (let i = 0; i < 100; i++) {
      buffer.observe([new Context("user", `u-${i}`, { plan: "free" })]);
    }

    client.setContextProvider(() => [new Context("user", "u-trigger", { plan: "enterprise" })]);

    // Context bulk POST will fail — should be silently swallowed
    mockFetch.mockRejectedValueOnce(new TypeError("Network error"));

    const handle = client.booleanFlag("my-flag", false);
    // Should NOT throw even though the background context flush fails
    expect(() => handle.get()).not.toThrow();

    await new Promise((r) => setTimeout(r, 10));
  });

  it("should re-throw non-abort errors from custom fetch wrapper", async () => {
    const client = makeFlagsClient();

    mockFetch.mockImplementationOnce(() => {
      throw new Error("unexpected fetch error");
    });

    await expect(client._connectInternal("staging")).rejects.toThrow(SmplConnectionError);
  });

  it("should throw SmplTimeoutError on AbortError from custom fetch wrapper", async () => {
    const ws = createMockSharedWs();
    const client = new FlagsClient(API_KEY, () => ws as never, 1);
    mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

    await expect(client._connectInternal("staging")).rejects.toThrow(/timed out/);
  });

  it("should map non-OK list responses through checkError", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

    await expect(client._connectInternal("staging")).rejects.toThrow(/HTTP 500/);
  });
});
