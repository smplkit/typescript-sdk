/**
 * Tests for ConfigRegistrationBuffer + ManagementConfigClient discovery
 * methods (registerConfig / registerConfigItem / flush / pendingCount).
 */

import { describe, expect, it, vi } from "vitest";
import {
  ConfigRegistrationBuffer,
  ManagementConfigClient,
} from "../../../src/management/config.js";

function _makeMgmtClient(): { client: ManagementConfigClient; httpPOST: ReturnType<typeof vi.fn> } {
  const httpPOST = vi.fn().mockResolvedValue({ response: { ok: true } });
  const http = {
    GET: vi.fn(),
    POST: httpPOST,
    PUT: vi.fn(),
    DELETE: vi.fn(),
  } as never;
  return { client: new ManagementConfigClient(http), httpPOST };
}

describe("ConfigRegistrationBuffer", () => {
  it("queues a config declaration on declare()", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "svc",
      environment: "prod",
      parent: null,
      name: null,
      description: null,
    });
    expect(buf.pendingCount).toBe(1);
    const batch = buf.drain();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual({
      id: "billing",
      items: {},
      service: "svc",
      environment: "prod",
    });
  });

  it("includes optional metadata when provided", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s",
      environment: "e",
      parent: "common",
      name: "Billing",
      description: "Plan limits.",
    });
    const entry = buf.drain()[0];
    expect(entry.parent).toBe("common");
    expect(entry.name).toBe("Billing");
    expect(entry.description).toBe("Plan limits.");
  });

  it("declare is idempotent — first writer wins", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s1",
      environment: "e1",
      parent: null,
      name: null,
      description: null,
    });
    buf.declare("billing", {
      service: "s2",
      environment: "e2",
      parent: null,
      name: null,
      description: null,
    });
    const batch = buf.drain();
    expect(batch).toHaveLength(1);
    expect(batch[0].service).toBe("s1");
  });

  it("addItem attaches to existing config entry", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s",
      environment: "e",
      parent: null,
      name: null,
      description: null,
    });
    buf.addItem("billing", "max_seats", "NUMBER", 5, "Max.");
    const entry = buf.drain()[0];
    expect(entry.items).toEqual({
      max_seats: { value: 5, type: "NUMBER", description: "Max." },
    });
  });

  it("addItem without description omits the field", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s",
      environment: "e",
      parent: null,
      name: null,
      description: null,
    });
    buf.addItem("billing", "k", "STRING", "foo", null);
    expect(buf.drain()[0].items["k"]).toEqual({ value: "foo", type: "STRING" });
  });

  it("addItem without prior declare is dropped", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.addItem("unknown", "k", "NUMBER", 1, null);
    expect(buf.drain()).toEqual([]);
  });

  it("addItem dedupes within a session", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s",
      environment: "e",
      parent: null,
      name: null,
      description: null,
    });
    buf.addItem("billing", "max_seats", "NUMBER", 5, null);
    buf.addItem("billing", "max_seats", "NUMBER", 99, null);
    expect(buf.drain()[0].items["max_seats"].value).toBe(5);
  });

  it("addItem dedupes across drains", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s",
      environment: "e",
      parent: null,
      name: null,
      description: null,
    });
    buf.addItem("billing", "max_seats", "NUMBER", 5, null);
    buf.drain();
    buf.addItem("billing", "max_seats", "NUMBER", 5, null);
    expect(buf.drain()).toEqual([]);
  });

  it("delta after drain reattaches metadata", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "svc",
      environment: "prod",
      parent: "common",
      name: null,
      description: null,
    });
    buf.addItem("billing", "k1", "NUMBER", 1, null);
    buf.drain();
    buf.addItem("billing", "k2", "NUMBER", 2, null);
    const delta = buf.drain();
    expect(delta).toHaveLength(1);
    expect(delta[0].service).toBe("svc");
    expect(delta[0].environment).toBe("prod");
    expect(delta[0].parent).toBe("common");
    expect(delta[0].items).toEqual({ k2: { value: 2, type: "NUMBER" } });
  });

  it("drain clears pending", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s",
      environment: "e",
      parent: null,
      name: null,
      description: null,
    });
    expect(buf.drain()).toHaveLength(1);
    expect(buf.drain()).toEqual([]);
  });

  it("addItem keeps existing item entry when key already in pending", () => {
    const buf = new ConfigRegistrationBuffer();
    buf.declare("billing", {
      service: "s",
      environment: "e",
      parent: null,
      name: null,
      description: null,
    });
    buf.addItem("billing", "k", "NUMBER", 1, null);
    buf.addItem("billing", "k", "NUMBER", 99, null); // ignored — already in pending
    const entry = buf.drain()[0];
    expect(entry.items.k.value).toBe(1);
  });
});

describe("ManagementConfigClient discovery methods", () => {
  it("registerConfig queues a declaration", () => {
    const { client } = _makeMgmtClient();
    client.registerConfig("billing", {
      service: "svc",
      environment: "prod",
      parent: null,
      name: null,
      description: null,
    });
    expect(client.pendingCount).toBe(1);
  });

  it("registerConfigItem queues an item declaration", () => {
    const { client } = _makeMgmtClient();
    client.registerConfig("billing", { service: "s", environment: "e" });
    client.registerConfigItem("billing", "max_seats", "NUMBER", 5, "Max.");
    expect(client.pendingCount).toBe(1);
  });

  it("flush sends the buffered batch to /api/v1/configs/bulk", async () => {
    const { client, httpPOST } = _makeMgmtClient();
    client.registerConfig("billing", { service: "svc", environment: "prod" });
    client.registerConfigItem("billing", "max_seats", "NUMBER", 5, null);
    await client.flush();
    expect(httpPOST).toHaveBeenCalledTimes(1);
    expect(httpPOST.mock.calls[0][0]).toBe("/api/v1/configs/bulk");
    const body = httpPOST.mock.calls[0][1].body;
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0].id).toBe("billing");
  });

  it("flush is a no-op when the buffer is empty", async () => {
    const { client, httpPOST } = _makeMgmtClient();
    await client.flush();
    expect(httpPOST).not.toHaveBeenCalled();
  });

  it("flush swallows network errors (fire-and-forget)", async () => {
    const httpPOST = vi.fn().mockRejectedValue(new Error("boom"));
    const http = { GET: vi.fn(), POST: httpPOST, PUT: vi.fn(), DELETE: vi.fn() } as never;
    const client = new ManagementConfigClient(http);
    client.registerConfig("billing", { service: "s", environment: "e" });
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("flush handles non-ok response without throwing", async () => {
    const httpPOST = vi.fn().mockResolvedValue({ response: { ok: false } });
    const http = { GET: vi.fn(), POST: httpPOST, PUT: vi.fn(), DELETE: vi.fn() } as never;
    const client = new ManagementConfigClient(http);
    client.registerConfig("billing", { service: "s", environment: "e" });
    await expect(client.flush()).resolves.toBeUndefined();
  });

  it("registerConfig triggers background flush at threshold", async () => {
    const { client, httpPOST } = _makeMgmtClient();
    // Default threshold is 50; declare 50 unique configs.
    for (let i = 0; i < 50; i++) {
      client.registerConfig(`cfg-${i}`, { service: "s", environment: "e" });
    }
    // Background flush is fire-and-forget; yield to let it run.
    await new Promise((r) => setImmediate(r));
    expect(httpPOST).toHaveBeenCalled();
  });

  it("registerConfigItem triggers background flush at threshold", async () => {
    const { client, httpPOST } = _makeMgmtClient();
    // Declare 50 configs but flush them first to clear pending.
    for (let i = 0; i < 50; i++) {
      client.registerConfig(`cfg-${i}`, { service: "s", environment: "e" });
    }
    await new Promise((r) => setImmediate(r));
    httpPOST.mockClear();

    // Now adding 50 items to those configs (which re-creates pending entries)
    // should trigger another background flush via the item path.
    for (let i = 0; i < 50; i++) {
      client.registerConfigItem(`cfg-${i}`, `k-${i}`, "NUMBER", i, null);
    }
    await new Promise((r) => setImmediate(r));
    expect(httpPOST).toHaveBeenCalled();
  });
});
