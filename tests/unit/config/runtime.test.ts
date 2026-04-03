import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigRuntimeOptions } from "../../../src/config/runtime.js";
import type { ChainConfig } from "../../../src/config/resolve.js";
import type { ConfigChangeEvent } from "../../../src/config/runtime-types.js";

// Create a mock SharedWebSocket to pass into ConfigRuntime
interface MockSharedWs {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  connectionStatus: string;
  _listeners: Record<string, Array<(data: Record<string, unknown>) => void>>;
  _emit: (event: string, data: Record<string, unknown>) => void;
}

function createMockSharedWs(): MockSharedWs {
  const listeners: Record<string, Array<(data: Record<string, unknown>) => void>> = {};
  const mock: MockSharedWs = {
    on: vi.fn((event: string, cb: (data: Record<string, unknown>) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    off: vi.fn((event: string, cb: (data: Record<string, unknown>) => void) => {
      const list = listeners[event];
      if (list) {
        const idx = list.indexOf(cb);
        if (idx !== -1) list.splice(idx, 1);
      }
    }),
    connectionStatus: "connected",
    _listeners: listeners,
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
  };
  return mock;
}

// Mock the ws module so ConfigRuntime doesn't try to import it
vi.mock("ws", () => {
  return { default: vi.fn() };
});

// Import ConfigRuntime after mock
const { ConfigRuntime } = await import("../../../src/config/runtime.js");

function makeChain(overrides?: Partial<ChainConfig>): ChainConfig[] {
  return [
    {
      id: "cfg-1",
      items: { timeout: 30, retries: 3, name: "test" },
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

    it("should register on shared WebSocket when provided", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));
      expect(ws.on).toHaveBeenCalledWith("config_changed", expect.any(Function));
      expect(ws.on).toHaveBeenCalledWith("config_deleted", expect.any(Function));
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
      const chain = makeChain({ items: { flag: true, timeout: 30 } });
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
    it("should report disconnected when no shared WS", async () => {
      const rt = new ConfigRuntime(makeOptions());
      expect(rt.connectionStatus()).toBe("disconnected");
      await rt.close();
    });

    it("should report shared WS status when shared WS is provided", async () => {
      const ws = createMockSharedWs();
      ws.connectionStatus = "connected";
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));
      expect(rt.connectionStatus()).toBe("connected");
      await rt.close();
    });

    it("should report disconnected after close", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));
      await rt.close();
      expect(rt.connectionStatus()).toBe("disconnected");
    });
  });

  describe("SharedWebSocket event handling", () => {
    it("should apply config_changed events and fire listeners", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "retries", old_value: 5, new_value: 10 }],
      });

      expect(rt.get("retries")).toBe(10);
      expect(events).toHaveLength(1);
      expect(events[0].key).toBe("retries");
      expect(events[0].oldValue).toBe(5);
      expect(events[0].newValue).toBe(10);
      expect(events[0].source).toBe("websocket");
      await rt.close();
    });

    it("should handle config_deleted by closing", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      ws._emit("config_deleted", { config_id: "cfg-1" });

      expect(rt.connectionStatus()).toBe("disconnected");
    });

    it("should ignore changes for unknown config IDs", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit("config_changed", {
        config_id: "unknown-id",
        changes: [{ key: "x", old_value: 1, new_value: 2 }],
      });

      expect(events).toHaveLength(0);
      await rt.close();
    });
  });

  describe("_applyChanges edge cases", () => {
    it("should handle deletion (new_value null)", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "retries", old_value: 5, new_value: null }],
      });

      expect(rt.exists("retries")).toBe(false);
      await rt.close();
    });

    it("should handle deletion with undefined new_value", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "retries", old_value: 5 }],
      });

      expect(rt.exists("retries")).toBe(false);
      await rt.close();
    });

    it("should add new keys to base values", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "brand_new_key", old_value: null, new_value: "hello" }],
      });

      expect(rt.get("brand_new_key")).toBe("hello");
      await rt.close();
    });

    it("should update env-specific overrides when key exists in env values", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "timeout", old_value: 60, new_value: 120 }],
      });

      expect(rt.get("timeout")).toBe(120);
      await rt.close();
    });

    it("should update base values when key exists only in base", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "name", old_value: "test", new_value: "updated" }],
      });

      expect(rt.get("name")).toBe("updated");
      await rt.close();
    });

    it("should handle changes when environment entry is null", async () => {
      const ws = createMockSharedWs();
      const chain: ChainConfig[] = [
        {
          id: "cfg-1",
          items: { x: 1 },
          environments: { production: null as unknown as Record<string, unknown> },
        },
      ];
      const rt = new ConfigRuntime(makeOptions({ chain, sharedWs: ws as never }));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "x", old_value: 1, new_value: 2 }],
      });

      expect(rt.get("x")).toBe(2);
      await rt.close();
    });

    it("should handle deletion from env values", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "timeout", old_value: 60, new_value: null }],
      });

      expect(rt.exists("timeout")).toBe(false);
      await rt.close();
    });
  });

  describe("onChange listeners", () => {
    it("should fire for all changes when no key filter", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [
          { key: "retries", old_value: 5, new_value: 7 },
          { key: "name", old_value: "test", new_value: "updated" },
        ],
      });

      expect(events).toHaveLength(2);
      await rt.close();
    });

    it("should fire only for specific key when key filter is set", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e), { key: "retries" });

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [
          { key: "retries", old_value: 5, new_value: 7 },
          { key: "name", old_value: "test", new_value: "updated" },
        ],
      });

      expect(events).toHaveLength(1);
      expect(events[0].key).toBe("retries");
      await rt.close();
    });

    it("should not crash if a listener throws", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      const events: ConfigChangeEvent[] = [];
      rt.onChange(() => {
        throw new Error("bad listener");
      });
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "retries", old_value: 5, new_value: 7 }],
      });

      expect(events).toHaveLength(1);
      await rt.close();
    });

    it("should full re-fetch when config_changed has no granular changes", async () => {
      vi.useRealTimers();

      const updatedChain: ChainConfig[] = [
        {
          id: "cfg-1",
          items: { timeout: 99, retries: 3, name: "test" },
          environments: {
            production: { values: { timeout: 200, retries: 50 } },
          },
        },
      ];

      const fetchChain = vi.fn().mockResolvedValue(updatedChain);
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(
        makeOptions({ sharedWs: ws as never, fetchChain }),
      );

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      // Emit config_changed WITHOUT changes array (no granular changes)
      ws._emit("config_changed", { config_id: "cfg-1" });

      // Wait for the async re-fetch promise chain to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchChain).toHaveBeenCalledOnce();
      expect(rt.get("timeout")).toBe(200);
      expect(rt.get("retries")).toBe(50);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].source).toBe("websocket");

      const stats = rt.stats();
      expect(stats.fetchCount).toBe(2); // initial + re-fetch

      await rt.close();
      vi.useFakeTimers();
    });

    it("should ignore fetch errors during re-fetch on config_changed", async () => {
      vi.useRealTimers();

      const fetchChain = vi.fn().mockRejectedValue(new Error("network error"));
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(
        makeOptions({ sharedWs: ws as never, fetchChain }),
      );

      // Emit config_changed without changes — triggers re-fetch which fails
      ws._emit("config_changed", { config_id: "cfg-1" });

      // Wait for the promise to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(fetchChain).toHaveBeenCalledOnce();
      // Should not throw, values unchanged
      expect(rt.get("timeout")).toBe(60);
      await rt.close();
      vi.useFakeTimers();
    });

    it("should not fire if values did not actually change", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      const events: ConfigChangeEvent[] = [];
      rt.onChange((e: ConfigChangeEvent) => events.push(e));

      ws._emit("config_changed", {
        config_id: "cfg-1",
        changes: [{ key: "retries", old_value: 5, new_value: 5 }],
      });

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
          items: { timeout: 30, retries: 10, name: "updated" },
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
    it("should unregister from shared WS on close", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));

      await rt.close();

      expect(ws.off).toHaveBeenCalledWith("config_changed", expect.any(Function));
      expect(ws.off).toHaveBeenCalledWith("config_deleted", expect.any(Function));
      expect(rt.connectionStatus()).toBe("disconnected");
    });

    it("should be safe to call multiple times", async () => {
      const ws = createMockSharedWs();
      const rt = new ConfigRuntime(makeOptions({ sharedWs: ws as never }));
      await rt.close();
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
});
