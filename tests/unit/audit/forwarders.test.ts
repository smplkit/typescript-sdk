/**
 * Tests for the audit forwarders / functions wrapper surface.
 *
 * Stubs `fetch` end-to-end — no network. Coverage target is 100% on
 * the new wrapper code.
 */

import { describe, expect, test, vi } from "vitest";

import { AuditClient } from "../../../src/audit/client.js";
import type { Forwarder, ForwarderDelivery, ForwarderHttp } from "../../../src/audit/types.js";

const FWD_ID = "11111111-2222-3333-4444-555555555555";
const DELIVERY_ID = "22222222-3333-4444-5555-666666666666";

function _forwarderResource(name = "Datadog production") {
  return {
    id: FWD_ID,
    type: "forwarder",
    attributes: {
      name,
      slug: name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
      forwarder_type: "DATADOG",
      enabled: true,
      filter: null,
      transform: null,
      http: {
        method: "POST",
        url: "https://siem.example.com/in",
        headers: [{ name: "DD-API-KEY", value: "<redacted>" }],
        body: null,
        success_status: "2xx",
      },
      data: {},
      created_at: "2026-05-07T12:00:00+00:00",
      updated_at: "2026-05-07T12:00:00+00:00",
      deleted_at: null,
      version: 1,
    },
  };
}

function _deliveryResource(status = "SUCCEEDED") {
  return {
    id: DELIVERY_ID,
    type: "forwarder_delivery",
    attributes: {
      forwarder_id: FWD_ID,
      event_id: "33333333-4444-5555-6666-777777777777",
      attempt_number: 1,
      status,
      request: {
        method: "POST",
        url: "https://siem.example.com/in",
        headers: [{ name: "X-K", value: "<redacted>" }],
        body: '{"action":"user.created"}',
      },
      response_status: 202,
      response_body: "ok",
      latency_ms: 42,
      error: null,
      created_at: "2026-05-07T12:00:01+00:00",
    },
  };
}

function _jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function _newClient(handler: (req: Request) => Promise<Response>): AuditClient {
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    return handler(req);
  });
  return new AuditClient({
    apiKey: "sk_api_test",
    baseUrl: "https://audit.example.com",
    fetch: f as unknown as typeof fetch,
  });
}

const _httpInput: ForwarderHttp = {
  method: "POST",
  url: "https://siem.example.com/in",
  headers: [{ name: "DD-API-KEY", value: "real-secret" }],
  body: null,
  successStatus: "2xx",
};

// --------------------------------------------------------------------------
// Forwarders CRUD
// --------------------------------------------------------------------------

describe("AuditClient.forwarders", () => {
  test("create posts JSON:API and returns a Forwarder", async () => {
    let captured: { method: string; body: string; url: string } | null = null;
    const c = _newClient(async (req) => {
      captured = { method: req.method, body: await req.text(), url: req.url };
      return _jsonResponse({ data: _forwarderResource() }, 201);
    });

    const fwd = await c.forwarders.create({
      name: "Datadog production",
      forwarderType: "DATADOG",
      http: _httpInput,
      filter: { "==": [{ var: "action" }, "user.created"] },
      transform: "$",
      data: { team: "platform" },
    });
    expect(fwd.slug).toBe("datadog_production");
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain("/api/v1/forwarders");
    expect(captured!.body).toContain("user.created");
    await c._close();
  });

  test("create throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({ errors: [{ status: "402" }] }, 402));
    await expect(
      c.forwarders.create({ name: "x", forwarderType: "HTTP", http: _httpInput }),
    ).rejects.toThrow(/audit create forwarder failed/);
    await c._close();
  });

  test("list paginates and returns nextCursor", async () => {
    const pages = [
      {
        data: [_forwarderResource("A")],
        meta: { page_size: 1 },
        links: { next: "/api/v1/forwarders?page[size]=1&page[after]=tok-2" },
      },
      { data: [_forwarderResource("B")], meta: { page_size: 1 } },
    ];
    let i = 0;
    const c = _newClient(async () => _jsonResponse(pages[i++]!));
    const first = await c.forwarders.list({
      forwarderType: "DATADOG",
      enabled: true,
      pageSize: 1,
    });
    expect(first.forwarders).toHaveLength(1);
    expect(first.nextCursor).toBe("tok-2");
    const second = await c.forwarders.list({ pageSize: 1, pageAfter: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    await c._close();
  });

  test("list throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({ errors: [] }, 500));
    await expect(c.forwarders.list()).rejects.toThrow(/audit list forwarders failed/);
    await c._close();
  });

  test("get fetches by id", async () => {
    const c = _newClient(async (req) => {
      expect(req.url).toContain(FWD_ID);
      return _jsonResponse({ data: _forwarderResource() });
    });
    const fwd = await c.forwarders.get(FWD_ID);
    expect(fwd.id).toBe(FWD_ID);
    expect(fwd.http.headers[0]!.value).toBe("<redacted>");
    await c._close();
  });

  test("get throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({}, 404));
    await expect(c.forwarders.get(FWD_ID)).rejects.toThrow(/audit get forwarder failed/);
    await c._close();
  });

  test("update sends a PUT and returns updated Forwarder", async () => {
    let captured: { method: string } | null = null;
    const c = _newClient(async (req) => {
      captured = { method: req.method };
      return _jsonResponse({ data: _forwarderResource("Renamed") });
    });
    const fwd = await c.forwarders.update(FWD_ID, {
      name: "Renamed",
      forwarderType: "DATADOG",
      http: _httpInput,
      enabled: false,
      filter: { "==": [1, 1] },
      transform: "$",
      data: { k: "v" },
    });
    expect(captured!.method).toBe("PUT");
    expect(fwd.name).toBe("Renamed");
    await c._close();
  });

  test("update throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({}, 404));
    await expect(
      c.forwarders.update(FWD_ID, { name: "x", forwarderType: "HTTP", http: _httpInput }),
    ).rejects.toThrow(/audit update forwarder failed/);
    await c._close();
  });

  test("delete sends DELETE and resolves on 204", async () => {
    let captured: string | null = null;
    const c = _newClient(async (req) => {
      captured = req.method;
      return new Response(null, { status: 204 });
    });
    await c.forwarders.delete(FWD_ID);
    expect(captured).toBe("DELETE");
    await c._close();
  });

  test("delete throws on non-204", async () => {
    const c = _newClient(async () => _jsonResponse({}, 404));
    await expect(c.forwarders.delete(FWD_ID)).rejects.toThrow(/audit delete forwarder failed/);
    await c._close();
  });
});

// --------------------------------------------------------------------------
// Deliveries
// --------------------------------------------------------------------------

describe("AuditClient.forwarders.deliveries", () => {
  test("list filters and paginates", async () => {
    const pages = [
      {
        data: [_deliveryResource("SUCCEEDED")],
        meta: { page_size: 1 },
        links: {
          next: `/api/v1/forwarders/${FWD_ID}/deliveries?page[size]=1&page[after]=tok-2`,
        },
      },
      { data: [_deliveryResource("FAILED")], meta: { page_size: 1 } },
    ];
    let i = 0;
    const c = _newClient(async () => _jsonResponse(pages[i++]!));

    const first = await c.forwarders.deliveries.list(FWD_ID, {
      status: "SUCCEEDED",
      createdAtRange: "[2020-01-01T00:00:00Z,*)",
      pageSize: 1,
    });
    expect(first.deliveries[0]!.status).toBe("SUCCEEDED");
    expect(first.nextCursor).toBe("tok-2");

    const second = await c.forwarders.deliveries.list(FWD_ID, { pageAfter: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    await c._close();
  });

  test("list passes filter[event_id] in query string", async () => {
    const EVENT_ID = "33333333-4444-5555-6666-777777777777";
    let capturedUrl = "";
    const c = _newClient(async (req) => {
      capturedUrl = req.url;
      return _jsonResponse({ data: [_deliveryResource()], meta: { page_size: 20 } });
    });
    const page = await c.forwarders.deliveries.list(FWD_ID, { eventId: EVENT_ID });
    expect(capturedUrl).toContain(`filter[event_id]=${EVENT_ID}`);
    expect(page.deliveries).toHaveLength(1);
    await c._close();
  });

  test("list throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({}, 500));
    await expect(c.forwarders.deliveries.list(FWD_ID)).rejects.toThrow(
      /audit list deliveries failed/,
    );
    await c._close();
  });

  test("retry returns the new attempt row", async () => {
    const c = _newClient(async (req) => {
      expect(req.url).toContain("actions/retry");
      return _jsonResponse({ data: _deliveryResource("SUCCEEDED") });
    });
    const row: ForwarderDelivery = await c.forwarders.deliveries.actions.retry(FWD_ID, DELIVERY_ID);
    expect(row.status).toBe("SUCCEEDED");
    await c._close();
  });

  test("retry throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({}, 500));
    await expect(c.forwarders.deliveries.actions.retry(FWD_ID, DELIVERY_ID)).rejects.toThrow(
      /audit retry delivery failed/,
    );
    await c._close();
  });
});

// --------------------------------------------------------------------------
// Bulk retry
// --------------------------------------------------------------------------

describe("AuditClient.forwarders.actions", () => {
  test("retryFailedDeliveries returns the summary", async () => {
    const c = _newClient(async () => _jsonResponse({ attempted: 3, succeeded: 2, failed: 1 }));
    const summary = await c.forwarders.actions.retryFailedDeliveries(FWD_ID);
    expect(summary).toEqual({ attempted: 3, succeeded: 2, failed: 1 });
    await c._close();
  });

  test("retryFailedDeliveries throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({}, 500));
    await expect(c.forwarders.actions.retryFailedDeliveries(FWD_ID)).rejects.toThrow(
      /audit bulk retry failed/,
    );
    await c._close();
  });
});

// --------------------------------------------------------------------------
// functions.test_forwarder.actions.execute
// --------------------------------------------------------------------------

describe("AuditClient.functions.test_forwarder.actions.execute", () => {
  test("returns the proxied response", async () => {
    let capturedHeaders: Headers | null = null;
    const c = _newClient(async (req) => {
      capturedHeaders = req.headers;
      return new Response(
        JSON.stringify({
          succeeded: true,
          response_status: 202,
          response_headers: { "X-Echo": "y" },
          response_body: "accepted",
          latency_ms: 12,
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const r = await c.functions.test_forwarder.actions.execute({
      url: "https://siem.example.com/in",
      headers: [{ name: "X-K", value: "v" }],
      body: '{"hello":"world"}',
      successStatus: "2xx",
      timeoutMs: 5000,
    });
    expect(r.succeeded).toBe(true);
    expect(r.responseStatus).toBe(202);
    expect(r.responseBody).toBe("accepted");
    // The proxy endpoint must not advertise vnd.api+json — server rejects that.
    expect(capturedHeaders!.get("content-type")).toBe("application/json");
    await c._close();
  });

  test("execute throws on non-2xx", async () => {
    const c = _newClient(async () => _jsonResponse({}, 500));
    await expect(c.functions.test_forwarder.actions.execute({ url: "https://x" })).rejects.toThrow(
      /audit test_forwarder failed/,
    );
    await c._close();
  });
});

// --------------------------------------------------------------------------
// do_not_forward kwarg on event create
// --------------------------------------------------------------------------

describe("AuditClient.events.record do_not_forward", () => {
  test("forwards the do_not_forward flag in the request body", async () => {
    let captured = "";
    const c = _newClient(async (req) => {
      captured = await req.text();
      return _jsonResponse(
        {
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
        },
        201,
      );
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
    const c = _newClient(async () =>
      _jsonResponse({
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
    );
    const ev = await c.events.get("33333333-4444-5555-6666-777777777777");
    expect(ev.doNotForward).toBe(true);
    await c._close();
  });
});

// --------------------------------------------------------------------------
// Coverage: forwarder constructed from a wire shape with missing fields.
// --------------------------------------------------------------------------

describe("Forwarder._fromResource defaults", () => {
  test("missing optional fields default cleanly", async () => {
    const c = _newClient(async () =>
      _jsonResponse({
        data: {
          id: FWD_ID,
          type: "forwarder",
          attributes: {
            // intentionally minimal
            name: "x",
            slug: "x",
            forwarder_type: "HTTP",
            enabled: false,
          },
        },
      }),
    );
    const fwd: Forwarder = await c.forwarders.get(FWD_ID);
    expect(fwd.http.method).toBe("POST");
    expect(fwd.http.headers).toEqual([]);
    expect(fwd.http.successStatus).toBe("2xx");
    expect(fwd.filter).toBeNull();
    expect(fwd.data).toEqual({});
    await c._close();
  });
});
