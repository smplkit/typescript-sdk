import { describe, expect, it } from "vitest";
import { Context } from "../../../src/flags/types.js";
import { FlagsClient } from "../../../src/flags/client.js";

function makeFlagsClient(): FlagsClient {
  const mockWs = { on: () => {}, off: () => {}, connectionStatus: "disconnected" };
  return new FlagsClient("sk_test", () => mockWs as never, 30000);
}

describe("Context registration buffer", () => {
  it("should accept single context", () => {
    const client = makeFlagsClient();
    const ctx = new Context("user", "u-1", { plan: "enterprise" });
    // register() queues the context internally — no error expected
    client.register(ctx);
  });

  it("should accept array of contexts", () => {
    const client = makeFlagsClient();
    client.register([
      new Context("user", "u-1", { plan: "enterprise" }),
      new Context("account", "a-1", { region: "us" }),
    ]);
  });

  it("should deduplicate by (type, key)", () => {
    const client = makeFlagsClient();
    // Access internal buffer for testing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    client.register(new Context("user", "u-1", { plan: "enterprise" }));
    client.register(new Context("user", "u-1", { plan: "free" }));

    expect(buffer.pendingCount).toBe(1);
  });

  it("should queue distinct contexts", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    client.register(new Context("user", "u-1", { plan: "enterprise" }));
    client.register(new Context("user", "u-2", { plan: "free" }));
    client.register(new Context("account", "a-1", { region: "us" }));

    expect(buffer.pendingCount).toBe(3);
  });

  it("should format contexts with composite IDs", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    client.register(new Context("user", "u-1", { plan: "enterprise" }, { name: "Alice" }));

    const batch = buffer.drain();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual({
      id: "user:u-1",
      name: "Alice",
      attributes: { plan: "enterprise" },
    });
  });

  it("should use key as name when name is not provided", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    client.register(new Context("user", "u-1", { plan: "enterprise" }));

    const batch = buffer.drain();
    expect(batch[0].name).toBe("u-1");
  });

  it("should evict oldest entry when LRU limit is reached", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    // Fill to the LRU limit (10,000) plus one to trigger eviction
    // We'll set the internal _seen map size artificially to test eviction
    const seen = buffer._seen as Map<string, Record<string, unknown>>;

    // Fill with 10,000 entries
    for (let i = 0; i < 10_000; i++) {
      seen.set(`type:key-${i}`, {});
    }

    expect(seen.size).toBe(10_000);

    // Now observe a new context — should evict the oldest
    client.register(new Context("user", "new-user", { plan: "free" }));

    expect(seen.size).toBe(10_000); // still 10,000 (one evicted, one added)
    expect(seen.has("type:key-0")).toBe(false); // oldest evicted
    expect(seen.has("user:new-user")).toBe(true); // new one added
  });

  it("should clear pending after drain", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._contextBuffer;

    client.register(new Context("user", "u-1"));
    expect(buffer.pendingCount).toBe(1);

    buffer.drain();
    expect(buffer.pendingCount).toBe(0);
  });
});
