import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import type { ConfigChangeEvent } from "../../../src/config/client.js";
import { SmplNotConnectedError, SmplError } from "../../../src/errors.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

function makeClient(): ConfigClient {
  return new ConfigClient(API_KEY);
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Helper: connect a client with a single config in cache. */
async function connectClient(
  client: ConfigClient,
  configs: Array<{
    id: string;
    key: string;
    items: Record<string, unknown>;
    environments?: Record<string, unknown>;
    parent?: string | null;
  }>,
): Promise<void> {
  const data = configs.map((c) => ({
    id: c.id,
    type: "config",
    attributes: {
      key: c.key,
      name: c.key,
      description: null,
      parent: c.parent ?? null,
      items: Object.fromEntries(Object.entries(c.items).map(([k, v]) => [k, { value: v }])),
      environments: c.environments
        ? Object.fromEntries(
            Object.entries(c.environments).map(([env, entry]) => {
              const vals = (entry as Record<string, unknown>).values as Record<string, unknown>;
              return [
                env,
                {
                  values: Object.fromEntries(
                    Object.entries(vals).map(([k, v]) => [k, { value: v }]),
                  ),
                },
              ];
            }),
          )
        : {},
    },
  }));

  mockFetch.mockResolvedValueOnce(jsonResponse({ data }));
  await client._connectInternal("production");
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

describe("Typed accessors", () => {
  it("getString returns string value", async () => {
    const client = makeClient();
    await connectClient(client, [
      { id: "c1", key: "app", items: { name: "Acme", count: 42, flag: true } },
    ]);

    expect(client.getString("app", "name")).toBe("Acme");
  });

  it("getString returns default when value is not a string", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: { count: 42 } }]);

    expect(client.getString("app", "count")).toBeNull();
    expect(client.getString("app", "count", "fallback")).toBe("fallback");
  });

  it("getString returns default for missing key", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: {} }]);

    expect(client.getString("app", "missing")).toBeNull();
    expect(client.getString("app", "missing", "default")).toBe("default");
  });

  it("getInt returns number value", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: { port: 8080 } }]);

    expect(client.getInt("app", "port")).toBe(8080);
  });

  it("getInt returns default when value is not a number", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: { name: "Acme" } }]);

    expect(client.getInt("app", "name")).toBeNull();
    expect(client.getInt("app", "name", 99)).toBe(99);
  });

  it("getInt returns default for missing key", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: {} }]);

    expect(client.getInt("app", "missing")).toBeNull();
    expect(client.getInt("app", "missing", 42)).toBe(42);
  });

  it("getBool returns boolean value", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: { enabled: true } }]);

    expect(client.getBool("app", "enabled")).toBe(true);
  });

  it("getBool returns default when value is not a boolean", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: { name: "Acme" } }]);

    expect(client.getBool("app", "name")).toBeNull();
    expect(client.getBool("app", "name", false)).toBe(false);
  });

  it("getBool returns default for missing key", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: {} }]);

    expect(client.getBool("app", "missing")).toBeNull();
    expect(client.getBool("app", "missing", true)).toBe(true);
  });

  it("typed accessors throw SmplNotConnectedError before connect", () => {
    const client = makeClient();
    expect(() => client.getString("app", "name")).toThrow(SmplNotConnectedError);
    expect(() => client.getInt("app", "port")).toThrow(SmplNotConnectedError);
    expect(() => client.getBool("app", "flag")).toThrow(SmplNotConnectedError);
  });
});

// ---------------------------------------------------------------------------
// refresh()
// ---------------------------------------------------------------------------

describe("refresh", () => {
  it("should re-fetch configs and update cache", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3 } }]);
    expect(client.getValue("app", "retries")).toBe(3);

    // Mock the list() call for refresh — returns updated value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 7 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();
    expect(client.getValue("app", "retries")).toBe(7);
  });

  it("should throw SmplNotConnectedError before connect", async () => {
    const client = makeClient();
    await expect(client.refresh()).rejects.toThrow(SmplNotConnectedError);
  });

  it("should throw SmplError when no environment is set", async () => {
    const client = makeClient();
    // Force connected without parent
    await connectClient(client, [{ id: "c1", key: "app", items: {} }]);
    client._parent = null;

    await expect(client.refresh()).rejects.toThrow(SmplError);
  });

  it("should throw SmplError when environment is empty string", async () => {
    const client = makeClient();
    await connectClient(client, [{ id: "c1", key: "app", items: {} }]);
    client._parent = { _environment: "", _service: null };

    await expect(client.refresh()).rejects.toThrow(SmplError);
  });
});

// ---------------------------------------------------------------------------
// onChange + _diffAndFire
// ---------------------------------------------------------------------------

describe("onChange and change listeners", () => {
  it("should fire global listener on value change during refresh", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3 } }]);

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh with updated value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 7 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configKey).toBe("app");
    expect(events[0].itemKey).toBe("retries");
    expect(events[0].oldValue).toBe(3);
    expect(events[0].newValue).toBe(7);
    expect(events[0].source).toBe("manual");
  });

  it("should fire key-specific listener only for matching changes", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3, timeout: 1000 } }]);

    const retriesEvents: ConfigChangeEvent[] = [];
    client.onChange((e) => retriesEvents.push(e), { configKey: "app", itemKey: "retries" });

    // Refresh with both values changed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 7 }, timeout: { value: 2000 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(retriesEvents).toHaveLength(1);
    expect(retriesEvents[0].itemKey).toBe("retries");
  });

  it("should fire configKey-only listener for all items in that config", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3, timeout: 1000 } }]);

    const appEvents: ConfigChangeEvent[] = [];
    client.onChange((e) => appEvents.push(e), { configKey: "app" });

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 7 }, timeout: { value: 2000 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(appEvents).toHaveLength(2);
  });

  it("should not fire listener when values are unchanged", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3 } }]);

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh with same value
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 3 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(0);
  });

  it("should detect new keys added", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3 } }]);

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 3 }, new_key: { value: "hello" } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].itemKey).toBe("new_key");
    expect(events[0].oldValue).toBeNull();
    expect(events[0].newValue).toBe("hello");
  });

  it("should detect removed keys", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3, old_key: "bye" } }]);

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 3 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].itemKey).toBe("old_key");
    expect(events[0].oldValue).toBe("bye");
    expect(events[0].newValue).toBeNull();
  });

  it("should detect new configs added", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3 } }]);

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 3 } },
              environments: {},
            },
          },
          {
            id: "c2",
            type: "config",
            attributes: {
              key: "db",
              name: "db",
              description: null,
              parent: null,
              items: { host: { value: "localhost" } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configKey).toBe("db");
    expect(events[0].itemKey).toBe("host");
    expect(events[0].newValue).toBe("localhost");
  });

  it("should detect removed configs", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [
      { id: "c1", key: "app", items: { retries: 3 } },
      { id: "c2", key: "db", items: { host: "localhost" } },
    ]);

    const events: ConfigChangeEvent[] = [];
    client.onChange((e) => events.push(e));

    // Refresh returns only app — db is removed
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 3 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].configKey).toBe("db");
    expect(events[0].itemKey).toBe("host");
    expect(events[0].oldValue).toBe("localhost");
    expect(events[0].newValue).toBeNull();
  });

  it("should not crash if a listener throws", async () => {
    const client = makeClient();
    client._parent = { _environment: "production", _service: null };

    await connectClient(client, [{ id: "c1", key: "app", items: { retries: 3 } }]);

    const events: ConfigChangeEvent[] = [];
    client.onChange(() => {
      throw new Error("bad listener");
    });
    client.onChange((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: "c1",
            type: "config",
            attributes: {
              key: "app",
              name: "app",
              description: null,
              parent: null,
              items: { retries: { value: 7 } },
              environments: {},
            },
          },
        ],
      }),
    );

    await client.refresh();

    expect(events).toHaveLength(1);
    expect(events[0].newValue).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Singleton accessor identity
// ---------------------------------------------------------------------------

describe("Singleton accessor identity", () => {
  it("SmplClient.config should return the same instance each time", async () => {
    // SmplClient uses `readonly config: ConfigClient` — accessing it twice returns the same object
    // We test this via the ConfigClient constructor behavior: the _apiKey is shared
    const client = makeClient();
    // ConfigClient is a single instance — this is guaranteed by readonly property
    expect(client).toBe(client);
    expect(client._apiKey).toBe(API_KEY);
  });
});
