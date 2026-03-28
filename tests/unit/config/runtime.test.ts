import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigRuntimeOptions } from "../../../src/config/runtime.js";
import type { ChainConfig } from "../../../src/config/resolve.js";
import type { ConfigChangeEvent } from "../../../src/config/runtime-types.js";

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

let shouldThrowOnConstruct = false;

vi.mock("ws", () => {
  const MockWebSocket = vi.fn().mockImplementation(() => {
    if (shouldThrowOnConstruct) {
      shouldThrowOnConstruct = false;
      throw new Error("connection refused");
    }
    return createMockWs();
  });
  return { default: MockWebSocket };
});

// Must import AFTER vi.mock
import WebSocket from "ws";
const { ConfigRuntime } = await import("../../../src/config/runtime.js");

function getLastWsInstance(): MockWsInstance {
  return wsInstances[wsInstances.length - 1];
}

function makeChain(overrides?: Partial<ChainConfig>): ChainConfig[] {
  return [
    {
      id: "cfg-1",
      values: { timeout: 30, retries: 3, name: "test" },
      environments: {
        production: { values: { timeout: 60, retries: 5 } },
      },
      ...overrides,
    },
  ];
}

function makeOptions(overrides?: Partial<ConfigRuntimeOptions>): ConfigRuntimeOptions {
  return {
    configKey: "my_config",
    configId: "cfg-1",
    environment: "production",
    chain: makeChain(),
    apiKey: "sk_test",
    baseUrl: "https://config.smplkit.com",
    fetchChain: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  wsInstances = [];
  (WebSocket as unknown as ReturnType<typeof vi.fn>).mockClear();
  shouldThrowOnConstruct = false;
});

afterEach(async () => {
  vi.useRealTimers();
});

describe("ConfigRuntime", () => {
  describe("constructor and initial cache", () => {
    it("should resolve chain and populate cache on construction", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(rt.get("timeout")).toBe(60);
      expect(rt.get("retries")).toBe(5);
      expect(rt.get("name")).toBe("test");
      await rt.close();
    });

    it("should set initial stats", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const stats = rt.stats();
      expect(stats.fetchCount).toBe(1);
      expect(stats.lastFetchAt).toBeTruthy();
      await rt.close();
    });

    it("should start WebSocket connection", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(WebSocket).toHaveBeenCalledTimes(1);
      const wsUrl = (WebSocket as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(wsUrl).toBe("wss://config.smplkit.com/api/ws/v1/configs?api_key=sk_test");
      await rt.close();
    });
  });

  describe("value accessors", () => {
    it("get should return value or default", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(rt.get("timeout")).toBe(60);
      expect(rt.get("nonexistent")).toBeNull();
      expect(rt.get("nonexistent", "fallback")).toBe("fallback");
      await rt.close();
    });

    it("getString should return string or default", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(rt.getString("name")).toBe("test");
      expect(rt.getString("timeout")).toBeNull();
      expect(rt.getString("timeout", "default")).toBe("default");
      expect(rt.getString("nonexistent")).toBeNull();
      await rt.close();
    });

    it("getInt should return number or default", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(rt.getInt("timeout")).toBe(60);
      expect(rt.getInt("name")).toBeNull();
      expect(rt.getInt("name", 99)).toBe(99);
      expect(rt.getInt("nonexistent")).toBeNull();
      await rt.close();
    });

    it("getBool should return boolean or default", async () => {
      const chain = makeChain({ values: { flag: true, timeout: 30 } });
      const rt = new ConfigRuntime(makeOptions({ chain }));
      expect(rt.getBool("flag")).toBe(true);
      expect(rt.getBool("timeout")).toBeNull();
      expect(rt.getBool("timeout", false)).toBe(false);
      expect(rt.getBool("nonexistent")).toBeNull();
      await rt.close();
    });

    it("exists should check cache presence", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(rt.exists("timeout")).toBe(true);
      expect(rt.exists("nonexistent")).toBe(false);
      await rt.close();
    });

    it("getAll should return shallow copy of cache", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const all = rt.getAll();
      expect(all).toEqual({ timeout: 60, retries: 5, name: "test" });
      all.timeout = 999;
      expect(rt.get("timeout")).toBe(60);
      await rt.close();
    });
  });

  describe("connectionStatus", () => {
    it("should report connecting initially", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(rt.connectionStatus()).toBe("connecting");
      await rt.close();
    });

    it("should report connected after WebSocket open", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");
      expect(rt.connectionStatus()).toBe("connected");
      await rt.close();
    });

    it("should report disconnected after close", async () => {
      const rt = new ConfigRuntime(makeOptions());
      await rt.close();
      expect(rt.connectionStatus()).toBe("disconnected");
    });
  });

  describe("WebSocket URL building", () => {
    it("should convert https to wss", async () => {
      const rt = new ConfigRuntime(makeOptions({ baseUrl: "https://example.com" }));
      const wsUrl = (WebSocket as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(wsUrl).toMatch(/^wss:\/\/example\.com/);
      await rt.close();
    });

    it("should convert http to ws", async () => {
      const rt = new ConfigRuntime(makeOptions({ baseUrl: "http://localhost:3000" }));
      const wsUrl = (WebSocket as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(wsUrl).toMatch(/^ws:\/\/localhost:3000/);
      await rt.close();
    });

    it("should default to wss for bare hostnames", async () => {
      const rt = new ConfigRuntime(makeOptions({ baseUrl: "config.smplkit.com" }));
      const wsUrl = (WebSocket as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(wsUrl).toMatch(/^wss:\/\/config\.smplkit\.com/);
      await rt.close();
    });

    it("should strip trailing slash from base URL", async () => {
      const rt = new ConfigRuntime(makeOptions({ baseUrl: "https://example.com/" }));
      const wsUrl = (WebSocket as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(wsUrl).toContain("wss://example.com/api/ws/v1/configs");
      expect(wsUrl).not.toContain("//api");
      await rt.close();
    });
  });

  describe("WebSocket open sends subscribe", () => {
    it("should send subscribe message on open", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "subscribe",
          config_id: "cfg-1",
          environment: "production",
        }),
      );
      await rt.close();
    });

    it("should close ws immediately if runtime was closed before open fires", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      await rt.close();

      ws._emit("open");
      expect(ws.close).toHaveBeenCalled();
    });
  });

  describe("WebSocket message handling", () => {
    it("should apply config_changed messages and fire listeners", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "retries", old_value: 5, new_value: 10 }],
        }),
      );

      expect(rt.get("retries")).toBe(10);
      expect(events).toHaveLength(1);
      expect(events[0].key).toBe("retries");
      expect(events[0].oldValue).toBe(5);
      expect(events[0].newValue).toBe(10);
      expect(events[0].source).toBe("websocket");
      await rt.close();
    });

    it("should handle config_deleted by closing", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_deleted",
          config_id: "cfg-1",
        }),
      );

      expect(rt.connectionStatus()).toBe("disconnected");
    });

    it("should ignore messages for unknown config IDs", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "unknown-id",
          changes: [{ key: "x", old_value: 1, new_value: 2 }],
        }),
      );

      expect(events).toHaveLength(0);
      await rt.close();
    });

    it("should ignore unparseable messages", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit("message", "not json {{{");
      expect(rt.get("timeout")).toBe(60);
      await rt.close();
    });

    it("should ignore subscribed and error message types", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit(
        "message",
        JSON.stringify({ type: "subscribed", config_id: "cfg-1", environment: "production" }),
      );
      ws._emit("message", JSON.stringify({ type: "error", message: "some error" }));

      expect(events).toHaveLength(0);
      await rt.close();
    });
  });

  describe("_applyChanges edge cases", () => {
    it("should handle deletion (new_value null)", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "retries", old_value: 5, new_value: null }],
        }),
      );

      expect(rt.exists("retries")).toBe(false);
      await rt.close();
    });

    it("should handle deletion with undefined new_value", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "retries", old_value: 5 }],
        }),
      );

      // undefined serializes to absent in JSON, which becomes undefined on parse
      // The code checks `new_value === null || new_value === undefined`
      expect(rt.exists("retries")).toBe(false);
      await rt.close();
    });

    it("should add new keys to base values", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "brand_new_key", old_value: null, new_value: "hello" }],
        }),
      );

      expect(rt.get("brand_new_key")).toBe("hello");
      await rt.close();
    });

    it("should update env-specific overrides when key exists in env values", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "timeout", old_value: 60, new_value: 120 }],
        }),
      );

      expect(rt.get("timeout")).toBe(120);
      await rt.close();
    });

    it("should update base values when key exists only in base", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "name", old_value: "test", new_value: "updated" }],
        }),
      );

      expect(rt.get("name")).toBe("updated");
      await rt.close();
    });

    it("should handle changes when environment entry is null", async () => {
      const chain: ChainConfig[] = [
        {
          id: "cfg-1",
          values: { x: 1 },
          environments: { production: null as unknown as Record<string, unknown> },
        },
      ];
      const rt = new ConfigRuntime(makeOptions({ chain }));
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "x", old_value: 1, new_value: 2 }],
        }),
      );

      expect(rt.get("x")).toBe(2);
      await rt.close();
    });

    it("should handle deletion from env values", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "timeout", old_value: 60, new_value: null }],
        }),
      );

      expect(rt.exists("timeout")).toBe(false);
      await rt.close();
    });
  });

  describe("onChange listeners", () => {
    it("should fire for all changes when no key filter", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [
            { key: "retries", old_value: 5, new_value: 7 },
            { key: "name", old_value: "test", new_value: "updated" },
          ],
        }),
      );

      expect(events).toHaveLength(2);
      await rt.close();
    });

    it("should fire only for specific key when key filter is set", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e), { key: "retries" });

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [
            { key: "retries", old_value: 5, new_value: 7 },
            { key: "name", old_value: "test", new_value: "updated" },
          ],
        }),
      );

      expect(events).toHaveLength(1);
      expect(events[0].key).toBe("retries");
      await rt.close();
    });

    it("should not crash if a listener throws", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      const events: ConfigChangeEvent[] = [];
      rt.onChange(() => {
        throw new Error("bad listener");
      });
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "retries", old_value: 5, new_value: 7 }],
        }),
      );

      expect(events).toHaveLength(1);
      await rt.close();
    });

    it("should not fire if values did not actually change", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();
      ws._emit("open");

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit(
        "message",
        JSON.stringify({
          type: "config_changed",
          config_id: "cfg-1",
          changes: [{ key: "retries", old_value: 5, new_value: 5 }],
        }),
      );

      expect(events).toHaveLength(0);
      await rt.close();
    });
  });

  describe("refresh", () => {
    it("should throw if no fetchChain provided", async () => {
      const rt = new ConfigRuntime(makeOptions({ fetchChain: null }));
      await expect(rt.refresh()).rejects.toThrow("No fetchChain function provided");
      await rt.close();
    });

    it("should re-fetch chain, update cache, and fire listeners", async () => {
      const updatedChain: ChainConfig[] = [
        {
          id: "cfg-1",
          values: { timeout: 30, retries: 10, name: "updated" },
          environments: {
            production: { values: { timeout: 120, retries: 15 } },
          },
        },
      ];

      const fetchChain = vi.fn().mockResolvedValue(updatedChain);
      const rt = new ConfigRuntime(makeOptions({ fetchChain }));

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      await rt.refresh();

      expect(fetchChain).toHaveBeenCalledOnce();
      expect(rt.get("timeout")).toBe(120);
      expect(rt.get("retries")).toBe(15);
      expect(rt.get("name")).toBe("updated");

      expect(events.length).toBeGreaterThan(0);

      const stats = rt.stats();
      expect(stats.fetchCount).toBe(2);
      expect(stats.lastFetchAt).toBeTruthy();

      await rt.close();
    });
  });

  describe("close", () => {
    it("should close WebSocket and clear timers", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();

      await rt.close();

      expect(ws.close).toHaveBeenCalled();
      expect(rt.connectionStatus()).toBe("disconnected");
    });

    it("should be safe to call multiple times", async () => {
      const rt = new ConfigRuntime(makeOptions());
      await rt.close();
      await rt.close();
      expect(rt.connectionStatus()).toBe("disconnected");
    });

    it("should cancel pending reconnect timer", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();

      ws._emit("close");
      await rt.close();
      expect(rt.connectionStatus()).toBe("disconnected");
    });
  });

  describe("Symbol.asyncDispose", () => {
    it("should call close", async () => {
      const rt = new ConfigRuntime(makeOptions());
      await rt[Symbol.asyncDispose]();
      expect(rt.connectionStatus()).toBe("disconnected");
    });
  });

  describe("reconnect behavior", () => {
    it("should schedule reconnect on close event", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();

      ws._emit("close");
      expect(rt.connectionStatus()).toBe("connecting");

      await rt.close();
    });

    it("should not reconnect if closed", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();

      await rt.close();

      const initialCallCount = wsInstances.length;
      ws._emit("close");

      vi.advanceTimersByTime(60_000);
      expect(wsInstances.length).toBe(initialCallCount);
    });

    it("should resync cache on reconnect when fetchChain is available", async () => {
      const updatedChain: ChainConfig[] = [
        {
          id: "cfg-1",
          values: { timeout: 999, retries: 3, name: "refreshed" },
          environments: { production: { values: { timeout: 1000 } } },
        },
      ];
      const fetchChain = vi.fn().mockResolvedValue(updatedChain);
      const rt = new ConfigRuntime(makeOptions({ fetchChain }));
      const ws = getLastWsInstance();

      ws._emit("close");

      await vi.advanceTimersByTimeAsync(1100);

      expect(fetchChain).toHaveBeenCalled();
      expect(rt.get("timeout")).toBe(1000);

      await rt.close();
    });

    it("should reconnect without fetchChain (no resync)", async () => {
      const rt = new ConfigRuntime(makeOptions({ fetchChain: null }));
      const ws = getLastWsInstance();

      const initialCount = wsInstances.length;
      ws._emit("close");

      vi.advanceTimersByTime(1100);
      expect(wsInstances.length).toBe(initialCount + 1);

      await rt.close();
    });

    it("should handle fetchChain failure gracefully during reconnect", async () => {
      const fetchChain = vi.fn().mockRejectedValue(new Error("network error"));
      const rt = new ConfigRuntime(makeOptions({ fetchChain }));
      const ws = getLastWsInstance();

      ws._emit("close");
      await vi.advanceTimersByTimeAsync(1100);

      expect(wsInstances.length).toBeGreaterThan(1);

      await rt.close();
    });

    it("should use exponential backoff", async () => {
      const rt = new ConfigRuntime(makeOptions({ fetchChain: null }));

      // First disconnect
      getLastWsInstance()._emit("close");
      vi.advanceTimersByTime(1100); // backoff[0] = 1000ms

      getLastWsInstance()._emit("close");
      vi.advanceTimersByTime(2100); // backoff[1] = 2000ms

      expect(wsInstances.length).toBe(3);

      await rt.close();
    });

    it("should not schedule reconnect if _scheduleReconnect is called after close", async () => {
      const rt = new ConfigRuntime(makeOptions({ fetchChain: null }));
      await rt.close();

      const callCount = wsInstances.length;
      vi.advanceTimersByTime(120_000);
      expect(wsInstances.length).toBe(callCount);
    });
  });

  describe("WebSocket constructor failure", () => {
    it("should schedule reconnect if WebSocket constructor throws", async () => {
      shouldThrowOnConstruct = true;

      const rt = new ConfigRuntime(makeOptions({ fetchChain: null }));

      // Should have tried once and failed, then schedule reconnect
      vi.advanceTimersByTime(1100);

      // A second WS attempt should have been made
      expect(wsInstances.length).toBe(1); // only the reconnect succeeded

      await rt.close();
    });
  });

  describe("WebSocket error event", () => {
    it("should handle error event (close will follow)", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const ws = getLastWsInstance();

      ws._emit("error", new Error("ws error"));
      ws._emit("close");

      expect(rt.connectionStatus()).toBe("connecting");
      await rt.close();
    });
  });

  describe("_connectWebSocket when already closed", () => {
    it("should not create WebSocket when already closed", async () => {
      const rt = new ConfigRuntime(makeOptions());
      const initialCount = wsInstances.length;

      await rt.close();

      vi.advanceTimersByTime(120_000);
      expect(wsInstances.length).toBe(initialCount);
    });
  });
});
