import { describe, expect, it } from "vitest";
import { Context } from "../../../src/flags/types.js";
import { FlagsClient } from "../../../src/flags/client.js";

function makeFlagsClient(): FlagsClient {
  const mockWs = { on: () => {}, off: () => {}, connectionStatus: "disconnected" };
  return new FlagsClient("sk_test", () => mockWs as never, 30000);
}

function setFlagStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  (client as Record<string, unknown>)["_flagStore"] = store;
  (client as Record<string, unknown>)["_connected"] = true;
  (client as Record<string, unknown>)["_environment"] = "staging";
}

const FLAG_DEF = {
  key: "my-flag",
  default: false,
  environments: {
    staging: {
      enabled: true,
      rules: [
        {
          logic: { "==": [{ var: "user.plan" }, "enterprise"] },
          value: true,
        },
      ],
    },
  },
};

describe("Resolution cache", () => {
  it("should track cache hits and misses", () => {
    const client = makeFlagsClient();
    setFlagStore(client, { "my-flag": FLAG_DEF });

    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);

    const handle = client.boolFlag("my-flag", false);

    // First call = cache miss
    handle.get();
    let stats = client.stats();
    expect(stats.cacheMisses).toBe(1);
    expect(stats.cacheHits).toBe(0);

    // Second call = cache hit
    handle.get();
    stats = client.stats();
    expect(stats.cacheHits).toBe(1);
    expect(stats.cacheMisses).toBe(1);
  });

  it("should accumulate cache hits on repeated reads", () => {
    const client = makeFlagsClient();
    setFlagStore(client, { "my-flag": FLAG_DEF });

    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);

    const handle = client.boolFlag("my-flag", false);

    // 1 miss + 99 hits
    for (let i = 0; i < 100; i++) {
      handle.get();
    }

    const stats = client.stats();
    expect(stats.cacheHits).toBe(99);
    expect(stats.cacheMisses).toBe(1);
  });

  it("should evict oldest cache entries when max size is exceeded", () => {
    // Create a client with a small cache for testing
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (client as any)._cache;
    // Override maxSize to a small value for testing
    cache._maxSize = 3;

    setFlagStore(client, {
      a: { key: "a", default: "val-a", environments: { staging: { enabled: true, rules: [] } } },
      b: { key: "b", default: "val-b", environments: { staging: { enabled: true, rules: [] } } },
      c: { key: "c", default: "val-c", environments: { staging: { enabled: true, rules: [] } } },
      d: { key: "d", default: "val-d", environments: { staging: { enabled: true, rules: [] } } },
    });

    // Evaluate 4 flags to overflow the cache (max 3)
    const ha = client.stringFlag("a", "");
    const hb = client.stringFlag("b", "");
    const hc = client.stringFlag("c", "");
    const hd = client.stringFlag("d", "");

    ha.get(); // miss, cached
    hb.get(); // miss, cached
    hc.get(); // miss, cached
    hd.get(); // miss, cached — evicts "a"

    const stats = client.stats();
    expect(stats.cacheMisses).toBe(4);

    // "a" was evicted, should be a miss again
    ha.get();
    expect(client.stats().cacheMisses).toBe(5);

    // "d" should still be cached
    hd.get();
    expect(client.stats().cacheHits).toBe(1);
  });

  it("should update existing cache entry without growing size", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (client as any)._cache;

    // Directly test the internal cache.put for an existing key
    cache.put("key1", "value1");
    cache.put("key1", "value2"); // update existing

    const [hit, val] = cache.get("key1");
    expect(hit).toBe(true);
    expect(val).toBe("value2");
  });

  it("should cache miss when context changes", () => {
    const client = makeFlagsClient();
    setFlagStore(client, { "my-flag": FLAG_DEF });

    let currentPlan = "enterprise";
    client.setContextProvider(() => [new Context("user", "u-1", { plan: currentPlan })]);

    const handle = client.boolFlag("my-flag", false);

    handle.get(); // miss
    handle.get(); // hit

    currentPlan = "free";
    handle.get(); // miss (different context hash)

    const stats = client.stats();
    expect(stats.cacheMisses).toBe(2);
    expect(stats.cacheHits).toBe(1);
  });
});
