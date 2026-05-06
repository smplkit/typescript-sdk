/**
 * Tests for the audit namespace.
 */

import { describe, expect, test, vi } from "vitest";
import { AuditClient } from "../../../src/audit/client.js";

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
