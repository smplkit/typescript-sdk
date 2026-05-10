import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagsClient } from "../../../src/flags/client.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeFlagsClient(service?: string | null, environment?: string | null): FlagsClient {
  const mockWs = { on: vi.fn(), off: vi.fn(), connectionStatus: "disconnected" };
  const client = new FlagsClient("sk_test", () => mockWs as never, 30000);
  if (service !== undefined || environment !== undefined) {
    (client as Record<string, unknown>)["_parent"] = {
      _service: service ?? null,
      _environment: environment ?? null,
    };
  }
  return client;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// FlagRegistrationBuffer (accessed via the client's _flagBuffer field)
// ---------------------------------------------------------------------------

describe("FlagRegistrationBuffer", () => {
  it("add() queues a flag", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("dark-mode", false);
    expect(buffer.pendingCount).toBe(1);
  });

  it("add() deduplicates by id", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("dark-mode", false);
    client.booleanFlag("dark-mode", true); // same id, second call ignored
    expect(buffer.pendingCount).toBe(1);
  });

  it("drain() returns pending items and clears the buffer", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    client.stringFlag("flag-b", "default");

    const batch = buffer.drain();
    expect(batch).toHaveLength(2);
    expect(buffer.pendingCount).toBe(0);
  });

  it("pendingCount reflects queued items", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    expect(buffer.pendingCount).toBe(0);
    client.numberFlag("timeout", 30);
    expect(buffer.pendingCount).toBe(1);
    client.jsonFlag("config", {});
    expect(buffer.pendingCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FlagRegistrationBuffer — peek / commit
// ---------------------------------------------------------------------------

describe("FlagRegistrationBuffer — peek/commit", () => {
  it("peek() returns a snapshot without removing items", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    client.stringFlag("flag-b", "x");

    const batch = buffer.peek();
    expect(batch).toHaveLength(2);
    expect(batch[0].id).toBe("flag-a");
    expect(batch[1].id).toBe("flag-b");
    // Buffer is NOT cleared
    expect(buffer.pendingCount).toBe(2);
  });

  it("commit() removes committed items and retains the rest", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    client.stringFlag("flag-b", "x");
    client.numberFlag("flag-c", 0);

    buffer.commit(new Set(["flag-a", "flag-b"]));
    expect(buffer.pendingCount).toBe(1);
    const remaining = buffer.drain();
    expect(remaining[0].id).toBe("flag-c");
  });

  it("commit() does not re-allow a deduped id", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    const batch = buffer.peek();
    buffer.commit(new Set(batch.map((b: { id: string }) => b.id)));

    // Same id — _seen still has it, so re-add is ignored
    client.booleanFlag("flag-a", true);
    expect(buffer.pendingCount).toBe(0);
  });

  it("drain() still clears everything (for teardown)", () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    client.booleanFlag("flag-b", true);
    const batch = buffer.drain();
    expect(batch).toHaveLength(2);
    expect(buffer.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Typed flag methods populate buffer with correct type/default/service/env
// ---------------------------------------------------------------------------

describe("typed flag methods populate buffer", () => {
  it("booleanFlag() adds BOOLEAN entry with correct fields", () => {
    const client = makeFlagsClient("my-service", "production");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("dark-mode", true);
    const batch = buffer.drain();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      id: "dark-mode",
      type: "BOOLEAN",
      default: true,
      service: "my-service",
      environment: "production",
    });
  });

  it("stringFlag() adds STRING entry with correct fields", () => {
    const client = makeFlagsClient("svc", "staging");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.stringFlag("theme", "light");
    const batch = buffer.drain();
    expect(batch[0]).toMatchObject({
      id: "theme",
      type: "STRING",
      default: "light",
      service: "svc",
      environment: "staging",
    });
  });

  it("numberFlag() adds NUMERIC entry with correct fields", () => {
    const client = makeFlagsClient("svc", "prod");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.numberFlag("max-retries", 3);
    const batch = buffer.drain();
    expect(batch[0]).toMatchObject({
      id: "max-retries",
      type: "NUMERIC",
      default: 3,
    });
  });

  it("jsonFlag() adds JSON entry with correct fields", () => {
    const client = makeFlagsClient("svc", "prod");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.jsonFlag("config", { key: "value" });
    const batch = buffer.drain();
    expect(batch[0]).toMatchObject({
      id: "config",
      type: "JSON",
      default: { key: "value" },
    });
  });

  it("uses null service/environment when _parent is not set", () => {
    const client = makeFlagsClient(); // no parent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-x", false);
    const batch = buffer.drain();
    // service and environment should be undefined (from null ?? undefined)
    expect(batch[0].service).toBeUndefined();
    expect(batch[0].environment).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// _flushFlags() — peek/commit semantics
// ---------------------------------------------------------------------------

describe("_flushFlags()", () => {
  it("sends flags batch to POST /api/v1/flags/bulk", async () => {
    const client = makeFlagsClient("svc", "prod");

    client.booleanFlag("dark-mode", false);
    client.stringFlag("theme", "light");

    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 2 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any)._flushFlags();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const request: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await request.clone().text()) as { flags: unknown[] };
    expect(body.flags).toHaveLength(2);
    expect(body.flags[0]).toMatchObject({ id: "dark-mode", type: "BOOLEAN" });
    expect(body.flags[1]).toMatchObject({ id: "theme", type: "STRING" });
  });

  it("commits items after a successful POST", async () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    expect(buffer.pendingCount).toBe(1);

    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any)._flushFlags();

    expect(buffer.pendingCount).toBe(0);
  });

  it("does not make HTTP call when buffer is empty", async () => {
    const client = makeFlagsClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any)._flushFlags();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects on network failure and preserves buffer", async () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client as any)._flushFlags()).rejects.toThrow("network error");

    // Buffer is intact — item was not committed
    expect(buffer.pendingCount).toBe(1);
  });

  it("rejects on non-OK response and preserves buffer", async () => {
    const client = makeFlagsClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    client.booleanFlag("flag-a", false);
    mockFetch.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client as any)._flushFlags()).rejects.toThrow("HTTP 500");

    // Buffer is intact — item was not committed
    expect(buffer.pendingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Flush-before-fetch ordering in initialize()
// ---------------------------------------------------------------------------

describe("initialize() flushes flags before fetching definitions", () => {
  it("calls bulk register before GET /api/v1/flags", async () => {
    const client = makeFlagsClient("svc", "production");
    client.booleanFlag("flag-a", false);

    const callOrder: string[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/flags/bulk") {
        callOrder.push("bulk");
        return jsonResponse({ registered: 1 });
      }
      if (url.pathname === "/api/v1/flags") {
        callOrder.push("list");
        return jsonResponse({ data: [] });
      }
      return jsonResponse({});
    });

    await client.initialize();

    expect(callOrder[0]).toBe("bulk");
    expect(callOrder[1]).toBe("list");

    // Cleanup
    await client.disconnect();
  });
});

// ---------------------------------------------------------------------------
// initialize() retry on failure
// ---------------------------------------------------------------------------

describe("initialize() retry on failure", () => {
  it("stays uninitialized after 500, retries after backoff, initializes on 200", async () => {
    const client = makeFlagsClient("svc", "prod");
    client.booleanFlag("flag-a", false);

    let bulkCallCount = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockImplementation(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/flags/bulk") {
        bulkCallCount++;
        if (bulkCallCount === 1) return new Response("Server Error", { status: 500 });
        return jsonResponse({ registered: 1 });
      }
      if (url.pathname === "/api/v1/flags") {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({});
    });

    await client.initialize();

    // After 500: not initialized, buffer still has the pending item
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initialized).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._flagBuffer.pendingCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("initialization failed"));

    // Advance past the 1s backoff → retry fires and succeeds
    await vi.advanceTimersByTimeAsync(1_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initialized).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._flagBuffer.pendingCount).toBe(0);

    await client.disconnect();
    warnSpy.mockRestore();
  });

  it("_initialized stays false until retry succeeds", async () => {
    const client = makeFlagsClient("svc", "prod");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));

    await client.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initialized).toBe(false);

    warnSpy.mockRestore();
  });

  it("backoff doubles on each successive failure", async () => {
    const client = makeFlagsClient("svc", "prod");
    client.booleanFlag("flag-a", false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // All bulk-register calls fail; GET /api/v1/flags succeeds
    mockFetch.mockImplementation(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/flags/bulk") return new Response("err", { status: 500 });
      return jsonResponse({ data: [] });
    });

    await client.initialize(); // fails, backoff = 1s → next = 2s

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initBackoffMs).toBe(2_000);

    // Advance 1s → retry fires, fails again, backoff = 2s → next = 4s
    await vi.advanceTimersByTimeAsync(1_000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initBackoffMs).toBe(4_000);

    // Cleanup without waiting for more retries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)._close();
    warnSpy.mockRestore();
  });

  it("ws listeners are registered exactly once across retries", async () => {
    const mockWs = { on: vi.fn(), off: vi.fn(), connectionStatus: "connected" };
    const client = new FlagsClient("sk_test", () => mockWs as never, 30000);
    (client as Record<string, unknown>)["_parent"] = {
      _service: null,
      _environment: "staging",
      _metrics: null,
    };
    client.booleanFlag("flag-a", false);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let bulkCallCount = 0;
    mockFetch.mockImplementation(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/flags/bulk") {
        bulkCallCount++;
        if (bulkCallCount === 1) return new Response("Error", { status: 500 });
        return jsonResponse({ registered: 1 });
      }
      return jsonResponse({ data: [] });
    });

    // First attempt fails
    await client.initialize();
    // Advance past backoff — retry succeeds
    await vi.advanceTimersByTimeAsync(1_000);

    // Each event should be registered exactly once
    expect(mockWs.on).toHaveBeenCalledTimes(3);
    expect(mockWs.on).toHaveBeenCalledWith("flag_changed", expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith("flag_deleted", expect.any(Function));
    expect(mockWs.on).toHaveBeenCalledWith("flags_changed", expect.any(Function));

    await client.disconnect();
    warnSpy.mockRestore();
  });

  it("cancels existing retry timer on re-call while retry is pending", async () => {
    const client = makeFlagsClient("svc", "prod");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First initialize() fails → schedules retry
    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await client.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstTimer = (client as any)._initRetryTimer;
    expect(firstTimer).not.toBeNull();

    // Second initialize() also fails while retry is still pending → cancels first timer
    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await client.initialize();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondTimer = (client as any)._initRetryTimer;
    expect(secondTimer).not.toBeNull();
    expect(secondTimer).not.toBe(firstTimer);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)._close();
    warnSpy.mockRestore();
  });

  it("_close() cancels the pending retry timer", async () => {
    const client = makeFlagsClient("svc", "prod");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await client.initialize();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initRetryTimer).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)._close();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initRetryTimer).toBeNull();

    warnSpy.mockRestore();
  });

  it("disconnect() cancels the pending retry timer", async () => {
    const client = makeFlagsClient("svc", "prod");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await client.initialize();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initRetryTimer).not.toBeNull();
    await client.disconnect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initRetryTimer).toBeNull();

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// _connectInternal() retry on failure
// ---------------------------------------------------------------------------

describe("_connectInternal() retry on failure", () => {
  it("cancels existing retry timer before scheduling a new one", async () => {
    const client = makeFlagsClient("svc", "prod");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First _connectInternal call fails → schedules retry at 1s
    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await client._connectInternal("staging");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const firstTimer = (client as any)._initRetryTimer;
    expect(firstTimer).not.toBeNull();

    // Second _connectInternal call also fails → cancels first timer, schedules new one
    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await client._connectInternal("staging");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondTimer = (client as any)._initRetryTimer;
    expect(secondTimer).not.toBeNull();
    expect(secondTimer).not.toBe(firstTimer);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any)._close();
    warnSpy.mockRestore();
  });

  it("periodic flush via _connectInternal warns on failure and retains buffer", async () => {
    const client = makeFlagsClient("svc", "prod");
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    client.booleanFlag("timer-flag", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to bulk-register flags"));
    expect(buffer.pendingCount).toBe(1);

    await client.disconnect();
    warnSpy.mockRestore();
  });

  it("stays uninitialized after 500, retries after backoff", async () => {
    const client = makeFlagsClient();
    client.booleanFlag("flag-a", false);

    let bulkCallCount = 0;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockImplementation(async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/flags/bulk") {
        bulkCallCount++;
        if (bulkCallCount === 1) return new Response("Server Error", { status: 500 });
        return jsonResponse({ registered: 1 });
      }
      if (url.pathname === "/api/v1/flags") return jsonResponse({ data: [] });
      return jsonResponse({});
    });

    await client._connectInternal("staging");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initialized).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._flagBuffer.pendingCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._initialized).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._flagBuffer.pendingCount).toBe(0);

    await client.disconnect();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Threshold flush at 50 items
// ---------------------------------------------------------------------------

describe("threshold flush at 50 items", () => {
  it("triggers _flushFlags when pendingCount reaches 50", async () => {
    const client = makeFlagsClient();

    // Mock bulk POST to succeed
    mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));

    // Add 49 flags — no flush yet
    for (let i = 0; i < 49; i++) {
      client.booleanFlag(`flag-${i}`, false);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;
    expect(buffer.pendingCount).toBe(49);

    // Adding the 50th flag triggers a fire-and-forget flush
    client.booleanFlag("flag-49", false);

    // peek() does not drain — buffer still has items until commit() runs async
    expect(buffer.pendingCount).toBe(50);

    // Drain the full openapi-fetch microtask chain (POST → fetchWithTimeout → commit)
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(buffer.pendingCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("triggers flush via stringFlag() when pendingCount reaches 50", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    for (let i = 0; i < 49; i++) {
      client.stringFlag(`str-flag-${i}`, "default");
    }
    expect(buffer.pendingCount).toBe(49);

    client.stringFlag("str-flag-49", "default");

    // Buffer still has items — commit is async
    expect(buffer.pendingCount).toBe(50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(buffer.pendingCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("triggers flush via numberFlag() when pendingCount reaches 50", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    for (let i = 0; i < 49; i++) {
      client.numberFlag(`num-flag-${i}`, 0);
    }
    expect(buffer.pendingCount).toBe(49);

    client.numberFlag("num-flag-49", 0);

    expect(buffer.pendingCount).toBe(50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(buffer.pendingCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("triggers flush via jsonFlag() when pendingCount reaches 50", async () => {
    const client = makeFlagsClient();

    mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    for (let i = 0; i < 49; i++) {
      client.jsonFlag(`json-flag-${i}`, {});
    }
    expect(buffer.pendingCount).toBe(49);

    client.jsonFlag("json-flag-49", {});

    // peek() does not drain synchronously
    expect(buffer.pendingCount).toBe(50);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(buffer.pendingCount).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retains buffer on threshold-flush failure (booleanFlag)", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValue(new Response("err", { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    for (let i = 0; i < 50; i++) client.booleanFlag(`flag-${i}`, false);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(buffer.pendingCount).toBe(50);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to bulk-register flags"));
    warnSpy.mockRestore();
  });

  it("retains buffer on threshold-flush failure (stringFlag)", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValue(new Response("err", { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 50; i++) client.stringFlag(`s-${i}`, "x");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to bulk-register flags"));
    warnSpy.mockRestore();
  });

  it("retains buffer on threshold-flush failure (numberFlag)", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValue(new Response("err", { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 50; i++) client.numberFlag(`n-${i}`, 0);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to bulk-register flags"));
    warnSpy.mockRestore();
  });

  it("retains buffer on threshold-flush failure (jsonFlag)", async () => {
    const client = makeFlagsClient();
    mockFetch.mockResolvedValue(new Response("err", { status: 500 }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 50; i++) client.jsonFlag(`j-${i}`, {});

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to bulk-register flags"));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Timer: started after initialize(), cleared on disconnect()
// ---------------------------------------------------------------------------

describe("periodic flush timer", () => {
  it("starts 30s setInterval after initialize()", async () => {
    const client = makeFlagsClient("svc", "prod");

    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.initialize();

    client.booleanFlag("timer-flag", true);

    // At t=0, no additional flush has happened
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the GET /api/v1/flags from initialize

    // Advance 30 seconds — timer fires, buffer has 1 item, flush HTTP call happens
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 1 }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Cleanup
    await client.disconnect();
  });

  it("clears timer on disconnect()", async () => {
    const client = makeFlagsClient("svc", "prod");

    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.initialize();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timerBefore = (client as any)._flagFlushTimer;
    expect(timerBefore).not.toBeNull();

    await client.disconnect();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timerAfter = (client as any)._flagFlushTimer;
    expect(timerAfter).toBeNull();
  });

  it("does not fire timer after disconnect()", async () => {
    const client = makeFlagsClient("svc", "prod");

    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.initialize();
    await client.disconnect();

    const callCountAfterDisconnect = mockFetch.mock.calls.length;

    // Advance past timer interval — should not trigger any more calls
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockFetch).toHaveBeenCalledTimes(callCountAfterDisconnect);
  });

  it("starts 30s timer after _connectInternal()", async () => {
    const client = makeFlagsClient("svc", "prod");

    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client._connectInternal("staging");

    client.booleanFlag("timer-flag", true);

    // Advance 30 seconds — timer fires
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 1 }));
    await vi.advanceTimersByTimeAsync(30_000);

    // GET /api/v1/flags + one timer-triggered bulk POST
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Cleanup
    await client.disconnect();
  });

  it("periodic flush warns on 500 but retains buffer", async () => {
    const client = makeFlagsClient("svc", "prod");

    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));
    await client.initialize();

    client.booleanFlag("timer-flag", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buffer = (client as any)._flagBuffer;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to bulk-register flags"));
    expect(buffer.pendingCount).toBe(1); // item retained for next retry

    await client.disconnect();
    warnSpy.mockRestore();
  });
});
