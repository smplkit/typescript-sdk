/**
 * The stateless (`streaming: false`) modes and the uniform standalone config
 * resolution across the config / flags / logging / jobs sub-clients:
 *
 * - `streaming: false` — the first live call fetches with `await` and no
 *   socket, timers, or background state are created. This file never wires
 *   a live-socket factory, so merely completing a live call IS the proof
 *   that no socket path ran (it would throw otherwise).
 * - With `streaming` left on and no factory wired (the edge-entry state), a
 *   live call throws a clear typed error naming the way out.
 * - `environment` / `service` resolve from `SMPLKIT_*` env vars on every
 *   standalone sub-client, exactly like SmplClient.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlagsClient } from "../../src/flags/client.js";
import { ConfigClient } from "../../src/config/client.js";
import { LoggingClient } from "../../src/logging/client.js";
import { JobsClient } from "../../src/jobs/client.js";
import { SmplkitError } from "../../src/errors.js";
import type { LoggingAdapter } from "../../src/logging/adapters/base.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  mockFetch.mockReset();
});

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function flagResource(id: string, defaultValue: unknown): object {
  return {
    id,
    type: "flag",
    attributes: {
      name: id,
      type: "BOOLEAN",
      default: defaultValue,
      values: [],
      description: null,
      environments: {},
    },
  };
}

function configResource(id: string, items: Record<string, unknown>): object {
  return {
    id,
    type: "config",
    attributes: {
      name: id,
      description: null,
      parent: null,
      items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { value: v }])),
      environments: {},
      created_at: "2024-01-15T10:30:00Z",
      updated_at: "2024-01-16T14:00:00Z",
    },
  };
}

function makeAdapter(): LoggingAdapter {
  return {
    name: "mock",
    discover: vi.fn(() => []),
    applyLevel: vi.fn(),
    installHook: vi.fn(),
    uninstallHook: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

describe("FlagsClient streaming: false (stateless)", () => {
  it("serves live evaluation from one awaited fetch, no socket state", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ data: [flagResource("beta", true)] }));
    const client = new FlagsClient({
      apiKey: "sk_test",
      environment: "staging",
      baseUrl: "https://flags.example.com",
      streaming: false,
    });

    const beta = await client.booleanFlag("beta", false);
    expect(beta.get()).toBe(true);
    expect((client as any)._wsManager).toBeNull();
    expect((client as any)._ownsWs).toBe(false);

    // close() has nothing to tear down.
    expect(() => client.close()).not.toThrow();
  });

  it("refresh() re-fetches on demand and updates evaluation", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [flagResource("beta", false)] }));
    const client = new FlagsClient({
      apiKey: "sk_test",
      environment: "staging",
      baseUrl: "https://flags.example.com",
      streaming: false,
    });
    const beta = await client.booleanFlag("beta", false);
    expect(beta.get()).toBe(false);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [flagResource("beta", true)] }));
    await client.refresh();
    expect(beta.get()).toBe(true);
  });

  it("with streaming left on and no factory wired, the live call throws the edge error", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ data: [] }));
    const client = new FlagsClient({
      apiKey: "sk_test",
      environment: "staging",
      baseUrl: "https://flags.example.com",
    });
    await expect(client.refresh()).rejects.toThrow(/Live updates aren't available/);
    await expect(client.refresh()).rejects.toThrow(SmplkitError);
  });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

describe("ConfigClient streaming: false (stateless)", () => {
  it("subscribe()/getValue() work from one awaited fetch-and-resolve, no socket state", async () => {
    mockFetch.mockImplementation(async () =>
      jsonResponse({ data: [configResource("app", { retries: 3 })] }),
    );
    const client = new ConfigClient({
      apiKey: "sk_test",
      environment: "staging",
      baseUrl: "https://config.example.com",
      streaming: false,
    });

    const proxy = await client.subscribe("app");
    expect((proxy as Record<string, unknown>).retries).toBe(3);
    await expect(client.getValue("app", "retries")).resolves.toBe(3);
    expect((client as any)._wsManager).toBeNull();

    expect(() => client.close()).not.toThrow();
  });

  it("refresh() re-fetches on demand, updates proxies, and fires onChange deltas", async () => {
    mockFetch.mockImplementationOnce(async () =>
      jsonResponse({ data: [configResource("app", { retries: 3 })] }),
    );
    const client = new ConfigClient({
      apiKey: "sk_test",
      environment: "staging",
      baseUrl: "https://config.example.com",
      streaming: false,
    });
    const proxy = await client.subscribe("app");
    const events: unknown[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockImplementationOnce(async () =>
      jsonResponse({ data: [configResource("app", { retries: 5 })] }),
    );
    await client.refresh();
    expect((proxy as Record<string, unknown>).retries).toBe(5);
    expect(events.length).toBeGreaterThan(0);
  });

  it("with streaming left on and no factory wired, the live call throws the edge error", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ data: [] }));
    const client = new ConfigClient({
      apiKey: "sk_test",
      environment: "staging",
      baseUrl: "https://config.example.com",
    });
    await expect(client.getValue("app", "retries")).rejects.toThrow(
      /Live updates aren't available/,
    );
  });
});

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

describe("LoggingClient streaming: false (stateless)", () => {
  it("install() applies once with await — no socket, no periodic timer", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ data: [] }));
    const client = new LoggingClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://logging.example.com",
      streaming: false,
    });
    const adapter = makeAdapter();
    client.registerAdapter(adapter);

    await client.install();
    expect(adapter.discover).toHaveBeenCalled();
    expect((client as any)._wsManager).toBeNull();
    expect((client as any)._loggerFlushTimer).toBeNull();

    // The live surface works post-install; refresh() polls on demand.
    await expect(client.refresh()).resolves.toBeUndefined();
    expect(() => client.close()).not.toThrow();
  });

  it("with streaming left on and no factory wired, install() throws the edge error", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ data: [] }));
    const client = new LoggingClient({
      apiKey: "sk_test",
      environment: "production",
      baseUrl: "https://logging.example.com",
    });
    client.registerAdapter(makeAdapter());
    await expect(client.install()).rejects.toThrow(/Live updates aren't available/);
  });
});

// ---------------------------------------------------------------------------
// uniform environment/service resolution (standalone, SMPLKIT_* env vars)
// ---------------------------------------------------------------------------

describe("standalone environment/service resolution from SMPLKIT_* env vars", () => {
  beforeEach(() => {
    vi.stubEnv("SMPLKIT_API_KEY", "sk_from_env");
    vi.stubEnv("SMPLKIT_ENVIRONMENT", "env-from-env");
    vi.stubEnv("SMPLKIT_SERVICE", "svc-from-env");
  });

  it("FlagsClient resolves environment and service", () => {
    const client = new FlagsClient({ streaming: false });
    expect((client as any)._environment).toBe("env-from-env");
    expect((client as any)._service).toBe("svc-from-env");
  });

  it("ConfigClient resolves environment and service", () => {
    const client = new ConfigClient({ streaming: false });
    expect((client as any)._environment).toBe("env-from-env");
    expect((client as any)._service).toBe("svc-from-env");
  });

  it("LoggingClient resolves environment and service", () => {
    const client = new LoggingClient({ streaming: false });
    expect((client as any)._environment).toBe("env-from-env");
    expect((client as any)._service).toBe("svc-from-env");
  });

  it("JobsClient resolves environment", () => {
    const client = new JobsClient({});
    expect((client as any)._environment).toBe("env-from-env");
  });

  it("constructor options still beat the env vars", () => {
    const client = new FlagsClient({
      environment: "explicit-env",
      service: "explicit-svc",
      streaming: false,
    });
    expect((client as any)._environment).toBe("explicit-env");
    expect((client as any)._service).toBe("explicit-svc");
  });
});
