/**
 * Tests for the stateless (edge/serverless) audit surface:
 *
 * - `buffered: false` — record() performs one awaited POST per call (no
 *   background buffer, no timers), throws typed errors on failure, and
 *   flush()/close() are no-ops.
 * - The `category` list filter (the indexed correlation label).
 * - Credential resolution without the injected config resolver (the
 *   `@smplkit/sdk/audit` entry): defaults → `SMPLKIT_*` environment
 *   variables → constructor options — the SmplClient algorithm minus the
 *   `~/.smplkit` file step.
 * - The injected-resolver branch the package root wires up.
 *
 * NOTE ON ORDER: `_setAuditConfigResolver` mutates module state for the rest
 * of this file, so every unresolved-credentials case runs before the final
 * injection test. Env vars are stubbed per test and restored afterward.
 */

import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { AuditClient, _setAuditConfigResolver } from "../../../src/audit/client.js";
import { SmplError, SmplNotFoundError } from "../../../src/errors.js";

// The dev machine (or CI) may carry real SMPLKIT_* values; every test in this
// file must see a clean slate so resolution outcomes are deterministic.
const SMPLKIT_VARS = [
  "SMPLKIT_API_KEY",
  "SMPLKIT_BASE_DOMAIN",
  "SMPLKIT_SCHEME",
  "SMPLKIT_ENVIRONMENT",
] as const;
const SAVED = SMPLKIT_VARS.map((k) => [k, process.env[k]] as const);
for (const k of SMPLKIT_VARS) delete process.env[k];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of SMPLKIT_VARS) delete process.env[k];
});
afterAll(() => {
  for (const [k, v] of SAVED) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/vnd.api+json" },
  });
}

function captureFetch(respond: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init);
    requests.push(req);
    return respond(req);
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

describe("stateless mode (buffered: false)", () => {
  test("record() performs one awaited POST with the event body and idempotency header", async () => {
    const { requests, fetchFn } = captureFetch(() => jsonResponse({}, 201));
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      buffered: false,
      fetch: fetchFn,
    });

    await client.events.record({
      eventType: "benchmark.published",
      resourceType: "benchmark",
      resourceId: "bm-1",
      idempotencyKey: "idem-1",
    });

    // Durable on return: the POST happened before record() resolved — no
    // buffer to drain, nothing pending.
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://audit.example.com/api/v1/events");
    expect(requests[0]!.headers.get("Idempotency-Key")).toBe("idem-1");
    const body = (await requests[0]!.json()) as {
      data: { type: string; attributes: Record<string, unknown> };
    };
    expect(body.data.attributes.event_type).toBe("benchmark.published");
    expect(body.data.attributes.resource_type).toBe("benchmark");
    expect(body.data.attributes.resource_id).toBe("bm-1");
  });

  test("record() throws typed errors on failure instead of buffering a retry", async () => {
    const { fetchFn } = captureFetch(() => jsonResponse({ errors: [] }, 500));
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      buffered: false,
      fetch: fetchFn,
    });
    await expect(
      client.events.record({ eventType: "e.t", resourceType: "r", resourceId: "1" }),
    ).rejects.toBeInstanceOf(SmplError);

    const notFound = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      buffered: false,
      fetch: captureFetch(() => jsonResponse({ errors: [] }, 404)).fetchFn,
    });
    await expect(
      notFound.events.record({ eventType: "e.t", resourceType: "r", resourceId: "1" }),
    ).rejects.toBeInstanceOf(SmplNotFoundError);
  });

  test("flush() and close() are no-ops — nothing pends, nothing leaks", async () => {
    const { requests, fetchFn } = captureFetch(() => jsonResponse({}, 201));
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      buffered: false,
      fetch: fetchFn,
    });
    await client.events.record({ eventType: "e.t", resourceType: "r", resourceId: "1" });
    await client.events.flush();
    await client.close();
    expect(requests).toHaveLength(1); // just the record's own POST
  });
});

describe("list category filter", () => {
  test("category travels as the indexed filter[category] param", async () => {
    const { requests, fetchFn } = captureFetch(() =>
      jsonResponse({ data: [], links: { next: null } }),
    );
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      buffered: false,
      fetch: fetchFn,
    });
    await client.events.list({ category: "benchmark:bm-1", pageSize: 200 });
    const url = new URL(requests[0]!.url);
    expect(url.searchParams.get("filter[category]")).toBe("benchmark:bm-1");
    expect(url.searchParams.get("page[size]")).toBe("200");
  });
});

describe("edge-entry config resolution (defaults → SMPLKIT_* env vars → options)", () => {
  test("without the resolver, env vars, or an apiKey option, the error is clear", () => {
    expect(() => new AuditClient({})).toThrowError(/No API key provided.*SMPLKIT_API_KEY/s);
  });

  test("an explicit apiKey composes the default base URL from scheme/baseDomain defaults", async () => {
    const { requests, fetchFn } = captureFetch(() =>
      jsonResponse({ data: [], links: { next: null } }),
    );
    const client = new AuditClient({ apiKey: "sk_api_test", buffered: false, fetch: fetchFn });
    await client.events.list();
    expect(requests[0]!.url).toMatch(/^https:\/\/audit\.smplkit\.com\//);
  });

  test("apiKey, base URL parts, and environment all resolve from SMPLKIT_* env vars", async () => {
    vi.stubEnv("SMPLKIT_API_KEY", "sk_api_from_env");
    vi.stubEnv("SMPLKIT_SCHEME", "http");
    vi.stubEnv("SMPLKIT_BASE_DOMAIN", "env.example");
    vi.stubEnv("SMPLKIT_ENVIRONMENT", "staging");
    const { requests, fetchFn } = captureFetch(() => jsonResponse({}, 201));
    const client = new AuditClient({ buffered: false, fetch: fetchFn });
    await client.events.record({ eventType: "e.t", resourceType: "r", resourceId: "1" });
    expect(requests[0]!.url).toBe("http://audit.env.example/api/v1/events");
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer sk_api_from_env");
    const body = (await requests[0]!.json()) as { data: { attributes: Record<string, unknown> } };
    // The resolved environment is stamped on the event body, like SmplClient.
    expect(body.data.attributes.environment).toBe("staging");
  });

  test("constructor options beat env vars, and an empty env var counts as unset", async () => {
    vi.stubEnv("SMPLKIT_API_KEY", "sk_api_from_env");
    vi.stubEnv("SMPLKIT_ENVIRONMENT", "");
    const { requests, fetchFn } = captureFetch(() => jsonResponse({}, 201));
    const client = new AuditClient({
      apiKey: "sk_api_explicit",
      baseUrl: "https://audit.example.com",
      buffered: false,
      fetch: fetchFn,
    });
    await client.events.record({ eventType: "e.t", resourceType: "r", resourceId: "1" });
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer sk_api_explicit");
    const body = (await requests[0]!.json()) as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes).not.toHaveProperty("environment");
  });

  // LAST in the file: mutates module-level resolver state.
  test("the package-root entry's injected resolver fills in credentials and environment", async () => {
    _setAuditConfigResolver(() => ({
      apiKey: "sk_api_resolved",
      scheme: "http",
      baseDomain: "resolved.example",
      environment: "prod-from-file",
    }));
    const { requests, fetchFn } = captureFetch(() => jsonResponse({}, 201));
    const client = new AuditClient({ buffered: false, fetch: fetchFn });
    await client.events.record({ eventType: "e.t", resourceType: "r", resourceId: "1" });
    expect(requests[0]!.url).toMatch(/^http:\/\/audit\.resolved\.example\//);
    expect(requests[0]!.headers.get("Authorization")).toBe("Bearer sk_api_resolved");
    const body = (await requests[0]!.json()) as { data: { attributes: Record<string, unknown> } };
    expect(body.data.attributes.environment).toBe("prod-from-file");
  });
});
