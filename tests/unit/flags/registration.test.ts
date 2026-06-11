/**
 * Flag-discovery surface: the owned FlagRegistrationBuffer (add/dedup/peek/
 * commit/pendingCount) plus the client's register / flush / pendingCount and
 * the threshold auto-flush that fires at FLAG_BATCH_FLUSH_SIZE.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagRegistrationBuffer } from "../../../src/flags/client.js";
import { FlagDeclaration } from "../../../src/flags/types.js";
import { makeWiredClient, jsonResponse, textResponse } from "./_helpers.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// FlagRegistrationBuffer (unit)
// ---------------------------------------------------------------------------

describe("FlagRegistrationBuffer", () => {
  it("add() queues a flag", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add("dark-mode", "BOOLEAN", false, "svc", "prod");
    expect(buf.pendingCount).toBe(1);
    expect(buf.peek()[0]).toMatchObject({
      id: "dark-mode",
      type: "BOOLEAN",
      default: false,
      service: "svc",
      environment: "prod",
    });
  });

  it("add() deduplicates by id", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add("dark-mode", "BOOLEAN", false, null, null);
    buf.add("dark-mode", "BOOLEAN", true, null, null);
    expect(buf.pendingCount).toBe(1);
  });

  it("add() maps null service/environment to undefined", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add("flag-x", "BOOLEAN", false, null, null);
    const item = buf.peek()[0];
    expect(item.service).toBeUndefined();
    expect(item.environment).toBeUndefined();
  });

  it("peek() returns a snapshot without draining", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add("a", "BOOLEAN", false, null, null);
    buf.add("b", "STRING", "x", null, null);
    const batch = buf.peek();
    expect(batch).toHaveLength(2);
    expect(buf.pendingCount).toBe(2);
  });

  it("commit() removes committed ids and retains the rest", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add("a", "BOOLEAN", false, null, null);
    buf.add("b", "STRING", "x", null, null);
    buf.add("c", "NUMERIC", 0, null, null);
    buf.commit(new Set(["a", "b"]));
    expect(buf.pendingCount).toBe(1);
    expect(buf.peek()[0].id).toBe("c");
  });

  it("commit() does not re-allow a previously-seen id", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add("a", "BOOLEAN", false, null, null);
    buf.commit(new Set(["a"]));
    buf.add("a", "BOOLEAN", true, null, null); // _seen still has it
    expect(buf.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// client.register / flush / pendingCount
// ---------------------------------------------------------------------------

describe("client.register / flush / pendingCount", () => {
  it("register(single) buffers one declaration", async () => {
    const { client } = makeWiredClient({ service: "svc", environment: "prod" });
    await client.register(
      new FlagDeclaration({ id: "dark-mode", type: "BOOLEAN", default: false }),
    );
    expect(client.pendingCount).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("register(array) buffers every declaration", async () => {
    const { client } = makeWiredClient();
    await client.register([
      new FlagDeclaration({ id: "a", type: "BOOLEAN", default: false }),
      new FlagDeclaration({ id: "b", type: "STRING", default: "x" }),
    ]);
    expect(client.pendingCount).toBe(2);
  });

  it("register({flush:true}) POSTs immediately and commits", async () => {
    const { client } = makeWiredClient({ service: "svc", environment: "prod" });
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 1 }));

    await client.register(
      new FlagDeclaration({ id: "dark-mode", type: "BOOLEAN", default: false }),
      {
        flush: true,
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const req: Request = mockFetch.mock.calls[0][0];
    expect(new URL(req.url).pathname).toBe("/api/v1/flags/bulk");
    const body = JSON.parse(await req.clone().text()) as { flags: any[] };
    expect(body.flags[0]).toMatchObject({ id: "dark-mode", type: "BOOLEAN" });
    expect(client.pendingCount).toBe(0);
  });

  it("flush() is a no-op when the buffer is empty", async () => {
    const { client } = makeWiredClient();
    await client.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("flush() retains the buffer on a non-OK response", async () => {
    const { client } = makeWiredClient();
    await client.register(new FlagDeclaration({ id: "a", type: "BOOLEAN", default: false }));
    mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

    await expect(client.flush()).rejects.toThrow(/HTTP 500/);
    expect(client.pendingCount).toBe(1);
  });

  it("flush() POSTs the full batch with the right body", async () => {
    const { client } = makeWiredClient();
    await client.register([
      new FlagDeclaration({ id: "dark-mode", type: "BOOLEAN", default: false }),
      new FlagDeclaration({ id: "theme", type: "STRING", default: "light" }),
    ]);
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 2 }));

    await client.flush();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.clone().text()) as { flags: any[] };
    expect(body.flags).toHaveLength(2);
    expect(body.flags[0]).toMatchObject({ id: "dark-mode", type: "BOOLEAN" });
    expect(body.flags[1]).toMatchObject({ id: "theme", type: "STRING" });
    expect(client.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Threshold auto-flush at FLAG_BATCH_FLUSH_SIZE (50)
// ---------------------------------------------------------------------------

describe("threshold auto-flush at 50 declarations", () => {
  it("fires a fire-and-forget flush once pendingCount reaches 50", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));

    for (let i = 0; i < 49; i++) {
      await client.register(
        new FlagDeclaration({ id: `flag-${i}`, type: "BOOLEAN", default: false }),
      );
    }
    expect(client.pendingCount).toBe(49);
    expect(mockFetch).not.toHaveBeenCalled();

    // The 50th declaration trips the threshold → background flush.
    await client.register(new FlagDeclaration({ id: "flag-49", type: "BOOLEAN", default: false }));

    // Let the fire-and-forget flush microtasks settle.
    await vi.waitFor(() => expect(client.pendingCount).toBe(0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retains the buffer and swallows the error when a threshold flush fails", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValue(textResponse("err", 500));

    for (let i = 0; i < 50; i++) {
      await client.register(
        new FlagDeclaration({ id: `flag-${i}`, type: "BOOLEAN", default: false }),
      );
    }

    // _thresholdFlush swallows the rejection (logged via debug, not thrown).
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(client.pendingCount).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// _observeDeclaration via async handle methods
// ---------------------------------------------------------------------------

describe("handle declarations populate the discovery buffer", () => {
  it("booleanFlag/stringFlag/numberFlag/jsonFlag queue typed declarations", async () => {
    const { client } = makeWiredClient({ service: "svc", environment: "prod" });
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }));

    await client.booleanFlag("dark-mode", true);
    await client.stringFlag("theme", "light");
    await client.numberFlag("max-retries", 3);
    await client.jsonFlag("config", { a: 1 });

    const batch = client._buffer.peek();
    const byId = Object.fromEntries(batch.map((b) => [b.id, b]));
    expect(byId["dark-mode"]).toMatchObject({ type: "BOOLEAN", default: true });
    expect(byId["theme"]).toMatchObject({ type: "STRING", default: "light" });
    expect(byId["max-retries"]).toMatchObject({ type: "NUMERIC", default: 3 });
    expect(byId["config"]).toMatchObject({ type: "JSON", default: { a: 1 } });
    expect(byId["dark-mode"]).toMatchObject({ service: "svc", environment: "prod" });
  });
});
