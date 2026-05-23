/**
 * Tests for the management audit forwarder surface — `mgmt.audit.forwarders.*`
 * and the active-record {@link Forwarder} model.
 *
 * Uses SmplManagementClient with a stubbed global fetch. Coverage target
 * is 100% on the management/audit.ts wrapper layer.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SmplManagementClient } from "../../../src/management/client.js";
import { ManagementAuditClient, ForwardersClient } from "../../../src/management/audit.js";
import {
  Forwarder,
  ForwarderType,
  HttpConfiguration,
  HttpMethod,
  TransformType,
} from "../../../src/audit/types.js";
import { SmplNotFoundError, SmplError, SmplConnectionError } from "../../../src/errors.js";

const FWD_ID = "datadog-prod";

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

function _forwarderResource(
  attrs: Partial<Record<string, unknown>> = {},
  id: string = FWD_ID,
): { id: string; type: string; attributes: Record<string, unknown> } {
  return {
    id,
    type: "forwarder",
    attributes: {
      name: "Datadog production",
      description: null,
      forwarder_type: ForwarderType.DATADOG,
      enabled: true,
      filter: null,
      transform_type: null,
      transform: null,
      configuration: {
        method: HttpMethod.POST,
        url: "https://siem.example.com/in",
        headers: [{ name: "DD-API-KEY", value: "<redacted>" }],
        success_status: "2xx",
      },
      created_at: "2026-05-07T12:00:00+00:00",
      updated_at: "2026-05-07T12:00:00+00:00",
      deleted_at: null,
      version: 1,
      ...attrs,
    },
  };
}

function _newForwarder(
  overrides: Partial<{
    filter: Record<string, unknown>;
    transform: unknown;
    transformType: TransformType;
  }> = {},
  key: string = FWD_ID,
) {
  const mgmt = makeClient();
  return {
    mgmt,
    forwarder: mgmt.audit.forwarders.new(key, {
      name: "Datadog production",
      forwarderType: ForwarderType.DATADOG,
      configuration: new HttpConfiguration({
        method: HttpMethod.POST,
        url: "https://siem.example.com/in",
        headers: [{ name: "DD-API-KEY", value: "real-secret" }],
      }),
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

describe("audit enums", () => {
  test("ForwarderType is declared in alphabetical order", () => {
    // Each entry's source position lines up with iteration order on the
    // enum object — verify the literal source order matches sorted order.
    const keys = Object.keys(ForwarderType).filter((k) => isNaN(Number(k)));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      "DATADOG",
      "ELASTIC",
      "HONEYCOMB",
      "HTTP",
      "NEW_RELIC",
      "SPLUNK_HEC",
      "SUMO_LOGIC",
    ]);
  });

  test("HttpMethod is declared in alphabetical order", () => {
    const keys = Object.keys(HttpMethod).filter((k) => isNaN(Number(k)));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
  });

  test("TransformType exposes JSONATA only", () => {
    expect(Object.values(TransformType)).toEqual(["JSONATA"]);
  });
});

// ---------------------------------------------------------------------------
// Class shape
// ---------------------------------------------------------------------------

test("ManagementAuditClient exposes forwarders namespace", () => {
  const mgmt = makeClient();
  expect(mgmt.audit).toBeInstanceOf(ManagementAuditClient);
  expect(mgmt.audit.forwarders).toBeInstanceOf(ForwardersClient);
});

// ---------------------------------------------------------------------------
// new()
// ---------------------------------------------------------------------------

describe("mgmt.audit.forwarders.new", () => {
  test("returns an unsaved Forwarder bound to the client with caller-supplied id", () => {
    const { forwarder } = _newForwarder();
    expect(forwarder).toBeInstanceOf(Forwarder);
    // The caller-supplied key populates Forwarder.id immediately — the
    // POST envelope requires it. The server-assigned `createdAt` is still
    // null for an unsaved instance.
    expect(forwarder.id).toBe(FWD_ID);
    expect(forwarder.createdAt).toBeNull();
    // active-record link is set so .save() / .delete() round-trip back.
    expect(forwarder._client).not.toBeNull();
  });

  test("defaults enabled to true and description/filter/transform to null", () => {
    const { forwarder } = _newForwarder();
    expect(forwarder.enabled).toBe(true);
    expect(forwarder.description).toBeNull();
    expect(forwarder.filter).toBeNull();
    expect(forwarder.transform).toBeNull();
    expect(forwarder.transformType).toBeNull();
  });

  test("HttpConfiguration defaults method=POST and success_status=2xx", () => {
    const c = new HttpConfiguration({ url: "https://x.example/in" });
    expect(c.method).toBe(HttpMethod.POST);
    expect(c.successStatus).toBe("2xx");
    expect(c.headers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Forwarder.save() — create
// ---------------------------------------------------------------------------

describe("Forwarder.save() — create", () => {
  test("POSTs JSON:API and refreshes fields from the response", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const { forwarder } = _newForwarder({
      filter: { "==": [{ var: "event_type" }, "user.created"] },
      transformType: TransformType.JSONATA,
      transform: "$",
    });
    await forwarder.save();
    expect(forwarder.id).toBe(FWD_ID);
    expect(forwarder.createdAt).toBe("2026-05-07T12:00:00+00:00");

    // openapi-fetch may pass a Request object or (url, init)
    const firstArg = mockFetch.mock.calls[0]![0] as Request | string;
    const method = firstArg instanceof Request ? firstArg.method : "POST";
    expect(method).toBe("POST");
  });

  test("forwards transform_type and transform exactly as supplied", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const { forwarder } = _newForwarder({
      transformType: TransformType.JSONATA,
      transform: "{ event: event_type }",
    });
    await forwarder.save();
    const req = mockFetch.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.transform_type).toBe("JSONATA");
    expect(body.data.attributes.transform).toBe("{ event: event_type }");
  });

  test("save() throws when transformType is JSONATA but transform is not a string", async () => {
    const { forwarder } = _newForwarder({
      transformType: TransformType.JSONATA,
      transform: { kind: "future-engine", body: { nested: true } },
    });
    await expect(forwarder.save()).rejects.toThrow(/JSONATA/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("save() throws when transform is set without transformType", async () => {
    const { forwarder } = _newForwarder();
    forwarder.transform = "$";
    // transformType is null — save must reject before fetch.
    await expect(forwarder.save()).rejects.toThrow(/together|both/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("save() throws when transformType is set without transform", async () => {
    const { forwarder } = _newForwarder();
    forwarder.transformType = TransformType.JSONATA;
    // transform is null — save must reject before fetch.
    await expect(forwarder.save()).rejects.toThrow(/together|both/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("save() omits transform_type and transform when neither is set", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const { forwarder } = _newForwarder();
    await forwarder.save();
    const req = mockFetch.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text());
    expect(body.data.attributes).not.toHaveProperty("transform_type");
    expect(body.data.attributes).not.toHaveProperty("transform");
  });

  test("sends description when set", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const { forwarder } = _newForwarder();
    forwarder.description = "internal notes";
    await forwarder.save();
    const req = mockFetch.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.description).toBe("internal notes");
  });

  test("wire body uses `configuration`, not `http`", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const { forwarder } = _newForwarder();
    await forwarder.save();
    const req = mockFetch.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.configuration.url).toBe("https://siem.example.com/in");
    expect(body.data.attributes).not.toHaveProperty("http");
  });

  test("throws SmplError on non-2xx response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ errors: [{ status: "500", detail: "Server error." }] }), {
        status: 500,
        headers: { "Content-Type": "application/vnd.api+json" },
      }),
    );
    const { forwarder } = _newForwarder();
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps TypeError network errors in SmplConnectionError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    const { forwarder } = _newForwarder();
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("wraps non-TypeError errors in SmplConnectionError via fallback", async () => {
    mockFetch.mockRejectedValueOnce(new Error("generic error"));
    const { forwarder } = _newForwarder();
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("throws when the response body is empty", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 201));
    const { forwarder } = _newForwarder();
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplError);
  });

  test("throws when constructed without a client", async () => {
    const detached = new Forwarder(null, {
      name: "x",
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example" }),
    });
    await expect(detached.save()).rejects.toThrow(/no client|cannot save/i);
  });

  test("_createForwarder rejects a Forwarder with no id", async () => {
    // The caller-supplied key is required on create; the public
    // `forwarders.new(key, ...)` factory always sets it, but the
    // wrapper still guards the wire envelope so the error is local.
    const mgmt = makeClient();
    const detached = new Forwarder(mgmt.audit.forwarders, {
      name: "x",
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example" }),
    });
    // detached.id is null because no key was passed.
    await expect(mgmt.audit.forwarders._createForwarder(detached)).rejects.toThrow(/no id|key/i);
  });

  test("sends caller-supplied key as data.id on create", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }, 201));
    const { forwarder } = _newForwarder();
    await forwarder.save();
    const req = mockFetch.mock.calls[0]![0] as Request;
    const body = JSON.parse(await req.text());
    expect(body.data.id).toBe(FWD_ID);
    expect(body.data.type).toBe("forwarder");
  });
});

// ---------------------------------------------------------------------------
// Forwarder.save() — update
// ---------------------------------------------------------------------------

describe("Forwarder.save() — update", () => {
  test("PUTs full body when createdAt is set", async () => {
    const mgmt = makeClient();
    // First call: GET returns the existing forwarder so we have a
    // populated active-record bound to the client.
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }));
    // Second call: PUT returns the renamed forwarder.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ data: _forwarderResource({ name: "Renamed" }) }),
    );
    const fwd = await mgmt.audit.forwarders.get(FWD_ID);
    fwd.name = "Renamed";
    fwd.enabled = false;
    await fwd.save();

    const reqs = mockFetch.mock.calls.map((c) => c[0]) as Request[];
    expect(reqs[1]!.method).toBe("PUT");
    expect(fwd.name).toBe("Renamed");
  });

  test("propagates SmplError on update failure", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }));
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.get(FWD_ID);

    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
    await expect(fwd.save()).rejects.toBeInstanceOf(SmplError);
  });

  test("throws when response body is empty", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }));
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.get(FWD_ID);

    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(fwd.save()).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps TypeError network errors in SmplConnectionError", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }));
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.get(FWD_ID);

    mockFetch.mockRejectedValueOnce(new TypeError("network down"));
    await expect(fwd.save()).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("throws when the underlying model has no id", async () => {
    // _updateForwarder is exposed for the active-record path; it should
    // refuse without an id even though save() normally guarantees one.
    const { mgmt, forwarder } = _newForwarder();
    forwarder.id = null; // wipe the caller-supplied key
    forwarder.createdAt = "2026-05-07T12:00:00+00:00"; // pretend it was saved
    await expect(mgmt.audit.forwarders._updateForwarder(forwarder)).rejects.toThrow(/no id/i);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("mgmt.audit.forwarders.list", () => {
  test("returns forwarders and pagination", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          _forwarderResource(),
          _forwarderResource({}, "22222222-2222-2222-2222-222222222222"),
        ],
        meta: { pagination: { page: 1, size: 2 } },
      }),
    );
    const mgmt = makeClient();
    const page = await mgmt.audit.forwarders.list({
      forwarderType: ForwarderType.DATADOG,
      enabled: true,
      pageSize: 2,
    });
    expect(page.forwarders).toHaveLength(2);
    expect(page.forwarders[0]).toBeInstanceOf(Forwarder);
    expect(page.pagination).toEqual({ page: 1, size: 2 });
  });

  test("passes page[number], page[size], meta[total] and surfaces totals", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [_forwarderResource()],
        meta: { pagination: { page: 2, size: 1, total: 3, total_pages: 3 } },
      }),
    );
    const mgmt = makeClient();
    const page = await mgmt.audit.forwarders.list({
      pageNumber: 2,
      pageSize: 1,
      metaTotal: true,
    });
    const req = mockFetch.mock.calls[0]![0] as Request;
    expect(req.url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect(req.url).toMatch(/page(\[|%5B)size(\]|%5D)=1/);
    expect(req.url).toMatch(/meta(\[|%5B)total(\]|%5D)=true/);
    expect(page.pagination).toEqual({ page: 2, size: 1, total: 3, totalPages: 3 });
  });

  test("returns zeroed pagination when meta block missing", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [_forwarderResource()] }));
    const mgmt = makeClient();
    const page = await mgmt.audit.forwarders.list();
    expect(page.pagination).toEqual({ page: 0, size: 0 });
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
  test("fetches by id and returns a client-bound Forwarder", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }));
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.get(FWD_ID);
    expect(fwd).toBeInstanceOf(Forwarder);
    expect(fwd.id).toBe(FWD_ID);
    // Header values arrive redacted on reads.
    expect(fwd.configuration.headers[0]!.value).toBe("<redacted>");
    // round-trip-bound to this client.
    expect(fwd._client).not.toBeNull();
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

  test("throws when response body is empty", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    const mgmt = makeClient();
    await expect(mgmt.audit.forwarders.get(FWD_ID)).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps TypeError network errors in SmplConnectionError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("network down"));
    const mgmt = makeClient();
    await expect(mgmt.audit.forwarders.get(FWD_ID)).rejects.toBeInstanceOf(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("Forwarder.delete() and mgmt.audit.forwarders.delete()", () => {
  test("Forwarder.delete() soft-deletes the server-side record", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: _forwarderResource() }));
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.get(FWD_ID);

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await fwd.delete();
    const reqs = mockFetch.mock.calls.map((c) => c[0]) as Request[];
    expect(reqs[1]!.method).toBe("DELETE");
  });

  test("Forwarder.delete() throws when constructed without a client", async () => {
    const detached = new Forwarder(null, {
      name: "x",
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example" }),
      id: FWD_ID,
    });
    await expect(detached.delete()).rejects.toThrow(/no client|cannot delete/i);
  });

  test("Forwarder.delete() throws when id is null", async () => {
    const { forwarder } = _newForwarder();
    forwarder.id = null; // wipe the caller-supplied key
    await expect(forwarder.delete()).rejects.toThrow(/no client or id|cannot delete/i);
  });

  test("mgmt.audit.forwarders.delete(id) resolves on 204", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const mgmt = makeClient();
    await mgmt.audit.forwarders.delete(FWD_ID);
    const req = mockFetch.mock.calls[0]![0] as Request;
    expect(req.method).toBe("DELETE");
  });

  test("mgmt.audit.forwarders.delete throws SmplError on non-204 error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const mgmt = makeClient();
    await expect(mgmt.audit.forwarders.delete(FWD_ID)).rejects.toBeInstanceOf(SmplError);
  });

  test("mgmt.audit.forwarders.delete wraps TypeError in SmplConnectionError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("net"));
    const mgmt = makeClient();
    await expect(mgmt.audit.forwarders.delete(FWD_ID)).rejects.toBeInstanceOf(SmplConnectionError);
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
            forwarder_type: "http",
            enabled: false,
          },
        },
      }),
    );
    const mgmt = makeClient();
    const fwd = await mgmt.audit.forwarders.get(FWD_ID);
    expect(fwd.configuration.method).toBe(HttpMethod.POST);
    expect(fwd.configuration.headers).toEqual([]);
    expect(fwd.configuration.successStatus).toBe("2xx");
    expect(fwd.filter).toBeNull();
    expect(fwd.description).toBeNull();
    expect(fwd.transformType).toBeNull();
    expect(fwd.transform).toBeNull();
  });
});
