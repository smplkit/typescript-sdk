/**
 * Tests for the fused {@link AuditClient}'s SIEM forwarder surface —
 * `client.forwarders.*` — plus the active-record {@link Forwarder}
 * model, its per-environment setters, the `HttpConfiguration` /
 * `ForwarderEnvironment` value objects, the `categories` discovery listing,
 * the public `close()` method, the request-timeout path, and the standalone
 * credential-resolution branch.
 *
 * Drives the one-client `AuditClient` (was `SmplManagementClient` +
 * `management/audit.ts` before the one-client refactor) with a per-instance
 * `fetch` override. Coverage target is 100% lines on src/audit/client.ts and
 * src/audit/types.ts.
 */

import { describe, expect, test, vi } from "vitest";
import { AuditClient } from "../../../src/audit/client.js";
import {
  Forwarder,
  ForwarderEnvironment,
  ForwarderType,
  HttpConfiguration,
  HttpMethod,
  TransformType,
} from "../../../src/audit/types.js";
import { SmplNotFoundError, SmplError, SmplConnectionError } from "../../../src/errors.js";

const FWD_ID = "datadog-prod";

/** A fetch override whose queued responses are returned FIFO. */
function queuedFetch(responses: Array<Response | (() => Response | Promise<Response>)>): {
  fetch: typeof fetch;
  requests: Request[];
} {
  const requests: Request[] = [];
  let i = 0;
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    requests.push(req);
    const next = responses[i++];
    if (next === undefined) throw new Error("queuedFetch: no response queued for this request");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, requests };
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function makeClient(responses: Array<Response | (() => Response | Promise<Response>)> = []): {
  client: AuditClient;
  requests: Request[];
} {
  const { fetch, requests } = queuedFetch(responses);
  const client = new AuditClient({
    apiKey: "sk_api_test",
    baseUrl: "https://audit.example.com",
    fetch,
  });
  return { client, requests };
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
      // Base `enabled` is server-pinned false; enablement is per-environment.
      enabled: false,
      environments: { production: { enabled: true } },
      forward_smplkit_events: false,
      filter: null,
      transform_type: null,
      transform: null,
      configuration: {
        method: HttpMethod.POST,
        url: "https://siem.example.com/in",
        headers: [{ name: "DD-API-KEY", value: "<redacted>" }],
        success_status: "2xx",
        tls_verify: true,
        ca_cert: null,
      },
      created_at: "2026-05-07T12:00:00+00:00",
      updated_at: "2026-05-07T12:00:00+00:00",
      deleted_at: null,
      version: 1,
      ...attrs,
    },
  };
}

/**
 * Build an unsaved, client-bound forwarder. Returns the client (so callers
 * can assert against `requests`) alongside the forwarder.
 */
function _newForwarder(
  overrides: Partial<{
    name: string;
    filter: Record<string, unknown>;
    transform: unknown;
    transformType: TransformType;
    forwardSmplkitEvents: boolean;
    description: string | null;
    environments: Record<
      string,
      ForwarderEnvironment | { enabled?: boolean; configuration?: HttpConfiguration | null }
    >;
  }> = {},
  responses: Array<Response | (() => Response | Promise<Response>)> = [],
  key: string = FWD_ID,
): { client: AuditClient; requests: Request[]; forwarder: Forwarder } {
  const { client, requests } = makeClient(responses);
  const forwarder = client.forwarders.new(key, {
    name: "Datadog production",
    forwarderType: ForwarderType.DATADOG,
    configuration: new HttpConfiguration({
      method: HttpMethod.POST,
      url: "https://siem.example.com/in",
      headers: [{ name: "DD-API-KEY", value: "real-secret" }],
    }),
    ...overrides,
  });
  return { client, requests, forwarder };
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

describe("audit enums", () => {
  test("ForwarderType is declared in alphabetical order", () => {
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
// HttpConfiguration value object
// ---------------------------------------------------------------------------

describe("HttpConfiguration", () => {
  test("defaults method=POST, success_status=2xx, headers=[], tls_verify=true, ca_cert=null", () => {
    const c = new HttpConfiguration({ url: "https://x.example/in" });
    expect(c.method).toBe(HttpMethod.POST);
    expect(c.successStatus).toBe("2xx");
    expect(c.headers).toEqual([]);
    expect(c.tlsVerify).toBe(true);
    expect(c.caCert).toBeNull();
    expect(c.url).toBe("https://x.example/in");
  });

  test("defaults url to empty string when omitted entirely", () => {
    const c = new HttpConfiguration();
    expect(c.url).toBe("");
  });

  test("retains explicitly supplied fields", () => {
    const c = new HttpConfiguration({
      method: HttpMethod.PUT,
      url: "https://x.example/in",
      headers: [{ name: "A", value: "b" }],
      successStatus: "204",
      tlsVerify: false,
      caCert: "-----BEGIN CERTIFICATE-----",
    });
    expect(c.method).toBe(HttpMethod.PUT);
    expect(c.successStatus).toBe("204");
    expect(c.tlsVerify).toBe(false);
    expect(c.caCert).toBe("-----BEGIN CERTIFICATE-----");
    expect(c.headers).toEqual([{ name: "A", value: "b" }]);
  });
});

// ---------------------------------------------------------------------------
// ForwarderEnvironment value object
// ---------------------------------------------------------------------------

describe("ForwarderEnvironment", () => {
  test("defaults: disabled, no config override", () => {
    const env = new ForwarderEnvironment();
    expect(env.enabled).toBe(false);
    expect(env.configuration).toBeNull();
  });

  test("retains explicitly supplied fields", () => {
    const cfg = new HttpConfiguration({ url: "https://x.example/in" });
    const env = new ForwarderEnvironment({ enabled: true, configuration: cfg });
    expect(env.enabled).toBe(true);
    expect(env.configuration).toBe(cfg);
  });
});

// ---------------------------------------------------------------------------
// Class shape
// ---------------------------------------------------------------------------

test("AuditClient exposes the discovery and forwarder namespaces directly", () => {
  const { client } = makeClient();
  expect(typeof client.forwarders.new).toBe("function");
  expect(typeof client.events.record).toBe("function");
  expect(typeof client.resourceTypes.list).toBe("function");
  expect(typeof client.eventTypes.list).toBe("function");
  expect(typeof client.categories.list).toBe("function");
});

// ---------------------------------------------------------------------------
// new()
// ---------------------------------------------------------------------------

describe("client.forwarders.new", () => {
  test("returns an unsaved Forwarder bound to the client with caller-supplied id", () => {
    const { forwarder } = _newForwarder();
    expect(forwarder).toBeInstanceOf(Forwarder);
    expect(forwarder.id).toBe(FWD_ID);
    expect(forwarder.createdAt).toBeNull();
    expect(forwarder._client).not.toBeNull();
  });

  test("defaults name to the key when not supplied", () => {
    const { client } = makeClient();
    const fwd = client.forwarders.new("only-key", {
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example/in" }),
    });
    expect(fwd.name).toBe("only-key");
  });

  test("defaults enabled false, environments empty, description/filter/transform null", () => {
    const { forwarder } = _newForwarder();
    expect(forwarder.enabled).toBe(false);
    expect(forwarder.environments).toEqual({});
    expect(forwarder.description).toBeNull();
    expect(forwarder.filter).toBeNull();
    expect(forwarder.transform).toBeNull();
    expect(forwarder.transformType).toBeNull();
    expect(forwarder.forwardSmplkitEvents).toBe(false);
  });

  test("forwardSmplkitEvents reflects the value passed to new()", () => {
    const { client } = makeClient();
    const fwd = client.forwarders.new(FWD_ID, {
      name: "Datadog production",
      forwarderType: ForwarderType.DATADOG,
      configuration: new HttpConfiguration({ url: "https://siem.example.com/in" }),
      forwardSmplkitEvents: true,
    });
    expect(fwd.forwardSmplkitEvents).toBe(true);
  });

  test("new() validates the transform pairing up front (transform without type)", () => {
    const { client } = makeClient();
    expect(() =>
      client.forwarders.new(FWD_ID, {
        forwarderType: ForwarderType.HTTP,
        configuration: new HttpConfiguration({ url: "https://x.example/in" }),
        transform: "$",
      }),
    ).toThrow(/together/i);
  });

  test("new() validates JSONATA transform must be a string", () => {
    const { client } = makeClient();
    expect(() =>
      client.forwarders.new(FWD_ID, {
        forwarderType: ForwarderType.HTTP,
        configuration: new HttpConfiguration({ url: "https://x.example/in" }),
        transformType: TransformType.JSONATA,
        transform: { not: "a string" },
      }),
    ).toThrow(/JSONATA/);
  });

  test("new() accepts a valid JSONATA transform pair", () => {
    const { client } = makeClient();
    const fwd = client.forwarders.new(FWD_ID, {
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example/in" }),
      transformType: TransformType.JSONATA,
      transform: "$",
    });
    expect(fwd.transform).toBe("$");
    expect(fwd.transformType).toBe(TransformType.JSONATA);
  });

  test("new() normalizes a ForwarderEnvironment instance and a plain object alike", () => {
    const { client } = makeClient();
    const fwd = client.forwarders.new(FWD_ID, {
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example/in" }),
      environments: {
        production: new ForwarderEnvironment({ enabled: true }),
        staging: { enabled: false },
        qa: {}, // empty plain object → defaults
      },
    });
    expect(fwd.environments.production).toBeInstanceOf(ForwarderEnvironment);
    expect(fwd.environments.production!.enabled).toBe(true);
    expect(fwd.environments.staging).toBeInstanceOf(ForwarderEnvironment);
    expect(fwd.environments.staging!.enabled).toBe(false);
    expect(fwd.environments.qa!.enabled).toBe(false);
    expect(fwd.environments.qa!.configuration).toBeNull();
  });

  test("new() treats a null environments map as empty", () => {
    const { client } = makeClient();
    const fwd = client.forwarders.new(FWD_ID, {
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example/in" }),
      environments: null,
    });
    expect(fwd.environments).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Forwarder.save() — create
// ---------------------------------------------------------------------------

describe("Forwarder.save() — create", () => {
  test("POSTs JSON:API and refreshes fields from the response", async () => {
    const { forwarder, requests } = _newForwarder(
      {
        filter: { "==": [{ var: "event_type" }, "user.created"] },
        transformType: TransformType.JSONATA,
        transform: "$",
      },
      [jsonResponse({ data: _forwarderResource() }, 201)],
    );
    await forwarder.save();
    expect(forwarder.id).toBe(FWD_ID);
    expect(forwarder.createdAt).toBe("2026-05-07T12:00:00+00:00");
    expect(requests[0]!.method).toBe("POST");
  });

  test("forwards transform_type and transform exactly as supplied", async () => {
    const { forwarder, requests } = _newForwarder(
      { transformType: TransformType.JSONATA, transform: "{ event: event_type }" },
      [jsonResponse({ data: _forwarderResource() }, 201)],
    );
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes.transform_type).toBe("JSONATA");
    expect(body.data.attributes.transform).toBe("{ event: event_type }");
  });

  test("sends the filter when set", async () => {
    const { forwarder, requests } = _newForwarder(
      { filter: { "==": [{ var: "event_type" }, "user.created"] } },
      [jsonResponse({ data: _forwarderResource() }, 201)],
    );
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes.filter).toEqual({ "==": [{ var: "event_type" }, "user.created"] });
  });

  test("save() throws when transformType is JSONATA but transform mutated to non-string", async () => {
    // Pass the wrapper's `new()` guard with a valid pair, then mutate the
    // instance so the save-time guard in `_forwarderAttrs` fires.
    const { forwarder, requests } = _newForwarder({
      transformType: TransformType.JSONATA,
      transform: "$",
    });
    forwarder.transform = { kind: "future-engine" };
    await expect(forwarder.save()).rejects.toThrow(/JSONATA/);
    expect(requests).toHaveLength(0);
  });

  test("save() throws when transform is set without transformType", async () => {
    const { forwarder, requests } = _newForwarder();
    forwarder.transform = "$"; // transformType still null
    await expect(forwarder.save()).rejects.toThrow(/together|both/i);
    expect(requests).toHaveLength(0);
  });

  test("save() throws when transformType is set without transform", async () => {
    const { forwarder, requests } = _newForwarder();
    forwarder.transformType = TransformType.JSONATA; // transform still null
    await expect(forwarder.save()).rejects.toThrow(/together|both/i);
    expect(requests).toHaveLength(0);
  });

  test("save() omits transform_type and transform when neither is set", async () => {
    const { forwarder, requests } = _newForwarder({}, [
      jsonResponse({ data: _forwarderResource() }, 201),
    ]);
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes).not.toHaveProperty("transform_type");
    expect(body.data.attributes).not.toHaveProperty("transform");
  });

  test("sends description when set", async () => {
    const { forwarder, requests } = _newForwarder({}, [
      jsonResponse({ data: _forwarderResource() }, 201),
    ]);
    forwarder.description = "internal notes";
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes.description).toBe("internal notes");
  });

  test("create sends forward_smplkit_events: false by default", async () => {
    const { forwarder, requests } = _newForwarder({}, [
      jsonResponse({ data: _forwarderResource() }, 201),
    ]);
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes.forward_smplkit_events).toBe(false);
  });

  test("create sends forward_smplkit_events: true when opted in and echoes it back", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: _forwarderResource({ forward_smplkit_events: true }) }, 201),
    ]);
    const forwarder = client.forwarders.new(FWD_ID, {
      name: "Datadog production",
      forwarderType: ForwarderType.DATADOG,
      configuration: new HttpConfiguration({ url: "https://siem.example.com/in" }),
      forwardSmplkitEvents: true,
    });
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes.forward_smplkit_events).toBe(true);
    expect(forwarder.forwardSmplkitEvents).toBe(true);
  });

  test("wire body carries the full configuration including tls_verify / ca_cert", async () => {
    const { forwarder, requests } = _newForwarder({}, [
      jsonResponse({ data: _forwarderResource() }, 201),
    ]);
    forwarder.configuration.tlsVerify = false;
    forwarder.configuration.caCert = "PEM";
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes.configuration.url).toBe("https://siem.example.com/in");
    expect(body.data.attributes.configuration.tls_verify).toBe(false);
    expect(body.data.attributes.configuration.ca_cert).toBe("PEM");
    expect(body.data.attributes.configuration.headers[0]).toEqual({
      name: "DD-API-KEY",
      value: "real-secret",
    });
    expect(body.data.attributes).not.toHaveProperty("http");
  });

  test("throws SmplError on non-2xx response", async () => {
    const { forwarder } = _newForwarder({}, [
      jsonResponse({ errors: [{ status: "500", detail: "Server error." }] }, 500),
    ]);
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps TypeError network errors in SmplConnectionError", async () => {
    const { forwarder } = _newForwarder({}, [
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("wraps non-TypeError errors in SmplConnectionError via fallback", async () => {
    const { forwarder } = _newForwarder({}, [
      () => {
        throw new Error("generic error");
      },
    ]);
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("wraps a non-Error throwable in SmplConnectionError via String() fallback", async () => {
    const { forwarder } = _newForwarder({}, [
      () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "string failure";
      },
    ]);
    await expect(forwarder.save()).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("throws when the response body is empty", async () => {
    const { forwarder } = _newForwarder({}, [jsonResponse({}, 201)]);
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
    const { client } = makeClient();
    const detached = new Forwarder(client.forwarders, {
      name: "x",
      forwarderType: ForwarderType.HTTP,
      configuration: new HttpConfiguration({ url: "https://x.example" }),
    });
    await expect(client.forwarders._createForwarder(detached)).rejects.toThrow(/no id|key/i);
  });

  test("sends caller-supplied key as data.id on create", async () => {
    const { forwarder, requests } = _newForwarder({}, [
      jsonResponse({ data: _forwarderResource() }, 201),
    ]);
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.id).toBe(FWD_ID);
    expect(body.data.type).toBe("forwarder");
  });
});

// ---------------------------------------------------------------------------
// Forwarder.save() — update
// ---------------------------------------------------------------------------

describe("Forwarder.save() — update", () => {
  test("PUTs full body when createdAt is set", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: _forwarderResource() }),
      jsonResponse({ data: _forwarderResource({ name: "Renamed" }) }),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    fwd.name = "Renamed";
    fwd.environments = { production: new ForwarderEnvironment({ enabled: false }) };
    await fwd.save();
    expect(requests[1]!.method).toBe("PUT");
    expect(fwd.name).toBe("Renamed");
  });

  test("update toggles forward_smplkit_events and refreshes from the response", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: _forwarderResource({ forward_smplkit_events: false }) }),
      jsonResponse({ data: _forwarderResource({ forward_smplkit_events: true }) }),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    expect(fwd.forwardSmplkitEvents).toBe(false);
    fwd.forwardSmplkitEvents = true;
    await fwd.save();
    expect(requests[1]!.method).toBe("PUT");
    const body = JSON.parse(await requests[1]!.text());
    expect(body.data.attributes.forward_smplkit_events).toBe(true);
    expect(fwd.forwardSmplkitEvents).toBe(true);
  });

  test("propagates SmplError on update failure", async () => {
    const { client } = makeClient([
      jsonResponse({ data: _forwarderResource() }),
      jsonResponse({}, 404),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    await expect(fwd.save()).rejects.toBeInstanceOf(SmplError);
  });

  test("throws when response body is empty on update", async () => {
    const { client } = makeClient([
      jsonResponse({ data: _forwarderResource() }),
      jsonResponse({}, 200),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    await expect(fwd.save()).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps TypeError network errors in SmplConnectionError on update", async () => {
    const { client } = makeClient([
      jsonResponse({ data: _forwarderResource() }),
      () => {
        throw new TypeError("network down");
      },
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    await expect(fwd.save()).rejects.toBeInstanceOf(SmplConnectionError);
  });

  test("_updateForwarder throws when the underlying model has no id", async () => {
    const { client, forwarder } = _newForwarder();
    forwarder.id = null; // wipe the caller-supplied key
    forwarder.createdAt = "2026-05-07T12:00:00+00:00"; // pretend it was saved
    await expect(client.forwarders._updateForwarder(forwarder)).rejects.toThrow(/no id/i);
  });
});

// ---------------------------------------------------------------------------
// Per-environment setters (the NEW behavior)
// ---------------------------------------------------------------------------

describe("Forwarder.setConfiguration / setEnabled", () => {
  test("setConfiguration with no environment replaces the base configuration", () => {
    const { forwarder } = _newForwarder();
    const next = new HttpConfiguration({ url: "https://new.example/in" });
    forwarder.setConfiguration(next);
    expect(forwarder.configuration).toBe(next);
    expect(forwarder.environments).toEqual({});
  });

  test("setEnabled with no environment sets the base enabled flag", () => {
    const { forwarder } = _newForwarder();
    forwarder.setEnabled(true);
    expect(forwarder.enabled).toBe(true);
    expect(forwarder.environments).toEqual({});
  });

  test("setConfiguration(env) creates the override entry when absent", () => {
    const { forwarder } = _newForwarder();
    const cfg = new HttpConfiguration({ url: "https://prod.example/in" });
    forwarder.setConfiguration(cfg, "production");
    expect(forwarder.environments.production).toBeInstanceOf(ForwarderEnvironment);
    expect(forwarder.environments.production!.configuration).toBe(cfg);
    // enabled defaults to false on the freshly-created override.
    expect(forwarder.environments.production!.enabled).toBe(false);
  });

  test("setEnabled(env) creates the override entry when absent", () => {
    const { forwarder } = _newForwarder();
    forwarder.setEnabled(true, "production");
    expect(forwarder.environments.production).toBeInstanceOf(ForwarderEnvironment);
    expect(forwarder.environments.production!.enabled).toBe(true);
    expect(forwarder.environments.production!.configuration).toBeNull();
  });

  test("per-env setters preserve the other field on an existing override", () => {
    const { forwarder } = _newForwarder();
    forwarder.setEnabled(true, "production");
    const cfg = new HttpConfiguration({ url: "https://prod.example/in" });
    forwarder.setConfiguration(cfg, "production");
    // enabled set earlier must survive the later setConfiguration.
    expect(forwarder.environments.production!.enabled).toBe(true);
    expect(forwarder.environments.production!.configuration).toBe(cfg);

    // And the reverse order: config first, then toggling enabled.
    forwarder.setEnabled(false, "production");
    expect(forwarder.environments.production!.configuration).toBe(cfg);
    expect(forwarder.environments.production!.enabled).toBe(false);
  });

  test("per-env setters round-trip through save()", async () => {
    const { client, requests } = makeClient([jsonResponse({ data: _forwarderResource() }, 201)]);
    const fwd = client.forwarders.new(FWD_ID, {
      name: "Datadog production",
      forwarderType: ForwarderType.DATADOG,
      configuration: new HttpConfiguration({ url: "https://siem.example.com/in" }),
    });
    fwd.setEnabled(true, "production");
    fwd.setConfiguration(
      new HttpConfiguration({
        url: "https://prod.example/in",
        headers: [{ name: "X-Env", value: "prod-secret" }],
      }),
      "production",
    );
    await fwd.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes.environments.production.enabled).toBe(true);
    expect(body.data.attributes.environments.production.configuration.url).toBe(
      "https://prod.example/in",
    );
    expect(body.data.attributes.environments.production.configuration.headers[0]).toEqual({
      name: "X-Env",
      value: "prod-secret",
    });
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("client.forwarders.list", () => {
  test("returns forwarders and pagination", async () => {
    const { client } = makeClient([
      jsonResponse({
        data: [
          _forwarderResource(),
          _forwarderResource({}, "22222222-2222-2222-2222-222222222222"),
        ],
        meta: { pagination: { page: 1, size: 2 } },
      }),
    ]);
    const page = await client.forwarders.list({
      forwarderType: ForwarderType.DATADOG,
      pageSize: 2,
    });
    expect(page.forwarders).toHaveLength(2);
    expect(page.forwarders[0]).toBeInstanceOf(Forwarder);
    expect(page.pagination).toEqual({ page: 1, size: 2 });
  });

  test("sends filter[forwarder_type] and never filter[enabled]", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: [_forwarderResource()], meta: { pagination: { page: 1, size: 1 } } }),
    ]);
    await client.forwarders.list({ forwarderType: ForwarderType.DATADOG });
    expect(requests[0]!.url).not.toMatch(/filter(\[|%5B)enabled/);
    expect(requests[0]!.url).toMatch(/filter(\[|%5B)forwarder_type(\]|%5D)=datadog/);
  });

  test("passes page[number], page[size], meta[total] and surfaces totals", async () => {
    const { client, requests } = makeClient([
      jsonResponse({
        data: [_forwarderResource()],
        meta: { pagination: { page: 2, size: 1, total: 3, total_pages: 3 } },
      }),
    ]);
    const page = await client.forwarders.list({
      pageNumber: 2,
      pageSize: 1,
      metaTotal: true,
    });
    expect(requests[0]!.url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect(requests[0]!.url).toMatch(/page(\[|%5B)size(\]|%5D)=1/);
    expect(requests[0]!.url).toMatch(/meta(\[|%5B)total(\]|%5D)=true/);
    expect(page.pagination).toEqual({ page: 2, size: 1, total: 3, totalPages: 3 });
  });

  test("returns zeroed pagination when meta block missing", async () => {
    const { client } = makeClient([jsonResponse({ data: [_forwarderResource()] })]);
    const page = await client.forwarders.list();
    expect(page.pagination).toEqual({ page: 0, size: 0 });
  });

  test("returns an empty page when the data array is absent", async () => {
    const { client } = makeClient([
      jsonResponse({ meta: { pagination: { page: 1, size: 1000 } } }),
    ]);
    const page = await client.forwarders.list();
    expect(page.forwarders).toEqual([]);
  });

  test("throws SmplError on 500", async () => {
    const { client } = makeClient([jsonResponse({ errors: [] }, 500)]);
    await expect(client.forwarders.list()).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps a TypeError from list in SmplConnectionError", async () => {
    const { client } = makeClient([
      () => {
        throw new TypeError("net");
      },
    ]);
    await expect(client.forwarders.list()).rejects.toBeInstanceOf(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe("client.forwarders.get", () => {
  test("fetches by id and returns a client-bound Forwarder", async () => {
    const { client } = makeClient([jsonResponse({ data: _forwarderResource() })]);
    const fwd = await client.forwarders.get(FWD_ID);
    expect(fwd).toBeInstanceOf(Forwarder);
    expect(fwd.id).toBe(FWD_ID);
    expect(fwd.configuration.headers[0]!.value).toBe("<redacted>");
    expect(fwd._client).not.toBeNull();
  });

  test("surfaces forward_smplkit_events from the read", async () => {
    const { client } = makeClient([
      jsonResponse({ data: _forwarderResource({ forward_smplkit_events: true }) }),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    expect(fwd.forwardSmplkitEvents).toBe(true);
  });

  test("throws SmplNotFoundError on 404", async () => {
    const { client } = makeClient([
      jsonResponse({ errors: [{ status: "404", detail: "Forwarder not found." }] }, 404),
    ]);
    await expect(client.forwarders.get(FWD_ID)).rejects.toBeInstanceOf(SmplNotFoundError);
  });

  test("throws when response body is empty", async () => {
    const { client } = makeClient([jsonResponse({}, 200)]);
    await expect(client.forwarders.get(FWD_ID)).rejects.toBeInstanceOf(SmplError);
  });

  test("wraps TypeError network errors in SmplConnectionError", async () => {
    const { client } = makeClient([
      () => {
        throw new TypeError("network down");
      },
    ]);
    await expect(client.forwarders.get(FWD_ID)).rejects.toBeInstanceOf(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("Forwarder.delete() and client.forwarders.delete()", () => {
  test("Forwarder.delete() soft-deletes the server-side record", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: _forwarderResource() }),
      new Response(null, { status: 204 }),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    await fwd.delete();
    expect(requests[1]!.method).toBe("DELETE");
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

  test("forwarders.delete(id) resolves on 204", async () => {
    const { client, requests } = makeClient([new Response(null, { status: 204 })]);
    await client.forwarders.delete(FWD_ID);
    expect(requests[0]!.method).toBe("DELETE");
  });

  test("forwarders.delete throws SmplError on non-204 error", async () => {
    const { client } = makeClient([jsonResponse({}, 404)]);
    await expect(client.forwarders.delete(FWD_ID)).rejects.toBeInstanceOf(SmplError);
  });

  test("forwarders.delete wraps TypeError in SmplConnectionError", async () => {
    const { client } = makeClient([
      () => {
        throw new TypeError("net");
      },
    ]);
    await expect(client.forwarders.delete(FWD_ID)).rejects.toBeInstanceOf(SmplConnectionError);
  });
});

// ---------------------------------------------------------------------------
// _forwarderFromResource defaults
// ---------------------------------------------------------------------------

describe("Forwarder defaults from sparse wire shape", () => {
  test("missing optional fields default cleanly", async () => {
    const { client } = makeClient([
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
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    expect(fwd.configuration.method).toBe(HttpMethod.POST);
    expect(fwd.configuration.headers).toEqual([]);
    expect(fwd.configuration.successStatus).toBe("2xx");
    // Absent tls_verify defaults to true (secure default); ca_cert to null.
    expect(fwd.configuration.tlsVerify).toBe(true);
    expect(fwd.configuration.caCert).toBeNull();
    expect(fwd.filter).toBeNull();
    expect(fwd.description).toBeNull();
    expect(fwd.transformType).toBeNull();
    expect(fwd.transform).toBeNull();
    expect(fwd.forwardSmplkitEvents).toBe(false);
    expect(fwd.environments).toEqual({});
    expect(fwd.createdAt).toBeNull();
    expect(fwd.updatedAt).toBeNull();
    expect(fwd.deletedAt).toBeNull();
    expect(fwd.version).toBeNull();
  });

  test("explicit tls_verify=false and ca_cert survive the read", async () => {
    const { client } = makeClient([
      jsonResponse({
        data: _forwarderResource({
          configuration: {
            method: HttpMethod.PUT,
            url: "https://x.example/in",
            headers: [{}], // header with neither name nor value → both default empty
            success_status: "204",
            tls_verify: false,
            ca_cert: "PEM",
          },
        }),
      }),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    expect(fwd.configuration.method).toBe(HttpMethod.PUT);
    expect(fwd.configuration.successStatus).toBe("204");
    expect(fwd.configuration.tlsVerify).toBe(false);
    expect(fwd.configuration.caCert).toBe("PEM");
    expect(fwd.configuration.headers[0]).toEqual({ name: "", value: "" });
  });
});

// ---------------------------------------------------------------------------
// Environment scoping (ADR-055): per-environment enablement + config override
// ---------------------------------------------------------------------------

describe("Forwarder environments (env scoping)", () => {
  test("base enabled is read-only/pinned false and never sent on create", async () => {
    const { forwarder, requests } = _newForwarder(
      { environments: { production: { enabled: true } } },
      [jsonResponse({ data: _forwarderResource() }, 201)],
    );
    expect(forwarder.enabled).toBe(false);
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes).not.toHaveProperty("enabled");
  });

  test("create sends environments map (enabled + optional configuration override)", async () => {
    const { forwarder, requests } = _newForwarder(
      {
        environments: {
          production: {
            enabled: true,
            configuration: new HttpConfiguration({
              url: "https://prod.example/in",
              headers: [{ name: "X-Env", value: "prod-secret" }],
            }),
          },
          staging: new ForwarderEnvironment({ enabled: false }),
        },
      },
      [jsonResponse({ data: _forwarderResource() }, 201)],
    );
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    const envs = body.data.attributes.environments;
    expect(envs.production.enabled).toBe(true);
    expect(envs.production.configuration.url).toBe("https://prod.example/in");
    expect(envs.production.configuration.headers[0]).toEqual({
      name: "X-Env",
      value: "prod-secret",
    });
    expect(envs.staging.enabled).toBe(false);
    // No override on staging → null configuration (inherits the base).
    expect(envs.staging.configuration).toBeNull();
  });

  test("omits environments from the wire body when the map is empty", async () => {
    const { forwarder, requests } = _newForwarder({}, [
      jsonResponse({ data: _forwarderResource() }, 201),
    ]);
    await forwarder.save();
    const body = JSON.parse(await requests[0]!.text());
    expect(body.data.attributes).not.toHaveProperty("environments");
  });

  test("parses the environments map from a read, including config overrides", async () => {
    const { client } = makeClient([
      jsonResponse({
        data: _forwarderResource({
          environments: {
            production: {
              enabled: true,
              configuration: {
                method: HttpMethod.POST,
                url: "https://prod.example/in",
                headers: [{ name: "X-Env", value: "<redacted>" }],
                success_status: "2xx",
              },
            },
            staging: { enabled: false },
            // Null value coerces to a disabled, override-less environment.
            qa: null,
          },
        }),
      }),
    ]);
    const fwd = await client.forwarders.get(FWD_ID);
    expect(fwd.environments.production).toBeInstanceOf(ForwarderEnvironment);
    expect(fwd.environments.production!.enabled).toBe(true);
    expect(fwd.environments.production!.configuration).toBeInstanceOf(HttpConfiguration);
    expect(fwd.environments.production!.configuration!.url).toBe("https://prod.example/in");
    expect(fwd.environments.production!.configuration!.headers[0]!.value).toBe("<redacted>");
    expect(fwd.environments.staging!.enabled).toBe(false);
    expect(fwd.environments.staging!.configuration).toBeNull();
    expect(fwd.environments.qa!.enabled).toBe(false);
    expect(fwd.environments.qa!.configuration).toBeNull();
  });

  test("environments round-trip through save() — _apply copies the map", async () => {
    const { forwarder } = _newForwarder({ environments: { production: { enabled: true } } }, [
      jsonResponse(
        { data: _forwarderResource({ environments: { production: { enabled: true } } }) },
        201,
      ),
    ]);
    await forwarder.save();
    expect(forwarder.environments.production).toBeInstanceOf(ForwarderEnvironment);
    expect(forwarder.environments.production!.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// categories discovery listing
// ---------------------------------------------------------------------------

describe("client.categories", () => {
  test("list returns category slugs and pagination", async () => {
    const { client } = makeClient([
      jsonResponse({
        data: [
          {
            id: "billing",
            type: "category",
            attributes: { category: "billing", created_at: "2026-01-01T00:00:00Z" },
          },
          {
            id: "auth",
            type: "category",
            attributes: { category: "auth", created_at: "2026-01-02T00:00:00Z" },
          },
        ],
        meta: { pagination: { page: 1, size: 1000 } },
      }),
    ]);
    const page = await client.categories.list();
    expect(page.categories).toHaveLength(2);
    expect(page.categories[0]!.id).toBe("billing");
    expect(page.categories[0]!.category).toBe("billing");
    expect(page.categories[1]!.createdAt).toBe("2026-01-02T00:00:00Z");
    expect(page.pagination).toEqual({ page: 1, size: 1000 });
  });

  test("list falls back to the id when category/created_at are absent", async () => {
    const { client } = makeClient([
      jsonResponse({ data: [{ id: "fallback", type: "category", attributes: {} }] }),
    ]);
    const page = await client.categories.list();
    expect(page.categories[0]!.category).toBe("fallback");
    expect(page.categories[0]!.createdAt).toBe("");
  });

  test("list passes page[number], page[size], meta[total] and reads totals", async () => {
    const { client, requests } = makeClient([
      jsonResponse({
        data: [
          {
            id: "billing",
            type: "category",
            attributes: { category: "billing", created_at: "2026-01-01T00:00:00Z" },
          },
        ],
        meta: { pagination: { page: 2, size: 1, total: 3, total_pages: 3 } },
      }),
    ]);
    const page = await client.categories.list({ pageNumber: 2, pageSize: 1, metaTotal: true });
    expect(requests[0]!.url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
    expect(requests[0]!.url).toMatch(/page(\[|%5B)size(\]|%5D)=1/);
    expect(requests[0]!.url).toMatch(/meta(\[|%5B)total(\]|%5D)=true/);
    expect(page.pagination).toEqual({ page: 2, size: 1, total: 3, totalPages: 3 });
  });

  test("list scopes by environments via filter[environment]", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: [], meta: { pagination: { page: 1, size: 1000 } } }),
    ]);
    await client.categories.list({ environments: ["production", "smplkit"] });
    expect(requests[0]!.url).toMatch(/filter(\[|%5B)environment(\]|%5D)=production(,|%2C)smplkit/);
  });

  test("list omits filter[environment] when environments is empty", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: [], meta: { pagination: { page: 1, size: 1000 } } }),
    ]);
    await client.categories.list({ environments: [] });
    expect(requests[0]!.url).not.toMatch(/filter(\[|%5B)environment/);
  });

  test("list throws SmplError on 500", async () => {
    const { client } = makeClient([new Response("server error", { status: 500 })]);
    await expect(client.categories.list()).rejects.toBeInstanceOf(SmplError);
  });
});

// ---------------------------------------------------------------------------
// resourceTypes / eventTypes filter[resource_type] (the filterResourceType
// branch is only reachable on eventTypes)
// ---------------------------------------------------------------------------

describe("client.eventTypes filterResourceType", () => {
  test("passes filter[resource_type] when filterResourceType given", async () => {
    const { client, requests } = makeClient([
      jsonResponse({ data: [], meta: { pagination: { page: 1, size: 1000 } } }),
    ]);
    await client.eventTypes.list({ filterResourceType: "invoice" });
    expect(requests[0]!.url).toMatch(/filter(\[|%5B)resource_type(\]|%5D)=invoice/);
  });
});

// ---------------------------------------------------------------------------
// Public close() + standalone credential resolution + timeout path
// ---------------------------------------------------------------------------

describe("AuditClient lifecycle and construction", () => {
  test("public close() drains the buffer (delegates to _close)", async () => {
    const { client } = makeClient([jsonResponse({}, 201)]);
    await client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
    // Public close() must resolve and leave the buffer safe (idempotent).
    await expect(client.close()).resolves.toBeUndefined();
    await client.close();
  });

  test("record({ flush: true }) awaits buffer drain before returning", async () => {
    const { client, requests } = makeClient([jsonResponse({}, 201)]);
    await client.events.record({
      eventType: "user.created",
      resourceType: "user",
      resourceId: "u-1",
      // flush: true drives the synchronous-drain branch; flushTimeoutMs is
      // forwarded to the buffer's flush().
      flush: true,
      flushTimeoutMs: 2_000,
    });
    // The POST must have happened by the time record() resolves.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    await client.close();
  });

  test("resolves baseUrl from baseDomain/scheme when baseUrl is omitted", async () => {
    // Omitting baseUrl drives the standalone branch through
    // resolveManagementConfig + serviceUrl. apiKey is supplied so the
    // resolver doesn't depend on ~/.smplkit, and baseDomain/scheme make the
    // computed URL deterministic.
    const requests: Request[] = [];
    const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as string, init);
      requests.push(req);
      return jsonResponse({ data: [], meta: { pagination: { page: 1, size: 1000 } } });
    }) as unknown as typeof fetch;
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseDomain: "test.example",
      scheme: "http",
      fetch: fetchFn,
    });
    await client.forwarders.list();
    expect(requests[0]!.url).toMatch(/^http:\/\/audit\.test\.example\//);
    await client.close();
  });

  test("a slow request beyond timeoutMs surfaces a timeout error", async () => {
    // The client's internal fetch wraps the request in an AbortController
    // armed at `timeoutMs`. A fetch that honors the abort signal triggers
    // the SmplkitTimeoutError mapping; reads surface it as a connection
    // error after wrapFetchError.
    const slowFetch = vi.fn((input: unknown, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as string, init);
      const signal = req.signal;
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = (): void => {
          const err = new DOMException("aborted", "AbortError");
          reject(err);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }) as unknown as typeof fetch;
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      timeoutMs: 10,
      fetch: slowFetch,
    });
    // forwarders.get() runs its fetch error through wrapFetchError, which
    // re-throws the SmplError subclass unchanged.
    await expect(client.forwarders.get(FWD_ID)).rejects.toThrow(/timed out/i);
    await client.close();
  });
});
