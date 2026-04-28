import { describe, expect, it } from "vitest";
import { Context } from "../../../src/flags/types.js";
import { ContextRegistrationBuffer } from "../../../src/flags/client.js";

describe("ContextRegistrationBuffer", () => {
  it("should accept single context", () => {
    const buffer = new ContextRegistrationBuffer();
    const ctx = new Context("user", "u-1", { plan: "enterprise" });
    buffer.observe([ctx]);
    expect(buffer.pendingCount).toBe(1);
  });

  it("should accept array of contexts", () => {
    const buffer = new ContextRegistrationBuffer();
    buffer.observe([
      new Context("user", "u-1", { plan: "enterprise" }),
      new Context("account", "a-1", { region: "us" }),
    ]);
    expect(buffer.pendingCount).toBe(2);
  });

  it("should deduplicate by (type, key)", () => {
    const buffer = new ContextRegistrationBuffer();
    buffer.observe([new Context("user", "u-1", { plan: "enterprise" })]);
    buffer.observe([new Context("user", "u-1", { plan: "free" })]);
    expect(buffer.pendingCount).toBe(1);
  });

  it("should queue distinct contexts", () => {
    const buffer = new ContextRegistrationBuffer();
    buffer.observe([new Context("user", "u-1", { plan: "enterprise" })]);
    buffer.observe([new Context("user", "u-2", { plan: "free" })]);
    buffer.observe([new Context("account", "a-1", { region: "us" })]);
    expect(buffer.pendingCount).toBe(3);
  });

  it("should format contexts with type, key, and attributes", () => {
    const buffer = new ContextRegistrationBuffer();
    buffer.observe([new Context("user", "u-1", { plan: "enterprise" }, { name: "Alice" })]);
    const batch = buffer.drain();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual({
      type: "user",
      key: "u-1",
      attributes: { plan: "enterprise" },
    });
  });

  it("should include type and key fields", () => {
    const buffer = new ContextRegistrationBuffer();
    buffer.observe([new Context("user", "u-1", { plan: "enterprise" })]);
    const batch = buffer.drain();
    expect(batch[0].type).toBe("user");
    expect(batch[0].key).toBe("u-1");
  });

  it("should evict oldest entry when LRU limit is reached", () => {
    const buffer = new ContextRegistrationBuffer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen = (buffer as any)._seen as Map<string, Record<string, unknown>>;

    // Fill with 10,000 entries
    for (let i = 0; i < 10_000; i++) {
      seen.set(`type:key-${i}`, {});
    }
    expect(seen.size).toBe(10_000);

    // Now observe a new context — should evict the oldest
    buffer.observe([new Context("user", "new-user", { plan: "free" })]);

    expect(seen.size).toBe(10_000); // still 10,000 (one evicted, one added)
    expect(seen.has("type:key-0")).toBe(false); // oldest evicted
    expect(seen.has("user:new-user")).toBe(true); // new one added
  });

  it("should clear pending after drain", () => {
    const buffer = new ContextRegistrationBuffer();
    buffer.observe([new Context("user", "u-1")]);
    expect(buffer.pendingCount).toBe(1);
    buffer.drain();
    expect(buffer.pendingCount).toBe(0);
  });
});
