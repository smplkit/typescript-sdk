/**
 * Wire-body shape tests for the audit wrapper.
 *
 * These tests intercept the actual fetch the SDK posts and assert on the
 * JSON envelope key-by-key. They guard against the failure mode that
 * shipped @smplkit/sdk@3.0.19: the generated client compiled cleanly
 * after the spec dropped a field, but the wrapper kept emitting it,
 * and CI was none the wiser because no test inspected the bytes.
 *
 * The whitelists below are taken from the audit service's OpenAPI
 * spec, not the generated client (which is itself a projection of the
 * spec). Read-only fields (created_at, actor_*, idempotency_key,
 * version, etc.) MUST NOT appear in request bodies.
 */

import { describe, expect, test, vi } from "vitest";

import { AuditClient } from "../../../src/audit/client.js";
import type { ForwarderHttp } from "../../../src/audit/types.js";

const FWD_ID = "11111111-2222-3333-4444-555555555555";

// Whitelist from openapi/audit.json — POST /api/v1/events allows only
// these attributes. created_at, actor_*, idempotency_key are readOnly.
const EVENT_POST_ATTRS = new Set([
  "action",
  "resource_type",
  "resource_id",
  "occurred_at",
  "data",
  "do_not_forward",
]);

// POST/PUT /api/v1/forwarders allows only these attributes. slug is
// x-immutable (server-derived); created_at/updated_at/deleted_at/version
// are readOnly.
const FORWARDER_POST_ATTRS = new Set([
  "name",
  "forwarder_type",
  "http",
  "enabled",
  "filter",
  "transform",
  "data",
]);

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function newClientCapturing(
  captured: CapturedRequest[],
  responseStatus: number,
  responseBody: unknown,
): AuditClient {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    const text = await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    captured.push({
      method: req.method,
      url: req.url,
      headers,
      body: text ? JSON.parse(text) : null,
    });
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "Content-Type": "application/vnd.api+json" },
    });
  });
  return new AuditClient({
    apiKey: "sk_api_test",
    baseUrl: "https://audit.example.com",
    fetch: fetchMock as unknown as typeof fetch,
  });
}

function eventResponseBody(eventId = "00000000-0000-0000-0000-000000000001") {
  return {
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
        idempotency_key: "k-1",
      },
    },
  };
}

function forwarderResponseBody(name = "Datadog production") {
  return {
    data: {
      id: FWD_ID,
      type: "forwarder",
      attributes: {
        name,
        slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
        forwarder_type: "datadog",
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
    },
  };
}

const httpInput: ForwarderHttp = {
  method: "POST",
  url: "https://siem.example.com/in",
  headers: [{ name: "DD-API-KEY", value: "real-secret" }],
  body: null,
  successStatus: "2xx",
};

// ---------------------------------------------------------------------------
// events.record
// ---------------------------------------------------------------------------

describe("AuditClient.events.record — wire-body shape", () => {
  test("all parameters serialize to the documented shape", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, eventResponseBody());
    c.events.record({
      action: "invoice.created",
      resourceType: "invoice",
      resourceId: "inv-1",
      occurredAt: new Date("2026-05-06T12:00:00Z"),
      data: { snapshot: { total_cents: 4900 }, request_id: "req-1" },
      idempotencyKey: "k-1",
      doNotForward: true,
    });
    await c.events.flush(2_000);
    await c._close();

    expect(captured).toHaveLength(1);
    const body = captured[0]!.body as {
      data: { id: string; type: string; attributes: Record<string, unknown> };
    };

    // Envelope.
    expect(Object.keys(body)).toEqual(["data"]);
    expect(body.data.type).toBe("event");
    // ID is a placeholder on POST — server assigns. The TS wrapper
    // sends "" because the generated request body type marks id required.
    expect(body.data.id).toBe("");

    const attrs = body.data.attributes;
    expect(attrs.action).toBe("invoice.created");
    expect(attrs.resource_type).toBe("invoice");
    expect(attrs.resource_id).toBe("inv-1");
    expect(attrs.occurred_at).toBe("2026-05-06T12:00:00.000Z");
    expect(attrs.data).toEqual({ snapshot: { total_cents: 4900 }, request_id: "req-1" });
    expect(attrs.do_not_forward).toBe(true);

    // Idempotency-Key is a HEADER, not a body attribute.
    expect(attrs.idempotency_key).toBeUndefined();
    expect(captured[0]!.headers["idempotency-key"]).toBe("k-1");
  });

  test("minimal call omits optional attributes", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, eventResponseBody());
    c.events.record({ action: "invoice.created", resourceType: "invoice", resourceId: "inv-1" });
    await c.events.flush(2_000);
    await c._close();

    const attrs = (captured[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(Object.keys(attrs).sort()).toEqual(["action", "resource_id", "resource_type"]);
  });

  test("doNotForward=false is omitted to match server default", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, eventResponseBody());
    c.events.record({
      action: "x",
      resourceType: "y",
      resourceId: "z",
      doNotForward: false,
    });
    await c.events.flush(2_000);
    await c._close();

    const attrs = (captured[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs.do_not_forward).toBeUndefined();
  });

  test("no top-level snapshot field appears on the wire", async () => {
    // Regression guard for the @smplkit/sdk@3.0.19 incident. Even when
    // the caller nests a snapshot inside `data`, the wrapper must NOT
    // lift it to a top-level `snapshot` attribute.
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, eventResponseBody());
    c.events.record({
      action: "invoice.created",
      resourceType: "invoice",
      resourceId: "inv-1",
      data: { snapshot: { total_cents: 4900 } },
    });
    await c.events.flush(2_000);
    await c._close();

    const attrs = (captured[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs.snapshot).toBeUndefined();
    // And it IS still nested in data.
    expect((attrs.data as Record<string, unknown>).snapshot).toEqual({ total_cents: 4900 });
  });

  test("no extra keys outside the documented POST schema", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, eventResponseBody());
    c.events.record({
      action: "invoice.created",
      resourceType: "invoice",
      resourceId: "inv-1",
      occurredAt: new Date("2026-05-06T12:00:00Z"),
      data: { k: "v" },
      idempotencyKey: "k-1",
      doNotForward: true,
    });
    await c.events.flush(2_000);
    await c._close();

    const attrs = (captured[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    const unexpected = Object.keys(attrs).filter((k) => !EVENT_POST_ATTRS.has(k));
    expect(unexpected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// forwarders.create
// ---------------------------------------------------------------------------

describe("AuditClient.forwarders.create — wire-body shape", () => {
  test("all parameters serialize to the documented shape", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, forwarderResponseBody());
    await c.forwarders.create({
      name: "Datadog production",
      forwarderType: "datadog",
      http: httpInput,
      enabled: false,
      filter: { "==": [{ var: "action" }, "user.created"] },
      transform: "$",
      data: { team: "platform" },
    });
    await c._close();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    const body = captured[0]!.body as {
      data: { id: string; type: string; attributes: Record<string, unknown> };
    };
    expect(Object.keys(body)).toEqual(["data"]);
    expect(body.data.type).toBe("forwarder");
    // Server assigns id on POST.
    expect(body.data.id).toBe("");

    const attrs = body.data.attributes;
    expect(attrs.name).toBe("Datadog production");
    expect(attrs.forwarder_type).toBe("datadog");
    expect(attrs.enabled).toBe(false);
    expect(attrs.filter).toEqual({ "==": [{ var: "action" }, "user.created"] });
    expect(attrs.transform).toBe("$");
    expect(attrs.data).toEqual({ team: "platform" });
    expect(attrs.http).toEqual({
      method: "POST",
      url: "https://siem.example.com/in",
      headers: [{ name: "DD-API-KEY", value: "real-secret" }],
      body: null,
      success_status: "2xx",
    });

    // Read-only / immutable fields MUST NOT appear on the wire.
    for (const ro of ["slug", "created_at", "updated_at", "deleted_at", "version"]) {
      expect(attrs[ro]).toBeUndefined();
    }
  });

  test("minimal call only carries required + default-true enabled", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, forwarderResponseBody());
    await c.forwarders.create({
      name: "x",
      forwarderType: "http",
      http: httpInput,
    });
    await c._close();

    const attrs = (captured[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs.name).toBe("x");
    expect(attrs.forwarder_type).toBe("http");
    expect(attrs.http).toBeDefined();
    expect(attrs.enabled).toBe(true);
    for (const opt of ["filter", "transform", "data"]) {
      expect(attrs[opt]).toBeUndefined();
    }
  });

  test("no extra keys outside the documented POST schema", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 201, forwarderResponseBody());
    await c.forwarders.create({
      name: "Datadog production",
      forwarderType: "datadog",
      http: httpInput,
      enabled: true,
      filter: { "==": [1, 1] },
      transform: "$",
      data: { k: "v" },
    });
    await c._close();

    const attrs = (captured[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    const unexpected = Object.keys(attrs).filter((k) => !FORWARDER_POST_ATTRS.has(k));
    expect(unexpected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// forwarders.update
// ---------------------------------------------------------------------------

describe("AuditClient.forwarders.update — wire-body shape", () => {
  test("all parameters serialize to the documented shape", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 200, forwarderResponseBody("Renamed"));
    await c.forwarders.update(FWD_ID, {
      name: "Renamed",
      forwarderType: "datadog",
      http: httpInput,
      enabled: false,
      filter: { "==": [1, 1] },
      transform: "$",
      data: { k: "v" },
    });
    await c._close();

    expect(captured[0]!.method).toBe("PUT");
    const body = captured[0]!.body as {
      data: { id: string; type: string; attributes: Record<string, unknown> };
    };
    expect(body.data.type).toBe("forwarder");
    // On PUT, the wrapper echoes the path id into the envelope id.
    expect(body.data.id).toBe(FWD_ID);

    const attrs = body.data.attributes;
    expect(attrs.name).toBe("Renamed");
    expect(attrs.forwarder_type).toBe("datadog");
    expect(attrs.enabled).toBe(false);
    expect(attrs.filter).toEqual({ "==": [1, 1] });
    expect(attrs.transform).toBe("$");
    expect(attrs.data).toEqual({ k: "v" });
    // Headers carry the real plaintext value the caller supplied — the
    // wrapper does NOT round-trip the redacted GET response.
    expect((attrs.http as { headers: unknown[] }).headers).toEqual([
      { name: "DD-API-KEY", value: "real-secret" },
    ]);

    for (const ro of ["slug", "created_at", "updated_at", "deleted_at", "version"]) {
      expect(attrs[ro]).toBeUndefined();
    }
  });

  test("no extra keys outside the documented POST schema", async () => {
    const captured: CapturedRequest[] = [];
    const c = newClientCapturing(captured, 200, forwarderResponseBody());
    await c.forwarders.update(FWD_ID, {
      name: "x",
      forwarderType: "http",
      http: httpInput,
      enabled: true,
      filter: { x: 1 },
      transform: "$",
      data: { k: "v" },
    });
    await c._close();

    const attrs = (captured[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    const unexpected = Object.keys(attrs).filter((k) => !FORWARDER_POST_ATTRS.has(k));
    expect(unexpected).toEqual([]);
  });
});
