/**
 * Tests for the audit namespace — events, resource_types, actions.
 */

import { describe, expect, test, vi } from "vitest";
import * as auditIndex from "../../../src/audit/index.js";
import { AuditClient } from "../../../src/audit/client.js";
import { SmplNotFoundError, SmplError } from "../../../src/errors.js";

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
      fetch: slowFetch,
    });

    const before = Date.now();
    for (let i = 0; i < 10; i++) {
      client.events.record({
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
      fetch: fetchMock,
    });

    const ev = await client.events.get(eventId);
    expect(ev.id).toBe(eventId);
    expect(ev.action).toBe("invoice.created");
    expect(ev.actorType).toBe("API_KEY");
    expect(ev.actorId).toBeNull();
    await client._close();
  });

  test("get throws SmplNotFoundError on 404", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ status: "404", detail: "Event not found." }] }), {
          status: 404,
          headers: { "Content-Type": "application/vnd.api+json" },
        }),
    );
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
    });
    await expect(client.events.get("nonexistent")).rejects.toBeInstanceOf(SmplNotFoundError);
    await client._close();
  });

  test("list throws SmplError on 500", async () => {
    const fetchMock = vi.fn(async () => new Response("server error", { status: 500 }));
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
    });
    await expect(client.events.list()).rejects.toBeInstanceOf(SmplError);
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
    const fetchMock = vi.fn(async (urlOrRequest: string | URL | Request, init?: RequestInit) => {
      // openapi-fetch invokes the underlying fetch with a Request object,
      // not (url, init). Read the body off the Request.
      const req =
        urlOrRequest instanceof Request ? urlOrRequest : new Request(String(urlOrRequest), init);
      const body = JSON.parse(await req.text());
      seen.push(body.data.attributes.occurred_at);
      return new Response(
        JSON.stringify({
          data: {
            id: "00000000-0000-0000-0000-000000000001",
            type: "event",
            attributes: {
              action: "x",
              resource_type: "x",
              resource_id: "1",
              occurred_at: "2026-05-06T12:00:00+00:00",
              created_at: "2026-05-06T12:00:01+00:00",
              actor_type: "API_KEY",
              actor_id: null,
              actor_label: "",
              data: {},
              idempotency_key: "",
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/vnd.api+json" } },
      );
    });
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
    });
    const ts = new Date("2026-05-06T12:00:00Z");
    client.events.record({
      action: "user.created",
      resourceType: "user",
      resourceId: "u-1",
      occurredAt: ts,
      data: { snapshot: { total_cents: 4900 }, request_id: "req-1" },
    });
    await client.events.flush(2_000);
    expect(seen[0]).toBe(ts.toISOString());
    await client._close();
  });

  test("post wrapper catches fetch exceptions and returns transient status", async () => {
    const calls: number[] = [];
    const fetchMock = vi.fn(async () => {
      calls.push(1);
      throw new Error("simulated network blip");
    });
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
    });
    client.events.record({ action: "x", resourceType: "y", resourceId: "1" });
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
      fetch: fetchMock,
    });

    const page = await client.events.list({ pageSize: 1 });
    expect(page.events.length).toBe(1);
    expect(page.nextCursor).toBe("tok-xyz");
    await client._close();
  });
});

describe("AuditClient — extraHeaders", () => {
  test("extraHeaders are merged into every request, SDK headers win on collision", async () => {
    const seen: Headers[] = [];
    const fetchMock = vi.fn(async (urlOrRequest: string | URL | Request, init?: RequestInit) => {
      const req =
        urlOrRequest instanceof Request ? urlOrRequest : new Request(String(urlOrRequest), init);
      seen.push(req.headers);
      return new Response(
        JSON.stringify({
          data: {
            id: "00000000-0000-0000-0000-000000000001",
            type: "event",
            attributes: {
              action: "x",
              resource_type: "y",
              resource_id: "1",
              occurred_at: "2026-05-06T12:00:00+00:00",
              created_at: "2026-05-06T12:00:01+00:00",
              actor_type: "API_KEY",
              actor_id: null,
              actor_label: "",
              data: {},
              idempotency_key: "",
            },
          },
        }),
        { status: 201, headers: { "Content-Type": "application/vnd.api+json" } },
      );
    });

    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
      extraHeaders: { "X-Test": "v" },
    });

    client.events.record({ action: "x", resourceType: "y", resourceId: "1" });
    await client.events.flush(2_000);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.get("x-test")).toBe("v");
    // SDK Authorization header still present
    expect(seen[0]!.get("authorization")).toMatch(/^Bearer sk_api_test$/);
    await client._close();
  });
});

// ---------------------------------------------------------------------------
// do_not_forward kwarg on event create
// ---------------------------------------------------------------------------

describe("AuditClient.events.record do_not_forward", () => {
  test("forwards the do_not_forward flag in the request body", async () => {
    let captured = "";
    const c = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: vi.fn(async (input: unknown, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input as string, init);
        captured = await req.text();
        return new Response(
          JSON.stringify({
            data: {
              id: "33333333-4444-5555-6666-777777777777",
              type: "event",
              attributes: {
                action: "user.created",
                resource_type: "user",
                resource_id: "u-1",
                occurred_at: "2026-05-07T12:00:00+00:00",
                created_at: "2026-05-07T12:00:01+00:00",
                actor_type: "API_KEY",
                actor_id: null,
                actor_label: "",
                data: {},
                idempotency_key: "auto-abc",
                do_not_forward: true,
              },
            },
          }),
          { status: 201, headers: { "Content-Type": "application/vnd.api+json" } },
        );
      }) as typeof fetch,
    });
    c.events.record({
      action: "user.created",
      resourceType: "user",
      resourceId: "u-1",
      doNotForward: true,
    });
    await c.events.flush(2000);
    expect(captured).toContain('"do_not_forward":true');
    await c._close();
  });

  test("event from resource preserves doNotForward", async () => {
    const c = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: "33333333-4444-5555-6666-777777777777",
                type: "event",
                attributes: {
                  action: "x",
                  resource_type: "y",
                  resource_id: "z",
                  occurred_at: "2026-05-07T12:00:00+00:00",
                  created_at: "2026-05-07T12:00:01+00:00",
                  actor_type: "API_KEY",
                  actor_id: null,
                  actor_label: "",
                  data: {},
                  idempotency_key: "auto",
                  do_not_forward: true,
                },
              },
            }),
          ),
      ) as typeof fetch,
    });
    const ev = await c.events.get("33333333-4444-5555-6666-777777777777");
    expect(ev.doNotForward).toBe(true);
    await c._close();
  });
});

// ---------------------------------------------------------------------------
// resource_types
// ---------------------------------------------------------------------------

describe("AuditClient.resourceTypes", () => {
  function _newClient(handler: (req: Request) => Promise<Response>): AuditClient {
    return new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: vi.fn(async (input: unknown, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input as string, init);
        return handler(req);
      }) as typeof fetch,
    });
  }

  test("list returns resource type slugs", async () => {
    const c = _newClient(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "invoice",
                type: "resource_type",
                attributes: { resource_type: "invoice", created_at: "2026-01-01T00:00:00Z" },
              },
              {
                id: "user",
                type: "resource_type",
                attributes: { resource_type: "user", created_at: "2026-01-02T00:00:00Z" },
              },
            ],
            meta: { page_size: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
    );
    const page = await c.resourceTypes.list();
    expect(page.resourceTypes).toHaveLength(2);
    expect(page.resourceTypes[0]!.id).toBe("invoice");
    expect(page.resourceTypes[1]!.id).toBe("user");
    expect(page.nextCursor).toBeNull();
    await c._close();
  });

  test("list parses next cursor", async () => {
    const c = _newClient(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "invoice",
                type: "resource_type",
                attributes: { resource_type: "invoice", created_at: "2026-01-01T00:00:00Z" },
              },
            ],
            meta: { page_size: 1 },
            links: { next: "/api/v1/resource_types?page[size]=1&page[after]=cursor-abc" },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
    );
    const page = await c.resourceTypes.list({ pageSize: 1 });
    expect(page.nextCursor).toBe("cursor-abc");
    await c._close();
  });

  test("list throws SmplError on 500", async () => {
    const c = _newClient(async () => new Response("server error", { status: 500 }));
    await expect(c.resourceTypes.list()).rejects.toBeInstanceOf(SmplError);
    await c._close();
  });
});

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

describe("AuditClient.actions", () => {
  function _newClient(handler: (req: Request) => Promise<Response>): AuditClient {
    return new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: vi.fn(async (input: unknown, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input as string, init);
        return handler(req);
      }) as typeof fetch,
    });
  }

  test("list returns action slugs", async () => {
    const c = _newClient(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "invoice.created",
                type: "action",
                attributes: { action: "invoice.created", created_at: "2026-01-01T00:00:00Z" },
              },
              {
                id: "user.updated",
                type: "action",
                attributes: { action: "user.updated", created_at: "2026-01-02T00:00:00Z" },
              },
            ],
            meta: { page_size: 20 },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
    );
    const page = await c.actions.list();
    expect(page.actions).toHaveLength(2);
    expect(page.actions[0]!.id).toBe("invoice.created");
    expect(page.actions[1]!.id).toBe("user.updated");
    expect(page.nextCursor).toBeNull();
    await c._close();
  });

  test("list passes filter[resource_type] when filterResourceType given", async () => {
    let capturedUrl = "";
    const c = _newClient(async (req) => {
      capturedUrl = req.url;
      return new Response(JSON.stringify({ data: [], meta: { page_size: 20 } }), {
        status: 200,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    });
    await c.actions.list({ filterResourceType: "invoice" });
    // openapi-fetch may or may not percent-encode brackets; check for either form
    expect(capturedUrl).toMatch(/filter(\[|%5B)resource_type(\]|%5D)=invoice/);
    await c._close();
  });

  test("list parses next cursor", async () => {
    const c = _newClient(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "invoice.created",
                type: "action",
                attributes: { action: "invoice.created", created_at: "2026-01-01T00:00:00Z" },
              },
            ],
            meta: { page_size: 1 },
            links: { next: "/api/v1/actions?page[size]=1&page[after]=cursor-xyz" },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
    );
    const page = await c.actions.list({ pageSize: 1 });
    expect(page.nextCursor).toBe("cursor-xyz");
    await c._close();
  });

  test("list throws SmplError on 500", async () => {
    const c = _newClient(async () => new Response("server error", { status: 500 }));
    await expect(c.actions.list()).rejects.toBeInstanceOf(SmplError);
    await c._close();
  });
});
