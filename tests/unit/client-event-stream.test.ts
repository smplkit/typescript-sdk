import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplClient } from "../../src/client.js";
import { EventStream } from "../../src/event_stream.js";

// SmplClient lifecycle around the shared live event stream: lazy creation on
// _ensureStream(), reuse across calls, and teardown on close(). The stream's
// own connection behavior is covered in event-stream.test.ts; here its
// start/stop are stubbed so no connection is ever attempted.

const mockFetch = vi.fn();

const DEFAULT_OPTS = {
  apiKey: "sk_api_test",
  environment: "test",
  service: "test-svc",
  telemetry: false,
};

let startSpy: ReturnType<typeof vi.spyOn>;
let stopSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  // Fresh Response per call — a single shared Response body can only be read once.
  mockFetch.mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
  );
  startSpy = vi.spyOn(EventStream.prototype, "start").mockImplementation(() => {});
  stopSpy = vi.spyOn(EventStream.prototype, "stop").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SmplClient live event-stream lifecycle", () => {
  it("lazily creates the shared stream on _ensureStream() and tears it down on close()", () => {
    const client = new SmplClient(DEFAULT_OPTS);

    // No stream yet — construction is side-effect-free.
    expect(startSpy).not.toHaveBeenCalled();

    const stream = client._ensureStream();
    expect(stream).toBeInstanceOf(EventStream);
    expect(startSpy).toHaveBeenCalledTimes(1);

    // close() should stop the shared stream.
    client.close();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses the same shared stream across repeated _ensureStream() calls", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    const first = client._ensureStream();
    const second = client._ensureStream();
    expect(second).toBe(first);
    expect(startSpy).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("opens the shared stream when flags connect lazily", async () => {
    const client = new SmplClient(DEFAULT_OPTS);
    await client.flags._ensureConnected();
    expect(startSpy).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("is safe to close before any stream is created", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(startSpy).not.toHaveBeenCalled();
    expect(() => client.close()).not.toThrow();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("is safe to close twice", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    client._ensureStream();
    client.close();
    expect(() => client.close()).not.toThrow();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
