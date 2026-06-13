/**
 * Tests for the audit namespace — events, resource_types, event_types.
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
        eventType: "user.created",
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
              event_type: "invoice.created",
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
    expect(ev.eventType).toBe("invoice.created");
    expect(ev.actorType).toBe("API_KEY");
    expect(ev.actorId).toBeNull();
    await client._close();
  });

  test("get surfaces null actor fields and free-form actor_id", async () => {
    const eventId = "55555555-5555-5555-5555-555555555555";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              id: eventId,
              type: "event",
              attributes: {
                event_type: "invoice.created",
                resource_type: "invoice",
                resource_id: "inv-1",
                occurred_at: "2026-05-06T12:00:00+00:00",
                created_at: "2026-05-06T12:00:01+00:00",
                actor_type: "EXTERNAL_SERVICE",
                actor_id: "not-a-uuid:billing-bot",
                actor_label: null,
                data: {},
                idempotency_key: "auto-abc",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
    );
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
    });
    const ev = await client.events.get(eventId);
    expect(ev.actorType).toBe("EXTERNAL_SERVICE");
    expect(ev.actorId).toBe("not-a-uuid:billing-bot");
    expect(ev.actorLabel).toBeNull();
    await client._close();
  });

  test("record passes actor fields onto the wire", async () => {
    const seenBodies: string[] = [];
    const fetchMock = vi.fn(async (urlOrRequest: string | URL | Request, init?: RequestInit) => {
      const req =
        urlOrRequest instanceof Request ? urlOrRequest : new Request(String(urlOrRequest), init);
      seenBodies.push(await req.text());
      return new Response(
        JSON.stringify({
          data: {
            id: "00000000-0000-0000-0000-000000000001",
            type: "event",
            attributes: {
              event_type: "user.created",
              resource_type: "user",
              resource_id: "u-1",
              occurred_at: "2026-05-06T12:00:00+00:00",
              created_at: "2026-05-06T12:00:01+00:00",
              actor_type: "EXTERNAL_SERVICE",
              actor_id: "not-a-uuid:billing-bot",
              actor_label: "Billing Bot",
              data: {},
              idempotency_key: "auto",
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
    client.events.record({
      eventType: "user.created",
      resourceType: "user",
      resourceId: "u-1",
      actorType: "EXTERNAL_SERVICE",
      actorId: "not-a-uuid:billing-bot",
      actorLabel: "Billing Bot",
    });
    await client.events.flush(2_000);
    const body = JSON.parse(seenBodies[0]!);
    expect(body.data.attributes.actor_type).toBe("EXTERNAL_SERVICE");
    expect(body.data.attributes.actor_id).toBe("not-a-uuid:billing-bot");
    expect(body.data.attributes.actor_label).toBe("Billing Bot");
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
              event_type: "x",
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
      eventType: "user.created",
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
    client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
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
                event_type: "user.created",
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

// ---------------------------------------------------------------------------
// filter[environment] read filter (events.list + discovery lists)
// ---------------------------------------------------------------------------

describe("AuditClient — environments read filter", () => {
  function _captureClient(captured: { url: string }): AuditClient {
    return new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: vi.fn(async (input: unknown, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input as string, init);
        captured.url = req.url;
        return new Response(
          JSON.stringify({ data: [], meta: { pagination: { page: 1, size: 1000 } } }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        );
      }) as typeof fetch,
    });
  }

  // Brackets may arrive percent-encoded depending on openapi-fetch's
  // serializer, so match either literal or %5B/%5D form.
  const FILTER_ENV = /filter(\[|%5B)environment(\]|%5D)=/;

  // Each surface that accepts `environments`, exercised through the same
  // matrix below. `call` invokes the list with the given options.
  const surfaces: Array<{
    name: string;
    call: (c: AuditClient, environments?: string[]) => Promise<unknown>;
  }> = [
    {
      name: "events.list",
      call: (c, environments) => c.events.list(environments === undefined ? {} : { environments }),
    },
    {
      name: "resourceTypes.list",
      call: (c, environments) =>
        c.resourceTypes.list(environments === undefined ? {} : { environments }),
    },
    {
      name: "eventTypes.list",
      call: (c, environments) =>
        c.eventTypes.list(environments === undefined ? {} : { environments }),
    },
  ];

  for (const surface of surfaces) {
    describe(surface.name, () => {
      test("omits filter[environment] when environments is unset", async () => {
        const captured = { url: "" };
        const c = _captureClient(captured);
        await surface.call(c);
        expect(captured.url).not.toMatch(FILTER_ENV);
        await c._close();
      });

      test("omits filter[environment] when environments is an empty array", async () => {
        const captured = { url: "" };
        const c = _captureClient(captured);
        await surface.call(c, []);
        expect(captured.url).not.toMatch(FILTER_ENV);
        await c._close();
      });

      test("sends a single environment value", async () => {
        const captured = { url: "" };
        const c = _captureClient(captured);
        await surface.call(c, ["production"]);
        expect(captured.url).toMatch(/filter(\[|%5B)environment(\]|%5D)=production/);
        await c._close();
      });

      test("comma-joins multiple environment values", async () => {
        const captured = { url: "" };
        const c = _captureClient(captured);
        await surface.call(c, ["production", "staging"]);
        // The comma may be percent-encoded (%2C); accept either form.
        expect(captured.url).toMatch(/filter(\[|%5B)environment(\]|%5D)=production(,|%2C)staging/);
        await c._close();
      });

      test("accepts the reserved 'smplkit' control-plane bucket", async () => {
        const captured = { url: "" };
        const c = _captureClient(captured);
        await surface.call(c, ["smplkit"]);
        expect(captured.url).toMatch(/filter(\[|%5B)environment(\]|%5D)=smplkit/);
        await c._close();
      });
    });
  }
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
              event_type: "x",
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

    client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
    await client.events.flush(2_000);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]!.get("x-test")).toBe("v");
    // SDK Authorization header still present
    expect(seen[0]!.get("authorization")).toMatch(/^Bearer sk_api_test$/);
    await client._close();
  });
});

// ---------------------------------------------------------------------------
// Environment routing (ADR-055): the configured environment travels on the
// event request body when recording and as the default `filter[environment]`
// on reads — never as a request header.
// ---------------------------------------------------------------------------

describe("AuditClient — environment routing (ADR-055)", () => {
  const ENV_HEADER = "x-smplkit-environment";
  // Brackets/commas may arrive percent-encoded; match either form.
  const FILTER_ENV = /filter(\[|%5B)environment(\]|%5D)=/;

  interface Captured {
    url: string;
    headers: Headers;
    body: string;
    method: string;
  }

  // Capture every request and answer with a shape the surface under test
  // accepts: a single event resource for POST /events and GET /events/{id},
  // an empty collection for the list/discovery GETs.
  function _capture(captured: Captured[]): typeof fetch {
    return vi.fn(async (urlOrRequest: string | URL | Request, init?: RequestInit) => {
      const req =
        urlOrRequest instanceof Request ? urlOrRequest : new Request(String(urlOrRequest), init);
      const body = req.method === "GET" ? "" : await req.clone().text();
      captured.push({ url: req.url, headers: req.headers, body, method: req.method });
      const isSingleEvent = req.method === "POST" || /\/events\/[^/?]+/.test(req.url);
      return new Response(
        JSON.stringify(
          isSingleEvent
            ? {
                data: {
                  id: "00000000-0000-0000-0000-000000000001",
                  type: "event",
                  attributes: {
                    event_type: "x",
                    resource_type: "y",
                    resource_id: "1",
                    occurred_at: "2026-05-06T12:00:00+00:00",
                    created_at: "2026-05-06T12:00:01+00:00",
                    data: {},
                    idempotency_key: "",
                    environment: "production",
                  },
                },
              }
            : { data: [], meta: { pagination: { page: 1, size: 1000 } } },
        ),
        {
          status: req.method === "POST" ? 201 : 200,
          headers: { "Content-Type": "application/vnd.api+json" },
        },
      );
    }) as typeof fetch;
  }

  function _bodyEnvironment(body: string): unknown {
    return (JSON.parse(body) as { data: { attributes: Record<string, unknown> } }).data.attributes
      .environment;
  }

  test("never sends the X-Smplkit-Environment header on any runtime op", async () => {
    const captured: Captured[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      environment: "production",
      fetch: _capture(captured),
    });
    client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
    await client.events.flush(2_000);
    await client.events.list();
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const c of captured) expect(c.headers.has(ENV_HEADER)).toBe(false);
    await client._close();
  });

  test("records the configured environment on the event body", async () => {
    const captured: Captured[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      environment: "production",
      fetch: _capture(captured),
    });
    client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
    await client.events.flush(2_000);
    const post = captured.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(_bodyEnvironment(post!.body)).toBe("production");
    await client._close();
  });

  test("scopes events.list to the configured environment via filter[environment]", async () => {
    const captured: Captured[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      environment: "production",
      fetch: _capture(captured),
    });
    await client.events.list();
    expect(captured[0]!.url).toMatch(/filter(\[|%5B)environment(\]|%5D)=production/);
    await client._close();
  });

  test("events.get sends no environment filter (global by-id lookup)", async () => {
    const captured: Captured[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      environment: "staging",
      fetch: _capture(captured),
    });
    await client.events.get("11111111-2222-3333-4444-555555555555");
    expect(captured[0]!.url).not.toMatch(FILTER_ENV);
    await client._close();
  });

  test("scopes discovery listings to the configured environment", async () => {
    const captured: Captured[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      environment: "production",
      fetch: _capture(captured),
    });
    await client.resourceTypes.list();
    await client.eventTypes.list();
    await client.categories.list();
    expect(captured).toHaveLength(3);
    for (const c of captured) {
      expect(c.url).toMatch(/filter(\[|%5B)environment(\]|%5D)=production/);
    }
    await client._close();
  });

  test("omits filter[environment] and the body environment when no environment is configured", async () => {
    const captured: Captured[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: _capture(captured),
    });
    await client.events.list();
    client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
    await client.events.flush(2_000);
    const list = captured.find((c) => c.method === "GET");
    const post = captured.find((c) => c.method === "POST");
    expect(list!.url).not.toMatch(FILTER_ENV);
    expect(_bodyEnvironment(post!.body)).toBeUndefined();
    await client._close();
  });

  test("an explicit environments arg overrides the configured default", async () => {
    const captured: Captured[] = [];
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      environment: "production",
      fetch: _capture(captured),
    });
    await client.events.list({ environments: ["staging"] });
    expect(captured[0]!.url).toMatch(/filter(\[|%5B)environment(\]|%5D)=staging/);
    expect(captured[0]!.url).not.toMatch(/production/);
    await client._close();
  });

  test("surfaces the environment field on a parsed event", async () => {
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      environment: "production",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: "00000000-0000-0000-0000-000000000009",
                type: "event",
                attributes: {
                  event_type: "invoice.created",
                  resource_type: "invoice",
                  resource_id: "inv-9",
                  occurred_at: "2026-05-06T12:00:00+00:00",
                  created_at: "2026-05-06T12:00:01+00:00",
                  actor_type: "API_KEY",
                  actor_id: null,
                  actor_label: "",
                  data: {},
                  idempotency_key: "k",
                  environment: "production",
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
          ),
      ) as typeof fetch,
    });
    const ev = await client.events.get("00000000-0000-0000-0000-000000000009");
    expect(ev.environment).toBe("production");
    await client._close();
  });

  test("environment is null when the wire omits it", async () => {
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: "00000000-0000-0000-0000-000000000010",
                type: "event",
                attributes: {
                  event_type: "x",
                  resource_type: "y",
                  resource_id: "z",
                  occurred_at: "2026-05-06T12:00:00+00:00",
                  created_at: "2026-05-06T12:00:01+00:00",
                  data: {},
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
          ),
      ) as typeof fetch,
    });
    const ev = await client.events.get("00000000-0000-0000-0000-000000000010");
    expect(ev.environment).toBeNull();
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
                event_type: "user.created",
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
      eventType: "user.created",
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
                  event_type: "x",
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
            meta: { pagination: { page: 1, size: 1000 } },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
    );
    const page = await c.resourceTypes.list();
    expect(page.resourceTypes).toHaveLength(2);
    expect(page.resourceTypes[0]!.id).toBe("invoice");
    expect(page.resourceTypes[1]!.id).toBe("user");
    expect(page.pagination).toEqual({ page: 1, size: 1000 });
    await c._close();
  });

  test("list passes page[number], page[size], meta[total] and reads totals", async () => {
    let capturedUrl = "";
    const c = _newClient(async (req) => {
      capturedUrl = req.url;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "invoice",
              type: "resource_type",
              attributes: { resource_type: "invoice", created_at: "2026-01-01T00:00:00Z" },
            },
          ],
          meta: { pagination: { page: 2, size: 1, total: 3, total_pages: 3 } },
        }),
        { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
      );
    });
    const page = await c.resourceTypes.list({ pageNumber: 2, pageSize: 1, metaTotal: true });
    expect(capturedUrl).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect(capturedUrl).toMatch(/page(\[|%5B)size(\]|%5D)=1/);
    // booleans serialize lowercase
    expect(capturedUrl).toMatch(/meta(\[|%5B)total(\]|%5D)=true/);
    expect(page.pagination).toEqual({ page: 2, size: 1, total: 3, totalPages: 3 });
    await c._close();
  });

  test("list returns zeroed pagination when meta block missing", async () => {
    const c = _newClient(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/vnd.api+json" },
        }),
    );
    const page = await c.resourceTypes.list();
    expect(page.pagination).toEqual({ page: 0, size: 0 });
    await c._close();
  });

  test("list throws SmplError on 500", async () => {
    const c = _newClient(async () => new Response("server error", { status: 500 }));
    await expect(c.resourceTypes.list()).rejects.toBeInstanceOf(SmplError);
    await c._close();
  });
});

// ---------------------------------------------------------------------------
// event_types
// ---------------------------------------------------------------------------

describe("AuditClient.eventTypes", () => {
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

  test("list returns event type slugs", async () => {
    const c = _newClient(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "invoice.created",
                type: "event_type",
                attributes: { event_type: "invoice.created", created_at: "2026-01-01T00:00:00Z" },
              },
              {
                id: "user.updated",
                type: "event_type",
                attributes: { event_type: "user.updated", created_at: "2026-01-02T00:00:00Z" },
              },
            ],
            meta: { pagination: { page: 1, size: 1000 } },
          }),
          { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
        ),
    );
    const page = await c.eventTypes.list();
    expect(page.eventTypes).toHaveLength(2);
    expect(page.eventTypes[0]!.id).toBe("invoice.created");
    expect(page.eventTypes[1]!.id).toBe("user.updated");
    expect(page.pagination).toEqual({ page: 1, size: 1000 });
    await c._close();
  });

  test("list passes filter[resource_type] when filterResourceType given", async () => {
    let capturedUrl = "";
    const c = _newClient(async (req) => {
      capturedUrl = req.url;
      return new Response(
        JSON.stringify({ data: [], meta: { pagination: { page: 1, size: 1000 } } }),
        { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
      );
    });
    await c.eventTypes.list({ filterResourceType: "invoice" });
    // openapi-fetch may or may not percent-encode brackets; check for either form
    expect(capturedUrl).toMatch(/filter(\[|%5B)resource_type(\]|%5D)=invoice/);
    await c._close();
  });

  test("list passes page[number], page[size], meta[total] and reads totals", async () => {
    let capturedUrl = "";
    const c = _newClient(async (req) => {
      capturedUrl = req.url;
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "invoice.created",
              type: "event_type",
              attributes: { event_type: "invoice.created", created_at: "2026-01-01T00:00:00Z" },
            },
          ],
          meta: { pagination: { page: 2, size: 1, total: 3, total_pages: 3 } },
        }),
        { status: 200, headers: { "Content-Type": "application/vnd.api+json" } },
      );
    });
    const page = await c.eventTypes.list({ pageNumber: 2, pageSize: 1, metaTotal: true });
    expect(capturedUrl).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect(capturedUrl).toMatch(/page(\[|%5B)size(\]|%5D)=1/);
    expect(capturedUrl).toMatch(/meta(\[|%5B)total(\]|%5D)=true/);
    expect(page.pagination).toEqual({ page: 2, size: 1, total: 3, totalPages: 3 });
    await c._close();
  });

  test("list throws SmplError on 500", async () => {
    const c = _newClient(async () => new Response("server error", { status: 500 }));
    await expect(c.eventTypes.list()).rejects.toBeInstanceOf(SmplError);
    await c._close();
  });
});
