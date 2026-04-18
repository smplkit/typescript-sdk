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
// _flushFlags() sends correct payload to POST /api/v1/flags/bulk
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

  it("does not make HTTP call when buffer is empty", async () => {
    const client = makeFlagsClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any)._flushFlags();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("silently catches flush failures", async () => {
    const client = makeFlagsClient();
    client.booleanFlag("flag-a", false);

    mockFetch.mockRejectedValueOnce(new Error("network error"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client as any)._flushFlags()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to bulk-register flags"));
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

    // Adding the 50th flag triggers flush (drain() runs synchronously before first await)
    client.booleanFlag("flag-49", false);

    // drain() inside _flushFlags is synchronous — buffer is empty immediately
    expect(buffer.pendingCount).toBe(0);

    // Let the async HTTP call resolve
    await Promise.resolve();

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

    expect(buffer.pendingCount).toBe(0);
    await Promise.resolve();
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

    expect(buffer.pendingCount).toBe(0);
    await Promise.resolve();
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

    // drain() is synchronous
    expect(buffer.pendingCount).toBe(0);
    await Promise.resolve();
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
});
