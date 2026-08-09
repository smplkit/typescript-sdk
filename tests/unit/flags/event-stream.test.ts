import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FlagsClient live-event handlers + change listeners, driven through a mock
// shared live stream (the EventStream transport itself is covered in
// tests/unit/event-stream.test.ts).

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
  // _ensureConnected fetches definitions once and registers the event
  // handlers, without the second fetch + listener fan-out that refresh()
  // performs.
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

    it("includes source 'push'", async () => {
      const { client, ws } = await connected([{ id: "my-flag", default: false }]);
      const sources: string[] = [];
      await client.onChange((e) => sources.push(e.source));

      mockFetch.mockResolvedValueOnce(flagSingleResponse({ id: "my-flag", default: true }));
      ws._emit("flag_changed", { id: "my-flag" });

      await vi.waitFor(() => expect(sources).toContain("push"));
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

  describe("reconnect refetch", () => {
    it("registers a refetch callback with the shared stream on connect", async () => {
      const { ws } = await connected([{ id: "flag-a" }]);
      expect(ws.onReconnect).toHaveBeenCalledTimes(1);
      expect(ws.onReconnect).toHaveBeenCalledWith(expect.any(Function));
    });

    it("performs the full bulk refresh when the stream reconnects", async () => {
      const { client, ws } = await connected([{ id: "flag-a", default: false }]);
      const events: FlagChangeEvent[] = [];
      await client.onChange((e) => events.push(e));

      // While "disconnected", flag-a changed server-side; on reconnect the
      // refetch picks it up and fires listeners with the push source.
      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-a", default: true }]));
      ws._fireReconnect();

      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
        expect(events[0].id).toBe("flag-a");
        expect(events[0].source).toBe("push");
      });
    });

    it("does not fire listeners when the reconnect refetch finds no changes", async () => {
      const { client, ws } = await connected([{ id: "flag-a", default: false }]);
      const events: string[] = [];
      await client.onChange((e) => events.push(e.id));

      mockFetch.mockResolvedValueOnce(flagListResponse([{ id: "flag-a", default: false }]));
      ws._fireReconnect();

      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(0);
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
      const event = new FlagChangeEvent({ id: "my-flag", source: "push", deleted: true });
      expect(event.id).toBe("my-flag");
      expect(event.source).toBe("push");
      expect(event.deleted).toBe(true);
    });
  });
});

// Keep the FlagsClient import referenced for type-only environments.
void FlagsClient;
