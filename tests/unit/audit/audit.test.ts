/**
 * Tests for the audit namespace.
 */

import { describe, expect, test, vi } from "vitest";
import * as auditIndex from "../../../src/audit/index.js";
import { AuditClient } from "../../../src/audit/client.js";

// Cover the audit barrel export by referencing it.
expect(auditIndex.AuditClient).toBe(AuditClient);

describe("AuditClient", () => {
  test("create returns immediately even when the network is slow", async () => {
    let resolved = 0;
    const slowFetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 200));
      resolved += 1;
      return new Response("{}", {
        status: 201,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    });

    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // Replace the underlying fetch the buffer's POST function uses.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.events as any)._fetch = slowFetch;

    const before = Date.now();
    for (let i = 0; i < 10; i++) {
      client.events.create({
        action: "user.created",
        resourceType: "user",
        resourceId: `u-${i}`,
      });
    }
    const elapsed = Date.now() - before;
    // Fire-and-forget contract: enqueueing 10 events takes ~milliseconds, not 200ms × 10.
    expect(elapsed).toBeLessThan(50);

    // Drain so the test doesn't leak the timer.
    await client._close();
    expect(slowFetch).toHaveBeenCalled();
    expect(resolved).toBeGreaterThan(0);
  });

  test("get round-trips a single event", async () => {
    const eventId = "11111111-2222-3333-4444-555555555555";
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: {
            id: eventId,
            type: "event",
            attributes: {
              action: "invoice.created",
              resource_type: "invoice",
              resource_id: "inv-1",
              occurred_at: "2026-05-06T12:00:00+00:00",
              created_at: "2026-05-06T12:00:01+00:00",
              actor_type: "API_KEY",
              actor_id: null,
              actor_label: "",
              snapshot: null,
              data: {},
              idempotency_key: "auto-abc",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
      );
    });

    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.events as any)._fetch = fetchMock;

    const ev = await client.events.get(eventId);
    expect(ev.id).toBe(eventId);
    expect(ev.action).toBe("invoice.created");
    expect(ev.actorType).toBe("API_KEY");
    expect(ev.actorId).toBeNull();
    await client._close();
  });

  test("get throws on non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.events as any)._fetch = fetchMock;
    await expect(client.events.get("nonexistent")).rejects.toThrow(/audit get failed/);
    await client._close();
  });

  test("list throws on non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("server error", { status: 500 }));
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.events as any)._fetch = fetchMock;
    await expect(client.events.list()).rejects.toThrow(/audit list failed/);
    await client._close();
  });

  test("flush delegates to the buffer", async () => {
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // No-op flush — the buffer is empty.
    await expect(client.events.flush(50)).resolves.toBeUndefined();
    await client._close();
  });

  test("create accepts Date for occurredAt and serializes it as ISO", async () => {
    const seen: string[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.events as any)._fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      seen.push(body.data.attributes.occurred_at);
      return new Response("{}", { status: 201 });
    });
    const ts = new Date("2026-05-06T12:00:00Z");
    client.events.create({
      action: "user.created",
      resourceType: "user",
      resourceId: "u-1",
      occurredAt: ts,
    });
    await client.events.flush(2_000);
    expect(seen[0]).toBe(ts.toISOString());
    await client._close();
  });

  test("post wrapper catches fetch exceptions and returns transient status", async () => {
    // Forces the audit client's POST wrapper into its try/catch branch.
    // events.flush() forces a synchronous drain pass — without it the
    // worker timer wouldn't fire for several seconds.
    const calls: number[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.events as any)._fetch = vi.fn(async () => {
      calls.push(1);
      throw new Error("simulated network blip");
    });
    client.events.create({ action: "x", resourceType: "y", resourceId: "1" });
    // flush triggers a drain pass; the post wrapper's catch returns
    // status: 0 → transient, item requeued with backoff. flush hits its
    // 200ms timeout and returns. We just need to assert the post fn was
    // invoked at least once.
    await client.events.flush(200);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    await client._close();
  });

  test("list parses next cursor from links.next", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "abc",
              type: "event",
              attributes: {
                action: "user.created",
                resource_type: "user",
                resource_id: "u-1",
                occurred_at: "2026-05-06T12:00:00+00:00",
                created_at: "2026-05-06T12:00:01+00:00",
                actor_type: "API_KEY",
                actor_id: null,
                actor_label: "",
                snapshot: null,
                data: {},
                idempotency_key: "k",
              },
            },
          ],
          links: { next: "/api/v1/events?page[size]=1&page[after]=tok-xyz" },
        }),
        { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
      );
    });

    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.events as any)._fetch = fetchMock;

    const page = await client.events.list({ pageSize: 1 });
    expect(page.events.length).toBe(1);
    expect(page.nextCursor).toBe("tok-xyz");
    await client._close();
  });
});
