/**
 * The default `smplkit-sdk-ts/<version>` User-Agent.
 *
 * Some edges in front of the platform (CloudFront's managed WAF rules)
 * reject requests that carry no User-Agent header, and edge runtimes such
 * as Cloudflare Workers send none by default. Every outbound request from
 * every subsystem client — and the WebSocket handshake — must therefore
 * carry the SDK default, unless the caller supplied a User-Agent of their
 * own (any casing), which always wins.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_USER_AGENT, SDK_VERSION, withDefaultUserAgent } from "../../src/user_agent.js";
import { SmplClient } from "../../src/client.js";
import { SharedWebSocket } from "../../src/ws.js";
import { ConfigClient } from "../../src/config/client.js";
import { FlagsClient } from "../../src/flags/client.js";
import { LoggingClient } from "../../src/logging/client.js";
import { JobsClient } from "../../src/jobs/client.js";
import { PlatformClient } from "../../src/platform/client.js";
import { AccountClient } from "../../src/account/client.js";
import { AuditClient } from "../../src/audit/client.js";
import { MetricsReporter } from "../../src/_metrics.js";

// Mock the ws module, recording handshake constructor arguments.
const wsCalls = vi.hoisted(
  () => [] as Array<{ url: string; options?: { headers?: Record<string, string> } }>,
);
vi.mock("ws", () => {
  class MockWebSocket {
    on = vi.fn();
    send = vi.fn();
    close = vi.fn();
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      wsCalls.push({ url, options });
    }
  }
  return { default: MockWebSocket };
});

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
  version: string;
};

const mockFetch = vi.fn();

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  wsCalls.length = 0;
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockImplementation(async () => jsonResponse({ data: [] }));
});

afterEach(() => {
  vi.restoreAllMocks();
  mockFetch.mockReset();
});

// ---------------------------------------------------------------------------
// SDK identity
// ---------------------------------------------------------------------------

describe("SDK identity", () => {
  it("SDK_VERSION matches package.json's version", () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("SDK_USER_AGENT is exactly smplkit-sdk-ts/<package.json version>", () => {
    expect(SDK_USER_AGENT).toBe(`smplkit-sdk-ts/${pkg.version}`);
    expect(SDK_USER_AGENT).toMatch(/^smplkit-sdk-ts\/\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// withDefaultUserAgent
// ---------------------------------------------------------------------------

describe("withDefaultUserAgent", () => {
  it("adds the default User-Agent when the caller set none, preserving other keys", () => {
    const input = { Authorization: "Bearer k" };
    const out = withDefaultUserAgent(input);
    expect(out).toEqual({ Authorization: "Bearer k", "User-Agent": SDK_USER_AGENT });
    // The input is not mutated.
    expect(input).toEqual({ Authorization: "Bearer k" });
  });

  it("leaves a caller-supplied User-Agent (exact casing) untouched", () => {
    const input = { "User-Agent": "acme-app/1.2" };
    expect(withDefaultUserAgent(input)).toBe(input);
  });

  it("a lowercase user-agent also wins — the check is case-insensitive", () => {
    const out = withDefaultUserAgent({ "user-agent": "acme-app/1.2" });
    expect(out).toEqual({ "user-agent": "acme-app/1.2" });
    expect("User-Agent" in out).toBe(false);
  });

  it("any exotic casing wins too", () => {
    const out = withDefaultUserAgent({ "uSeR-aGeNt": "acme-app/1.2" });
    expect(out).toEqual({ "uSeR-aGeNt": "acme-app/1.2" });
  });
});

// ---------------------------------------------------------------------------
// The default travels on every subsystem's requests
// ---------------------------------------------------------------------------

describe("default User-Agent on outbound requests", () => {
  it("SmplClient shared transports send it (flags + JSON:API jobs)", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });

    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "test-svc",
      telemetry: false,
    });
    try {
      await client.flags._ensureConnected();
      await client.jobs.list();
      const flagReq = seen.find((r) => r.url.includes("flags"));
      const jobsReq = seen.find((r) => r.url.includes("jobs"));
      expect(flagReq).toBeDefined();
      expect(jobsReq).toBeDefined();
      expect(flagReq!.headers.get("user-agent")).toBe(SDK_USER_AGENT);
      expect(jobsReq!.headers.get("user-agent")).toBe(SDK_USER_AGENT);
    } finally {
      client.close();
    }
  });

  it("standalone ConfigClient sends it", async () => {
    const client = new ConfigClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://config.example.com",
    });
    await client.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.headers.get("user-agent")).toBe(SDK_USER_AGENT);
  });

  it("standalone FlagsClient sends it", async () => {
    const client = new FlagsClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://flags.example.com",
    });
    await client.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.headers.get("user-agent")).toBe(SDK_USER_AGENT);
  });

  it("standalone LoggingClient sends it", async () => {
    const client = new LoggingClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://logging.example.com",
    });
    await client.loggers.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.headers.get("user-agent")).toBe(SDK_USER_AGENT);
  });

  it("standalone JobsClient sends it", async () => {
    const client = new JobsClient({ apiKey: "sk_test", baseUrl: "http://jobs.test" });
    await client.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.headers.get("user-agent")).toBe(SDK_USER_AGENT);
  });

  it("standalone PlatformClient sends it", async () => {
    const client = new PlatformClient({ apiKey: "sk_test", baseDomain: "test", scheme: "http" });
    await client.environments.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.headers.get("user-agent")).toBe(SDK_USER_AGENT);
  });

  it("AccountClient settings requests send it", async () => {
    const client = new AccountClient({ apiKey: "sk_test", baseUrl: "http://app.test" });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.settings.get();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe(SDK_USER_AGENT);
  });

  it("AuditClient (stateless) sends it", async () => {
    const seen: Headers[] = [];
    const fetchMock = vi.fn(async (req: Request) => {
      seen.push(req.headers);
      return new Response(JSON.stringify(auditEventResource()), {
        status: 201,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    });
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
      buffered: false,
    });
    await client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
    expect(seen[0]!.get("user-agent")).toBe(SDK_USER_AGENT);
  });

  it("MetricsReporter flushes send it", () => {
    const reporter = new MetricsReporter({
      apiKey: "sk_test",
      environment: "test",
      service: "svc",
    });
    reporter.record("sdk.test.metric");
    reporter.flush();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["User-Agent"]).toBe(SDK_USER_AGENT);
    reporter.close();
  });

  it("the WebSocket handshake sends it", () => {
    const ws = new SharedWebSocket("https://app.test", "sk_key", null);
    ws.start();
    expect(wsCalls).toHaveLength(1);
    expect(wsCalls[0].options?.headers?.["User-Agent"]).toBe(SDK_USER_AGENT);
    ws.stop();
  });
});

// ---------------------------------------------------------------------------
// A caller-supplied User-Agent wins — any surface, any casing
// ---------------------------------------------------------------------------

describe("caller-supplied User-Agent wins", () => {
  it("SmplClient extraHeaders User-Agent replaces the default on sub-client calls", async () => {
    const seen: Request[] = [];
    mockFetch.mockImplementation(async (req: Request) => {
      seen.push(req);
      return jsonResponse({ data: [] });
    });

    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "test-svc",
      telemetry: false,
      extraHeaders: { "User-Agent": "acme-app/1.2" },
    });
    try {
      await client.flags._ensureConnected();
      await client.jobs.list();
      const flagReq = seen.find((r) => r.url.includes("flags"));
      const jobsReq = seen.find((r) => r.url.includes("jobs"));
      expect(flagReq!.headers.get("user-agent")).toBe("acme-app/1.2");
      expect(jobsReq!.headers.get("user-agent")).toBe("acme-app/1.2");
    } finally {
      client.close();
    }
  });

  it("a lowercase user-agent in ConfigClient extraHeaders wins (case-insensitive)", async () => {
    const client = new ConfigClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://config.example.com",
      extraHeaders: { "user-agent": "lower-ua/2.0" },
    });
    await client.list();
    const req: Request = mockFetch.mock.calls[0][0];
    // Exactly the caller's value — never joined with the SDK default.
    expect(req.headers.get("user-agent")).toBe("lower-ua/2.0");
  });

  it("an exotically-cased User-Agent in AuditClient extraHeaders wins", async () => {
    const seen: Headers[] = [];
    const fetchMock = vi.fn(async (req: Request) => {
      seen.push(req.headers);
      return new Response(JSON.stringify(auditEventResource()), {
        status: 201,
        headers: { "Content-Type": "application/vnd.api+json" },
      });
    });
    const client = new AuditClient({
      apiKey: "sk_api_test",
      baseUrl: "https://audit.example.com",
      fetch: fetchMock,
      buffered: false,
      extraHeaders: { "uSeR-aGeNt": "odd-ua/3.0" },
    });
    await client.events.record({ eventType: "x", resourceType: "y", resourceId: "1" });
    expect(seen[0]!.get("user-agent")).toBe("odd-ua/3.0");
  });

  it("a user-agent in AccountClient extraHeaders wins", async () => {
    const client = new AccountClient({
      apiKey: "sk_test",
      baseUrl: "http://app.test",
      extraHeaders: { "user-agent": "acct-ua/4.0" },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.settings.get();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["user-agent"]).toBe("acct-ua/4.0");
    expect("User-Agent" in init.headers).toBe(false);
  });
});

/** A minimal wire-format JSON:API audit-event resource. */
function auditEventResource(): object {
  return {
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
  };
}
