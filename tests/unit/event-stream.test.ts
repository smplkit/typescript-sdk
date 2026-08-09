import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventStream } from "../../src/event_stream.js";
import type { MetricsReporter } from "../../src/_metrics.js";

// ---------------------------------------------------------------------------
// Controlled live-stream harness: a fetch mock whose responses are
// SSE bodies the test can feed chunk by chunk, end, or error.
// ---------------------------------------------------------------------------

interface SseConn {
  url: string;
  headers: Record<string, string>;
  aborted: boolean;
  /** Enqueue a UTF-8 chunk on the response body. */
  push: (text: string) => void;
  /** Enqueue raw bytes (for byte-level cases like a BOM). */
  pushBytes: (bytes: Uint8Array) => void;
  /** End the stream normally (server closed the connection). */
  end: () => void;
  /** Error the stream (connection reset mid-read). */
  fail: (err: Error) => void;
}

function makeFetchMock(): { connections: SseConn[]; fetchMock: ReturnType<typeof vi.fn> } {
  const connections: SseConn[] = [];
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const encoder = new TextEncoder();
    let open = true;
    const conn: SseConn = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      aborted: false,
      push: (text) => controller.enqueue(encoder.encode(text)),
      pushBytes: (bytes) => controller.enqueue(bytes),
      end: () => {
        if (open) {
          open = false;
          controller.close();
        }
      },
      fail: (err) => {
        if (open) {
          open = false;
          controller.error(err);
        }
      },
    };
    init?.signal?.addEventListener("abort", () => {
      conn.aborted = true;
      if (open) {
        open = false;
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      }
    });
    connections.push(conn);
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  });
  return { connections, fetchMock };
}

/** Flush the promise chain (stream reads settle on microtasks). */
async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

let connections: SseConn[];
let fetchMock: ReturnType<typeof vi.fn>;
const liveStreams: EventStream[] = [];

function makeStream(baseUrl = "https://app.test", metrics?: MetricsReporter | null): EventStream {
  const stream = new EventStream(baseUrl, "sk_test", metrics);
  liveStreams.push(stream);
  return stream;
}

/** Start a stream and wait for its first connection to be established. */
async function startConnected(stream: EventStream): Promise<SseConn> {
  stream.start();
  await settle();
  expect(connections.length).toBeGreaterThanOrEqual(1);
  expect(stream.connectionStatus).toBe("connected");
  return connections[connections.length - 1];
}

beforeEach(() => {
  ({ connections, fetchMock } = makeFetchMock());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const s of liveStreams.splice(0)) s.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Connection basics
// ---------------------------------------------------------------------------

describe("EventStream — connection", () => {
  it("connects to /api/v1/events with bearer auth and the stream accept header", async () => {
    const stream = makeStream();
    const conn = await startConnected(stream);
    expect(conn.url).toBe("https://app.test/api/v1/events");
    expect(conn.headers["Authorization"]).toBe("Bearer sk_test");
    expect(conn.headers["Accept"]).toBe("text/event-stream");
  });

  it("never sends a Last-Event-ID header", async () => {
    const stream = makeStream();
    const conn = await startConnected(stream);
    expect(Object.keys(conn.headers).map((h) => h.toLowerCase())).not.toContain("last-event-id");
  });

  it("prepends https:// when the base URL has no scheme, and strips a trailing slash", async () => {
    const stream = makeStream("app.test/");
    const conn = await startConnected(stream);
    expect(conn.url).toBe("https://app.test/api/v1/events");
  });

  it("keeps an http:// base URL", async () => {
    const stream = makeStream("http://localhost:8000");
    const conn = await startConnected(stream);
    expect(conn.url).toBe("http://localhost:8000/api/v1/events");
  });

  it("reports connecting until the response arrives, then connected", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    const stream = makeStream();
    stream.start();
    expect(stream.connectionStatus).toBe("connecting");
    release(
      new Response(new ReadableStream<Uint8Array>(), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    await settle();
    expect(stream.connectionStatus).toBe("connected");
  });

  it("stop() reports disconnected and aborts the in-flight connection", async () => {
    const stream = makeStream();
    const conn = await startConnected(stream);
    stream.stop();
    expect(stream.connectionStatus).toBe("disconnected");
    expect(conn.aborted).toBe(true);
  });

  it("stop() before start() is a no-op", () => {
    const stream = makeStream();
    expect(() => stream.stop()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("_connect() is a no-op once closed (defensive guard)", () => {
    const stream = makeStream();
    stream.stop();
    (stream as unknown as { _connect: () => void })._connect();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

describe("EventStream — SSE parsing", () => {
  async function collect(
    eventName: string,
  ): Promise<{ conn: SseConn; events: Array<Record<string, unknown>>; stream: EventStream }> {
    const stream = makeStream();
    const events: Array<Record<string, unknown>> = [];
    stream.on(eventName, (data) => events.push(data));
    const conn = await startConnected(stream);
    return { conn, events, stream };
  }

  it("dispatches an event named by the event: field with the data: JSON payload", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push('event: flag_changed\ndata: {"id": "checkout-v2"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "checkout-v2" }]);
  });

  it("accepts CRLF line terminators", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push('event: flag_changed\r\ndata: {"id": "crlf"}\r\n\r\n');
    await settle();
    expect(events).toEqual([{ id: "crlf" }]);
  });

  it("accepts bare CR line terminators", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push('event: flag_changed\rdata: {"id": "cr"}\r\r');
    await settle();
    expect(events).toEqual([{ id: "cr" }]);
  });

  it("handles fields split anywhere across read chunks", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push("event: flag_ch");
    await settle();
    conn.push("anged\nda");
    await settle();
    conn.push('ta: {"id": "sp');
    await settle();
    conn.push('lit"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "split" }]);
  });

  it("handles a CRLF split across two chunks without emitting a phantom blank line", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push("event: flag_changed\r");
    await settle();
    conn.push('\ndata: {"id": "boundary"}\r');
    await settle();
    conn.push("\n\r\n");
    await settle();
    expect(events).toEqual([{ id: "boundary" }]);
  });

  it("joins multiple data: lines with a newline", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push('event: flag_changed\ndata: {"id":\ndata: "multiline"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "multiline" }]);
  });

  it("strips a leading BOM", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.pushBytes(
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode('event: flag_changed\ndata: {"id": "bom"}\n\n'),
      ]),
    );
    await settle();
    expect(events).toEqual([{ id: "bom" }]);
  });

  it("ignores comment lines, including inside a frame", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push(": keepalive\n\n");
    conn.push(': another comment\nevent: flag_changed\n: mid-frame\ndata: {"id": "c"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "c" }]);
  });

  it("ignores unknown fields (including id:)", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push('event: flag_changed\nid: 42\nunknown-field: x\ndata: {"id": "u"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "u" }]);
  });

  it("treats a field line without a colon as a field with an empty value", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push("data\n\n"); // empty data buffer — dispatches nothing
    conn.push('event: flag_changed\ndata: {"id": "after"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "after" }]);
  });

  it("does not require a space after the field colon", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push('event:flag_changed\ndata:{"id": "nospace"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "nospace" }]);
  });

  it("dispatches nothing for a blank line with no accumulated data", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push("\n\n\n");
    conn.push("event: flag_changed\n\n"); // event name but no data — dropped
    await settle();
    expect(events).toEqual([]);
  });

  it("ignores unknown event names silently", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push('event: totally_unknown\ndata: {"id": "x"}\n\n');
    conn.push('event: flag_changed\ndata: {"id": "known"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "known" }]);
  });

  it("ignores frames whose data is not valid JSON", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push("event: flag_changed\ndata: not-json{{{\n\n");
    conn.push('event: flag_changed\ndata: {"id": "ok"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "ok" }]);
  });

  it("delivers the connected event to a registered listener", async () => {
    const { conn, events } = await collect("connected");
    conn.push("retry: 1000\n\nevent: connected\ndata: {}\n\n");
    await settle();
    expect(events).toEqual([{}]);
  });

  it("ignores a non-numeric retry: value", async () => {
    const { conn, events } = await collect("flag_changed");
    conn.push("retry: soon\n\n");
    conn.push('event: flag_changed\ndata: {"id": "still-works"}\n\n');
    await settle();
    expect(events).toEqual([{ id: "still-works" }]);
  });
});

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

describe("EventStream — listeners", () => {
  it("unregisters listeners with off()", async () => {
    const stream = makeStream();
    const events: unknown[] = [];
    const cb = (data: Record<string, unknown>): number => events.push(data);
    stream.on("flag_changed", cb);
    stream.off("flag_changed", cb);
    const conn = await startConnected(stream);
    conn.push('event: flag_changed\ndata: {"id": "x"}\n\n');
    await settle();
    expect(events).toEqual([]);
  });

  it("off() for an unknown event or unregistered callback is a no-op", () => {
    const stream = makeStream();
    expect(() => stream.off("flag_changed", () => undefined)).not.toThrow();
    stream.on("flag_changed", () => undefined);
    expect(() => stream.off("flag_changed", () => undefined)).not.toThrow();
  });

  it("swallows errors thrown by event listeners and still calls the rest", async () => {
    const stream = makeStream();
    const good = vi.fn();
    stream.on("flag_changed", () => {
      throw new Error("listener boom");
    });
    stream.on("flag_changed", good);
    const conn = await startConnected(stream);
    conn.push('event: flag_changed\ndata: {"id": "x"}\n\n');
    await settle();
    expect(good).toHaveBeenCalledWith({ id: "x" });
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe("EventStream — metrics gauge", () => {
  it("records event_connections 1 on connect and 0 on drop", async () => {
    const recordGauge = vi.fn();
    const metrics = { recordGauge } as unknown as MetricsReporter;
    const stream = makeStream("https://app.test", metrics);
    const conn = await startConnected(stream);
    expect(recordGauge).toHaveBeenCalledWith("platform.event_connections", 1, "connections");

    recordGauge.mockClear();
    conn.end();
    await settle();
    expect(recordGauge).toHaveBeenCalledWith("platform.event_connections", 0, "connections");
    stream.stop();
  });

  it("records event_connections 0 when stopped while connected", async () => {
    const recordGauge = vi.fn();
    const metrics = { recordGauge } as unknown as MetricsReporter;
    const stream = makeStream("https://app.test", metrics);
    await startConnected(stream);
    recordGauge.mockClear();
    stream.stop();
    await settle();
    expect(recordGauge).toHaveBeenCalledWith("platform.event_connections", 0, "connections");
  });

  it("works without a metrics reporter (null and omitted)", async () => {
    const withNull = new EventStream("https://app.test", "sk_test", null);
    const withOmitted = new EventStream("https://app.test", "sk_test");
    liveStreams.push(withNull, withOmitted);
    expect(withNull).toBeDefined();
    expect(withOmitted).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Reconnect + backoff
// ---------------------------------------------------------------------------

describe("EventStream — reconnect and backoff", () => {
  it("reconnects with the base delay after the server closes the stream", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const conn = await startConnected(stream);

    conn.end();
    await settle();
    expect(stream.connectionStatus).toBe("connecting");
    expect(connections).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(connections).toHaveLength(2);
    expect(stream.connectionStatus).toBe("connected");
  });

  it("reconnects after a mid-read stream error", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const conn = await startConnected(stream);
    conn.fail(new Error("connection reset"));
    await settle();
    expect(stream.connectionStatus).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(connections).toHaveLength(2);
  });

  it("treats a rejected fetch as a failed attempt and retries", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    const stream = makeStream();
    stream.start();
    await settle();
    expect(stream.connectionStatus).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(stream.connectionStatus).toBe("connected");
  });

  it("treats a plain HTTP 401 as a failed attempt and keeps retrying", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => new Response("unauthorized", { status: 401 }));
    const stream = makeStream();
    stream.start();
    await settle();
    expect(stream.connectionStatus).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stream.connectionStatus).toBe("connected");
  });

  it("treats a 200 without a text/event-stream content-type as a failed attempt", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    const stream = makeStream();
    stream.start();
    await settle();
    expect(stream.connectionStatus).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(stream.connectionStatus).toBe("connected");
  });

  it("treats a 200 with a null body as a failed attempt", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(null, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );
    const stream = makeStream();
    stream.start();
    await settle();
    expect(stream.connectionStatus).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(stream.connectionStatus).toBe("connected");
  });

  it("doubles the reconnect delay per failed attempt, capped at 60s", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => new Response("down", { status: 503 }));
    const stream = makeStream();
    stream.start();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Failed attempts back off at 1000, 2000, 4000, 8000, 16000, 32000,
    // then cap at 60000 for every subsequent attempt.
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000];
    let calls = 1;
    for (const delay of delays) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      calls++;
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
    stream.stop();
  });

  it("resets the backoff to the base delay after a successful connect", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const conn1 = await startConnected(stream);

    // Drop 1: the next attempt (a 503) consumes the base 1000ms delay …
    fetchMock.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    conn1.end();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // … so the following attempt is scheduled at the doubled 2000ms delay
    // and succeeds (HTTP 200 + text/event-stream resets the backoff).
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(stream.connectionStatus).toBe("connected");

    // Drop 2: after the successful connect the delay is back to the base
    // 1000ms — not 4000ms.
    connections[connections.length - 1].end();
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(stream.connectionStatus).toBe("connected");
  });

  it("seeds the backoff base from the server's retry: value", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const conn = await startConnected(stream);
    conn.push("retry: 5000\n\n");
    await settle();

    conn.end();
    await settle();
    await vi.advanceTimersByTimeAsync(4999);
    expect(connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(connections).toHaveLength(2);
  });

  it("stop() cancels a pending reconnect", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    const stream = makeStream();
    stream.start();
    await settle();
    expect(stream.connectionStatus).toBe("connecting");

    stream.stop();
    expect(stream.connectionStatus).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Liveness watchdog
// ---------------------------------------------------------------------------

describe("EventStream — read-timeout watchdog", () => {
  it("drops the connection after 45s of silence and reconnects", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const conn = await startConnected(stream);

    await vi.advanceTimersByTimeAsync(44_999);
    expect(conn.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(conn.aborted).toBe(true);
    expect(stream.connectionStatus).toBe("connecting");

    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(connections).toHaveLength(2);
    expect(stream.connectionStatus).toBe("connected");
  });

  it("any bytes — including comment keepalive frames — reset the watchdog", async () => {
    vi.useFakeTimers();
    const stream = makeStream();
    const conn = await startConnected(stream);

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      conn.push(": keepalive\n\n");
      await settle();
      expect(conn.aborted).toBe(false);
    }
    // 90s of wall time has passed without a disconnect; silence now kills it.
    await vi.advanceTimersByTimeAsync(45_000);
    await settle();
    expect(conn.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Refetch-on-reconnect
// ---------------------------------------------------------------------------

describe("EventStream — refetch on reconnect", () => {
  it("invokes refetch callbacks on a successful reconnect, not on the initial connect", async () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const stream = makeStream();
    stream.onReconnect(refetch);

    const conn = await startConnected(stream);
    expect(refetch).not.toHaveBeenCalled();

    conn.end();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(stream.connectionStatus).toBe("connected");
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("does not invoke refetch callbacks on a failed reconnect attempt", async () => {
    vi.useFakeTimers();
    const refetch = vi.fn();
    const stream = makeStream();
    stream.onReconnect(refetch);
    const conn = await startConnected(stream);

    fetchMock.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    conn.end();
    await settle();
    await vi.advanceTimersByTimeAsync(1000); // failed attempt — no refetch
    await settle();
    expect(refetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000); // successful attempt — refetch
    await settle();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("invokes every registered callback and swallows refetch errors", async () => {
    vi.useFakeTimers();
    const bad = vi.fn(() => {
      throw new Error("refetch boom");
    });
    const good = vi.fn();
    const stream = makeStream();
    stream.onReconnect(bad);
    stream.onReconnect(good);
    const conn = await startConnected(stream);

    conn.end();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("offReconnect() unregisters a callback (and tolerates unknown callbacks)", async () => {
    vi.useFakeTimers();
    const removed = vi.fn();
    const kept = vi.fn();
    const stream = makeStream();
    stream.onReconnect(removed);
    stream.onReconnect(kept);
    stream.offReconnect(removed);
    stream.offReconnect(() => undefined); // never registered — no-op

    const conn = await startConnected(stream);
    conn.end();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });
});
