/**
 * Targeted tests for AuditEventBuffer's edge paths — overflow eviction,
 * permanent failure drop, transient retry with backoff, gave-up branch,
 * and cooperative flush timeout.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuditEventBuffer } from "../../../src/audit/buffer.js";

describe("AuditEventBuffer", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("overflow drops oldest and warns", async () => {
    const seen: number[] = [];
    const buf = new AuditEventBuffer({
      post: async (item) => {
        seen.push((item.body as { i: number }).i);
        return { status: 201 };
      },
      maxSize: 3,
      // Don't auto-flush during the enqueue burst — we want to fill past capacity.
      watermark: 999,
      flushIntervalMs: 60_000,
    });
    try {
      for (let i = 0; i < 5; i++) {
        buf.enqueue({ i });
      }
      await buf.flush(2_000);
      // Oldest two were dropped before being posted.
      expect(seen).toEqual([2, 3, 4]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("buffer full"));
    } finally {
      await buf.close();
    }
  });

  test("permanent 4xx is dropped after a single attempt", async () => {
    const calls: number[] = [];
    const buf = new AuditEventBuffer({
      post: async () => {
        calls.push(Date.now());
        return { status: 400 };
      },
      maxSize: 10,
      watermark: 1,
      flushIntervalMs: 60_000,
    });
    try {
      buf.enqueue({ x: 1 });
      await buf.flush(2_000);
      expect(calls.length).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("permanent failure"));
    } finally {
      await buf.close();
    }
  });

  test("transient 5xx retries with backoff and eventually succeeds", async () => {
    let attempt = 0;
    const buf = new AuditEventBuffer({
      post: async () => {
        attempt += 1;
        if (attempt < 3) return { status: 503 };
        return { status: 201 };
      },
      maxSize: 10,
      watermark: 1,
      flushIntervalMs: 50,
    });
    try {
      buf.enqueue({ x: 1 });
      // Allow backoff (250ms × 2 attempts plus jitter) + worker tick.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (attempt >= 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(attempt).toBeGreaterThanOrEqual(3);
    } finally {
      await buf.close();
    }
  });

  test("gives up after MAX_ATTEMPTS and warns", async () => {
    let attempt = 0;
    const buf = new AuditEventBuffer({
      post: async () => {
        attempt += 1;
        return { status: 503 };
      },
      maxSize: 10,
      watermark: 1,
      flushIntervalMs: 25,
    });
    try {
      buf.enqueue({ x: 1 });
      // 5 attempts × max 250ms × 2 ≈ 2.5s to give up.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (warnSpy.mock.calls.some((call) => String(call[0]).includes("gave up"))) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(attempt).toBeGreaterThanOrEqual(5);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("gave up"));
    } finally {
      await buf.close();
    }
  });

  test("post throwing is treated as transient (status 0)", async () => {
    let attempt = 0;
    const buf = new AuditEventBuffer({
      post: async () => {
        attempt += 1;
        if (attempt < 2) {
          throw new Error("simulated network blip");
        }
        return { status: 201 };
      },
      maxSize: 10,
      watermark: 1,
      flushIntervalMs: 25,
    });
    try {
      buf.enqueue({ x: 1 });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (attempt >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(attempt).toBeGreaterThanOrEqual(2);
    } finally {
      await buf.close();
    }
  });

  test("flush returns when timeout elapses with unprocessed items", async () => {
    // Each post returns a transient failure → item requeued with backoff.
    // watermark=999 prevents enqueue from kicking off a background drain
    // before flush() runs, so the timing is deterministic.
    const buf = new AuditEventBuffer({
      post: async () => ({ status: 503 }),
      maxSize: 10,
      watermark: 999,
      flushIntervalMs: 60_000,
    });
    try {
      buf.enqueue({ x: 1 });
      const start = Date.now();
      await buf.flush(50);
      expect(Date.now() - start).toBeGreaterThanOrEqual(40);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("flush timed out"));
    } finally {
      await buf.close();
    }
  });

  test("close is idempotent and safe to call after flush", async () => {
    const buf = new AuditEventBuffer({
      post: async () => ({ status: 201 }),
    });
    await buf.flush(1_000);
    await buf.close();
    // Second close shouldn't throw or hang.
    await buf.close();
    // Enqueue after close is a no-op.
    buf.enqueue({ x: 1 });
  });

  test("enqueue rejects items silently after close", async () => {
    const buf = new AuditEventBuffer({
      post: async () => ({ status: 201 }),
      flushIntervalMs: 60_000,
    });
    await buf.close();
    // No throw, no internal state change.
    buf.enqueue({ x: 1 });
  });
});
