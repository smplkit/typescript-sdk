import { describe, expect, it } from "vitest";
import {
  ContextRegistrationBuffer,
  CONTEXT_BATCH_FLUSH_SIZE,
  CONTEXT_REGISTRATION_LRU_SIZE,
} from "../../src/buffer.js";
import { Context } from "../../src/flags/types.js";

describe("buffer constants", () => {
  it("exposes the batch flush size", () => {
    expect(CONTEXT_BATCH_FLUSH_SIZE).toBe(100);
  });

  it("exposes the LRU cap", () => {
    expect(CONTEXT_REGISTRATION_LRU_SIZE).toBe(10_000);
  });
});

describe("ContextRegistrationBuffer", () => {
  describe("observe() + pendingCount", () => {
    it("starts empty", () => {
      const buffer = new ContextRegistrationBuffer();
      expect(buffer.pendingCount).toBe(0);
    });

    it("queues a distinct observation", () => {
      const buffer = new ContextRegistrationBuffer();
      buffer.observe([new Context("user", "u-1", { plan: "enterprise" })]);
      expect(buffer.pendingCount).toBe(1);
    });

    it("queues multiple distinct observations", () => {
      const buffer = new ContextRegistrationBuffer();
      buffer.observe([
        new Context("user", "u-1", { plan: "enterprise" }),
        new Context("account", "a-1", { region: "us" }),
      ]);
      expect(buffer.pendingCount).toBe(2);
    });

    it("dedupes repeated (type, key) observations", () => {
      const buffer = new ContextRegistrationBuffer();
      buffer.observe([new Context("user", "u-1", { plan: "free" })]);
      buffer.observe([new Context("user", "u-1", { plan: "pro" })]);
      expect(buffer.pendingCount).toBe(1);
    });

    it("treats the same key under different types as distinct", () => {
      const buffer = new ContextRegistrationBuffer();
      buffer.observe([new Context("user", "shared", {})]);
      buffer.observe([new Context("account", "shared", {})]);
      expect(buffer.pendingCount).toBe(2);
    });

    it("snapshots attributes so later mutation does not leak into the buffer", () => {
      const buffer = new ContextRegistrationBuffer();
      const ctx = new Context("user", "u-1", { plan: "free" });
      buffer.observe([ctx]);
      ctx.attributes.plan = "enterprise";
      const batch = buffer.drain();
      expect(batch[0].attributes).toEqual({ plan: "free" });
    });
  });

  describe("drain()", () => {
    it("returns and clears the pending batch", () => {
      const buffer = new ContextRegistrationBuffer();
      buffer.observe([
        new Context("user", "u-1", { plan: "free" }),
        new Context("account", "a-1", { region: "us" }),
      ]);

      const batch = buffer.drain();
      expect(batch).toHaveLength(2);
      expect(batch[0]).toEqual({ type: "user", key: "u-1", attributes: { plan: "free" } });
      expect(batch[1]).toEqual({ type: "account", key: "a-1", attributes: { region: "us" } });
      expect(buffer.pendingCount).toBe(0);
    });

    it("returns an empty batch when nothing is pending", () => {
      const buffer = new ContextRegistrationBuffer();
      expect(buffer.drain()).toEqual([]);
    });

    it("keeps the dedup window after draining (already-seen keys stay deduped)", () => {
      const buffer = new ContextRegistrationBuffer();
      buffer.observe([new Context("user", "u-1", {})]);
      buffer.drain();
      // Same key again — still deduped, so nothing is re-queued.
      buffer.observe([new Context("user", "u-1", {})]);
      expect(buffer.pendingCount).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    it("evicts the oldest seen key once the LRU cap is exceeded", () => {
      const buffer = new ContextRegistrationBuffer();
      // Fill the dedup LRU to its cap with distinct keys.
      const initial: Context[] = [];
      for (let i = 0; i < CONTEXT_REGISTRATION_LRU_SIZE; i++) {
        initial.push(new Context("user", `u-${i}`, {}));
      }
      buffer.observe(initial);
      buffer.drain();
      expect(buffer.pendingCount).toBe(0);

      // One more distinct key trips the eviction branch and removes the
      // oldest entry ("user:u-0").
      buffer.observe([new Context("user", "overflow", {})]);
      buffer.drain();

      // "user:u-0" was evicted, so re-observing it is treated as new again.
      buffer.observe([new Context("user", "u-0", {})]);
      expect(buffer.pendingCount).toBe(1);
    });
  });
});
