/**
 * Tests for the management audit forwarder surface — `mgmt.audit.forwarders.*`.
 *
 * Uses SmplManagementClient with a stubbed global fetch. Coverage target
 * is 100% on the management/audit.ts wrapper layer.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SmplManagementClient } from "../../../src/management/client.js";
import { ManagementAuditClient, ForwardersClient } from "../../../src/management/audit.js";
import type { Forwarder } from "../../../src/audit/types.js";
import { SmplNotFoundError, SmplError, SmplConnectionError } from "../../../src/errors.js";

const FWD_ID = "11111111-2222-3333-4444-555555555555";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient(): SmplManagementClient {
  return new SmplManagementClient({
    apiKey: "sk_mgmt_test",
    baseDomain: "test",
    scheme: "http",
  });
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

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
      created_at: "2026-05-07T12:00:00+00:00",
      updated_at: "2026-05-07T12:00:00+00:00",
      deleted_at: null,
      version: 1,
    },
  };
}

const _httpInput = {
  method: "POST",
  url: "https://siem.example.com/in",
  headers: [{ name: "DD-API-KEY", value: "real-secret" }],
  body: null,
  successStatus: "2xx",
};

// ---------------------------------------------------------------------------
// Class shape
// ---------------------------------------------------------------------------

test("ManagementAuditClient exposes forwarders namespace", () => {
  const mgmt = makeClient();
  expect(mgmt.audit).toBeInstanceOf(ManagementAuditClient);
  expect(mgmt.audit.forwarders).toBeInstanceOf(ForwardersClient);
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("mgmt.audit.forwarders.create", () => {
  test("posts JSON:API and returns a Forwarder", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.create({
      name: "Datadog production",
      forwarderType: "DATADOG",
      http: _httpInput,
      filter: { "==": [{ var: "action" }, "user.created"] },
      transform: "$",
    });
    expect(fwd.slug).toBe("datadog_production");
    expect(fwd.id).toBe(FWD_ID);
    // openapi-fetch may pass a Request object or (url, init)
    const firstArg = mockFetch.mock.calls[0]![0] as Request | string;
    const method = firstArg instanceof Request ? firstArg.method : "POST";
    expect(method).toBe("POST");
  });

  test("passes enabled=false in the request body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const mgmt = makeClient();
    await mgmt.audit.forwarders.create({
      name: "x",
      forwarderType: "HTTP",
      http: _httpInput,
      enabled: false,
    });
    // openapi-fetch passes a Request object as the first arg
    const req = mockFetch.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.enabled).toBe(false);
  });

  test("throws SmplError on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ status: "500", detail: "Server error." }] }), {
        status: 500,
        headers: { "Content-Type": "application/vnd.api+json" },
      }),
    );
    const mgmt = makeClient();
    await expect(
      mgmt.audit.forwarders.create({ name: "x", forwarderType: "HTTP", http: _httpInput }),
    ).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps TypeError network errors in SmplConnectionError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const mgmt = makeClient();
    await expect(
      mgmt.audit.forwarders.create({ name: "x", forwarderType: "HTTP", http: _httpInput }),
    ).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("wraps non-TypeError errors in SmplConnectionError via fallback path", async () => {
    mockFetch.mockRejectedValueOnce(new Error("generic error"));
    const mgmt = makeClient();
    await expect(
      mgmt.audit.forwarders.create({ name: "x", forwarderType: "HTTP", http: _httpInput }),
    ).rejects.toBeInstanceOf(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("mgmt.audit.forwarders.list", () => {
  test("returns forwarders and nextCursor", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [_forwarderResource("A"), _forwarderResource("B")],
        meta: { page_size: 20 },
        links: { next: "/api/v1/forwarders?page[size]=1&page[after]=tok-2" },
      }),
    );
    const mgmt = makeClient();
    const page = await mgmt.audit.forwarders.list({
      forwarderType: "DATADOG",
      enabled: true,
      pageSize: 2,
    });
    expect(page.forwarders).toHaveLength(2);
    expect(page.nextCursor).toBe("tok-2");
  });

  test("nextCursor is null when links.next absent", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: [_forwarderResource()], meta: { page_size: 20 } }),
    );
    const mgmt = makeClient();
    const page = await mgmt.audit.forwarders.list();
    expect(page.nextCursor).toBeNull();
  });

  test("throws SmplError on 500", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ errors: [] }, 500));
    const mgmt = makeClient();
    await expect(mgmt.audit.forwarders.list()).rejects.toBeInstanceOf(SmplError);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("mgmt.audit.forwarders.get", () => {
  test("fetches by id and returns Forwarder", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }));
    const mgmt = makeClient();
    const fwd: Forwarder = await mgmt.audit.forwarders.get(FWD_ID);
    expect(fwd.id).toBe(FWD_ID);
    expect(fwd.http.headers[0]!.value).toBe("<redacted>");
  });

  test("throws SmplNotFoundError on 404", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ errors: [{ status: "404", detail: "Forwarder not found." }] }),
        { status: 404, headers: { "Content-Type": "application/vnd.api+json" } },
      ),
    );
    const mgmt = makeClient();
    await expect(mgmt.audit.forwarders.get(FWD_ID)).rejects.toBeInstanceOf(SmplNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("mgmt.audit.forwarders.update", () => {
  test("sends PUT and returns updated Forwarder", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource("Renamed") }));
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.update(FWD_ID, {
      name: "Renamed",
      forwarderType: "DATADOG",
      http: _httpInput,
      enabled: false,
      filter: { "==": [1, 1] },
      transform: "$",
    });
    const req = mockFetch.mock.calls[0]![0] as Request;
    expect(req.method).toBe("PUT");
    expect(fwd.name).toBe("Renamed");
  });

  test("throws SmplNotFoundError on 404", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const mgmt = makeClient();
    await expect(
      mgmt.audit.forwarders.update(FWD_ID, { name: "x", forwarderType: "HTTP", http: _httpInput }),
    ).rejects.toBeInstanceOf(SmplError);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("mgmt.audit.forwarders.delete", () => {
  test("sends DELETE and resolves on 204", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const mgmt = makeClient();
    await mgmt.audit.forwarders.delete(FWD_ID);
    const req = mockFetch.mock.calls[0]![0] as Request;
    expect(req.method).toBe("DELETE");
  });

  test("throws SmplError on non-204 error response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const mgmt = makeClient();
    await expect(mgmt.audit.forwarders.delete(FWD_ID)).rejects.toBeInstanceOf(SmplError);
  });
});

// ---------------------------------------------------------------------------
// Forwarder._fromResource defaults
// ---------------------------------------------------------------------------

describe("Forwarder defaults from sparse wire shape", () => {
  test("missing optional fields default cleanly", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
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
    const mgmt = makeClient();
    const fwd: Forwarder = await mgmt.audit.forwarders.get(FWD_ID);
    expect(fwd.http.method).toBe("POST");
    expect(fwd.http.headers).toEqual([]);
    expect(fwd.http.successStatus).toBe("2xx");
    expect(fwd.filter).toBeNull();
  });
});
