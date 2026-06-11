/**
 * Resolution-cache behaviour: hit/miss accounting, LRU eviction, and
 * context-sensitive cache keys. Exercised through the synchronous
 * `_evaluateHandle` path after seeding the flag store directly (so these
 * tests stay focused on the cache, not the connect/fetch plumbing).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it } from "vitest";
import { Context } from "../../../src/flags/types.js";
import { BooleanFlag, StringFlag } from "../../../src/flags/models.js";
import { makeWiredClient } from "./_helpers.js";
import type { FlagsClient } from "../../../src/flags/client.js";

/** Seed the live store + mark connected so `_evaluateHandle` resolves locally. */
function seedStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  (client as any)._flagStore = store;
  (client as any)._connected = true;
}

/** Build a typed handle without going through the async connect path. */
function boolHandle(client: FlagsClient, id: string, def: boolean): BooleanFlag {
  return new BooleanFlag(client as any, {
    id,
    name: id,
    type: "BOOLEAN",
    default: def,
    values: null,
    description: null,
    environments: {},
    createdAt: null,
    updatedAt: null,
  });
}

function strHandle(client: FlagsClient, id: string, def: string): StringFlag {
  return new StringFlag(client as any, {
    id,
    name: id,
    type: "STRING",
    default: def,
    values: null,
    description: null,
    environments: {},
    createdAt: null,
    updatedAt: null,
  });
}

const FLAG_DEF = {
  id: "my-flag",
  default: false,
  environments: {
    staging: {
      enabled: true,
      rules: [{ logic: { "==": [{ var: "user.plan" }, "enterprise"] }, value: true }],
    },
  },
};

async function statsFor(client: FlagsClient): Promise<{ cacheHits: number; cacheMisses: number }> {
  const s = await client.stats();
  return { cacheHits: s.cacheHits, cacheMisses: s.cacheMisses };
}

describe("Resolution cache", () => {
  it("tracks cache hits and misses", async () => {
    const { client } = makeWiredClient();
    seedStore(client, { "my-flag": FLAG_DEF });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);

    const handle = boolHandle(client, "my-flag", false);

    handle.get(); // miss
    expect(await statsFor(client)).toEqual({ cacheMisses: 1, cacheHits: 0 });

    handle.get(); // hit
    expect(await statsFor(client)).toEqual({ cacheMisses: 1, cacheHits: 1 });
  });

  it("accumulates cache hits on repeated reads", async () => {
    const { client } = makeWiredClient();
    seedStore(client, { "my-flag": FLAG_DEF });
    client.setContextProvider(() => [new Context("user", "u-1", { plan: "enterprise" })]);

    const handle = boolHandle(client, "my-flag", false);
    for (let i = 0; i < 100; i++) handle.get();

    expect(await statsFor(client)).toEqual({ cacheHits: 99, cacheMisses: 1 });
  });

  it("evicts the oldest entry when the cache exceeds max size", async () => {
    const { client } = makeWiredClient();
    const cache = (client as any)._cache;
    cache._maxSize = 3;

    seedStore(client, {
      a: { id: "a", default: "val-a", environments: { staging: { enabled: true, rules: [] } } },
      b: { id: "b", default: "val-b", environments: { staging: { enabled: true, rules: [] } } },
      c: { id: "c", default: "val-c", environments: { staging: { enabled: true, rules: [] } } },
      d: { id: "d", default: "val-d", environments: { staging: { enabled: true, rules: [] } } },
    });

    const ha = strHandle(client, "a", "");
    const hb = strHandle(client, "b", "");
    const hc = strHandle(client, "c", "");
    const hd = strHandle(client, "d", "");

    ha.get();
    hb.get();
    hc.get();
    hd.get(); // overflow → evicts "a"
    expect((await statsFor(client)).cacheMisses).toBe(4);

    ha.get(); // "a" evicted → miss again
    expect((await statsFor(client)).cacheMisses).toBe(5);

    hd.get(); // "d" still cached → hit
    expect((await statsFor(client)).cacheHits).toBe(1);
  });

  it("updates an existing cache entry in place without growing", () => {
    const { client } = makeWiredClient();
    const cache = (client as any)._cache;

    cache.put("key1", "value1");
    cache.put("key1", "value2"); // update existing key

    const [hit, val] = cache.get("key1");
    expect(hit).toBe(true);
    expect(val).toBe("value2");
  });

  it("misses when the context changes", async () => {
    const { client } = makeWiredClient();
    seedStore(client, { "my-flag": FLAG_DEF });

    let plan = "enterprise";
    client.setContextProvider(() => [new Context("user", "u-1", { plan })]);

    const handle = boolHandle(client, "my-flag", false);
    handle.get(); // miss
    handle.get(); // hit
    plan = "free";
    handle.get(); // different context hash → miss

    expect(await statsFor(client)).toEqual({ cacheMisses: 2, cacheHits: 1 });
  });
});
