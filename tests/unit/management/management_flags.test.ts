/**
 * Tests for ManagementFlagsClient (mgmt.flags.*) and FlagRegistrationBuffer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplManagementClient } from "../../../src/management/client.js";
import { FlagRegistrationBuffer, ManagementFlagsClient } from "../../../src/management/flags.js";
import {
  Flag,
  BooleanFlag,
  StringFlag,
  NumberFlag,
  JsonFlag,
  FlagValue,
  FlagRule,
  FlagEnvironment,
} from "../../../src/flags/models.js";
import { FlagDeclaration, Rule, Op } from "../../../src/flags/types.js";
import {
  SmplNotFoundError,
  SmplConnectionError,
  SmplValidationError,
} from "../../../src/errors.js";

// ---------------------------------------------------------------------------
// Shared fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_flags_test";

function makeClient(): SmplManagementClient {
  return new SmplManagementClient({
    apiKey: API_KEY,
    baseDomain: "test",
    scheme: "http",
  });
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

// ---------------------------------------------------------------------------
// Sample resources
// ---------------------------------------------------------------------------

const SAMPLE_BOOLEAN_FLAG = {
  id: "dark-mode",
  type: "flag",
  attributes: {
    name: "Dark Mode",
    description: "Toggle for dark mode",
    type: "BOOLEAN",
    default: false,
    values: [
      { name: "True", value: true },
      { name: "False", value: false },
    ],
    environments: {
      production: {
        enabled: true,
        default: null,
        rules: [
          {
            logic: { "==": [{ var: "user.plan" }, "enterprise"] },
            value: true,
            description: "ent",
          },
        ],
      },
    },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
  },
};

const SAMPLE_STRING_FLAG = {
  id: "theme",
  type: "flag",
  attributes: {
    name: "Theme",
    description: null,
    type: "STRING",
    default: "light",
    values: null,
    environments: {},
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
  },
};

const SAMPLE_NUMBER_FLAG = {
  id: "max-retries",
  type: "flag",
  attributes: {
    name: "Max Retries",
    description: null,
    type: "NUMERIC",
    default: 3,
    values: null,
    environments: null,
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-02T10:00:00Z",
  },
};

const SAMPLE_JSON_FLAG = {
  id: "configurable",
  type: "flag",
  attributes: {
    name: "Configurable",
    description: null,
    type: "JSON",
    default: { mode: "auto" },
    values: null,
    environments: null,
  },
};

const SAMPLE_UNKNOWN_TYPE_FLAG = {
  id: "weird",
  type: "flag",
  attributes: {
    name: "Weird",
    description: null,
    type: "WEIRD",
    default: null,
    values: null,
    environments: null,
  },
};

// ===========================================================================
// FlagRegistrationBuffer
// ===========================================================================

describe("FlagRegistrationBuffer", () => {
  it("add() queues a declaration", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }));
    expect(buf.pendingCount).toBe(1);
  });

  it("add() deduplicates by id", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }));
    buf.add(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: true }));
    expect(buf.pendingCount).toBe(1);
  });

  it("drain() returns batch and clears buffer", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }));
    buf.add(new FlagDeclaration({ id: "f2", type: "STRING", default: "x" }));
    const batch = buf.drain();
    expect(batch).toHaveLength(2);
    expect(buf.pendingCount).toBe(0);
  });

  it("preserves service and environment", () => {
    const buf = new FlagRegistrationBuffer();
    buf.add(
      new FlagDeclaration({
        id: "f1",
        type: "BOOLEAN",
        default: false,
        service: "svc",
        environment: "prod",
      }),
    );
    const batch = buf.drain();
    expect(batch[0]).toMatchObject({
      id: "f1",
      type: "BOOLEAN",
      default: false,
      service: "svc",
      environment: "prod",
    });
  });

  it("drains an empty buffer to an empty array", () => {
    const buf = new FlagRegistrationBuffer();
    expect(buf.drain()).toEqual([]);
  });
});

// ===========================================================================
// ManagementFlagsClient — typed factories
// ===========================================================================

describe("ManagementFlagsClient — typed factories", () => {
  it("newBooleanFlag returns a BooleanFlag with True/False values", () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });
    expect(flag).toBeInstanceOf(BooleanFlag);
    expect(flag.id).toBe("dark-mode");
    expect(flag.name).toBe("Dark Mode");
    expect(flag.type).toBe("BOOLEAN");
    expect(flag.default).toBe(false);
    expect(flag.values).toHaveLength(2);
    expect(flag.values?.[0].name).toBe("True");
    expect(flag.values?.[0].value).toBe(true);
    expect(flag.values?.[1].value).toBe(false);
  });

  it("newBooleanFlag accepts custom name and description", () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", {
      default: true,
      name: "Dark UI",
      description: "Whether to enable dark UI",
    });
    expect(flag.name).toBe("Dark UI");
    expect(flag.description).toBe("Whether to enable dark UI");
  });

  it("newStringFlag returns a StringFlag without values when omitted", () => {
    const client = makeClient();
    const flag = client.flags.newStringFlag("theme", { default: "light" });
    expect(flag).toBeInstanceOf(StringFlag);
    expect(flag.type).toBe("STRING");
    expect(flag.default).toBe("light");
    expect(flag.values).toBeNull();
  });

  it("newStringFlag accepts FlagValue instances and plain dicts in values", () => {
    const client = makeClient();
    const flag = client.flags.newStringFlag("theme", {
      default: "light",
      values: [new FlagValue({ name: "Light", value: "light" }), { name: "Dark", value: "dark" }],
    });
    expect(flag.values).toHaveLength(2);
    expect(flag.values?.[0]).toBeInstanceOf(FlagValue);
    expect(flag.values?.[1]).toBeInstanceOf(FlagValue);
    expect(flag.values?.[1].name).toBe("Dark");
  });

  it("newNumberFlag returns a NumberFlag with type NUMERIC", () => {
    const client = makeClient();
    const flag = client.flags.newNumberFlag("max-retries", { default: 3 });
    expect(flag).toBeInstanceOf(NumberFlag);
    expect(flag.type).toBe("NUMERIC");
    expect(flag.default).toBe(3);
  });

  it("newNumberFlag accepts custom name", () => {
    const client = makeClient();
    const flag = client.flags.newNumberFlag("retries", {
      default: 5,
      name: "Retries",
      description: "Total retries",
      values: [{ name: "Low", value: 1 }],
    });
    expect(flag.name).toBe("Retries");
    expect(flag.description).toBe("Total retries");
    expect(flag.values).toHaveLength(1);
  });

  it("newJsonFlag returns a JsonFlag with type JSON", () => {
    const client = makeClient();
    const flag = client.flags.newJsonFlag("config", { default: { mode: "auto" } });
    expect(flag).toBeInstanceOf(JsonFlag);
    expect(flag.type).toBe("JSON");
    expect(flag.default).toEqual({ mode: "auto" });
  });

  it("newJsonFlag accepts custom name and values", () => {
    const client = makeClient();
    const flag = client.flags.newJsonFlag("config", {
      default: {},
      name: "Config Object",
      description: "JSON config",
      values: [{ name: "Empty", value: {} }],
    });
    expect(flag.name).toBe("Config Object");
    expect(flag.description).toBe("JSON config");
    expect(flag.values).toHaveLength(1);
  });

  it("derives display name from id when name omitted", () => {
    const client = makeClient();
    const flag = client.flags.newStringFlag("payment_provider", { default: "stripe" });
    expect(flag.name).toBe("Payment Provider");
  });
});

// ===========================================================================
// list() / get()
// ===========================================================================

describe("ManagementFlagsClient.list()", () => {
  it("returns an array of subclassed Flags", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        data: [SAMPLE_BOOLEAN_FLAG, SAMPLE_STRING_FLAG, SAMPLE_NUMBER_FLAG, SAMPLE_JSON_FLAG],
      }),
    );

    const flags = await client.flags.list();
    expect(flags).toHaveLength(4);
    expect(flags[0]).toBeInstanceOf(BooleanFlag);
    expect(flags[1]).toBeInstanceOf(StringFlag);
    expect(flags[2]).toBeInstanceOf(NumberFlag);
    expect(flags[3]).toBeInstanceOf(JsonFlag);
  });

  it("returns empty array when no data", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const flags = await client.flags.list();
    expect(flags).toEqual([]);
  });

  it("returns base Flag class for unknown type", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_UNKNOWN_TYPE_FLAG] }));
    const flags = await client.flags.list();
    expect(flags).toHaveLength(1);
    expect(flags[0]).toBeInstanceOf(Flag);
    expect(flags[0]).not.toBeInstanceOf(BooleanFlag);
    expect(flags[0]).not.toBeInstanceOf(StringFlag);
    expect(flags[0]).not.toBeInstanceOf(NumberFlag);
    expect(flags[0]).not.toBeInstanceOf(JsonFlag);
  });

  it("issues GET to /api/v1/flags", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.flags.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/flags");
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.flags.list()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplConnectionError on generic error", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new Error("kaboom"));
    await expect(client.flags.list()).rejects.toThrow(SmplConnectionError);
  });

  it("wraps non-Error rejections (string)", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce("string-rejection");
    await expect(client.flags.list()).rejects.toThrow(SmplConnectionError);
  });

  it("propagates SmplValidationError on 422", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("invalid", 422));
    await expect(client.flags.list()).rejects.toThrow(SmplValidationError);
  });
});

describe("ManagementFlagsClient.get()", () => {
  it("returns a BooleanFlag with rules and values", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));

    const flag = await client.flags.get("dark-mode");
    expect(flag).toBeInstanceOf(BooleanFlag);
    expect(flag.id).toBe("dark-mode");
    expect(flag.values).toHaveLength(2);
    const env = flag.environments.production;
    expect(env).toBeInstanceOf(FlagEnvironment);
    expect(env.rules).toHaveLength(1);
    expect(env.rules[0]).toBeInstanceOf(FlagRule);
    expect(env.rules[0].description).toBe("ent");
    expect(env.rules[0].value).toBe(true);
  });

  it("issues GET to /api/v1/flags/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    await client.flags.get("dark-mode");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/api/v1/flags/dark-mode");
  });

  it("handles missing values field as null", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_STRING_FLAG }));
    const flag = await client.flags.get("theme");
    expect(flag.values).toBeNull();
  });

  it("handles malformed environment with non-array rules", async () => {
    const client = makeClient();
    const malformed = {
      id: "weird",
      type: "flag",
      attributes: {
        name: "Weird",
        description: null,
        type: "BOOLEAN",
        default: false,
        values: null,
        environments: {
          production: { enabled: false, default: null, rules: "not-an-array" },
        },
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: malformed }));
    const flag = await client.flags.get("weird");
    expect(flag.environments.production.rules).toEqual([]);
    expect(flag.environments.production.enabled).toBe(false);
  });

  it("handles environments where rule fields are missing", async () => {
    const client = makeClient();
    const malformed = {
      id: "missing",
      type: "flag",
      attributes: {
        name: "Missing",
        description: null,
        type: "BOOLEAN",
        default: false,
        values: null,
        environments: {
          // env value with missing fields — exercises ?? defaults.
          dev: {},
        },
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: malformed }));
    const flag = await client.flags.get("missing");
    expect(flag.environments.dev.enabled).toBe(true); // default true
    expect(flag.environments.dev.default).toBeNull();
    expect(flag.environments.dev.rules).toEqual([]);
  });

  it("handles a rule with missing logic and description", async () => {
    const client = makeClient();
    const data = {
      id: "default-rule",
      type: "flag",
      attributes: {
        name: "Default",
        description: null,
        type: "STRING",
        default: "off",
        values: null,
        environments: {
          dev: {
            enabled: true,
            default: null,
            rules: [{ value: "on" }], // logic + description omitted
          },
        },
      },
    };
    mockFetch.mockResolvedValueOnce(jsonResponse({ data }));
    const flag = await client.flags.get("default-rule");
    expect(flag.environments.dev.rules[0].logic).toEqual({});
    expect(flag.environments.dev.rules[0].description).toBeNull();
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.flags.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplNotFoundError when response body is empty", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(client.flags.get("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.flags.get("dark-mode")).rejects.toThrow(SmplConnectionError);
  });
});

// ===========================================================================
// delete()
// ===========================================================================

describe("ManagementFlagsClient.delete()", () => {
  it("resolves on 204", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.flags.delete("dark-mode")).resolves.toBeUndefined();
  });

  it("resolves on 200", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(client.flags.delete("dark-mode")).resolves.toBeUndefined();
  });

  it("issues DELETE to /api/v1/flags/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.flags.delete("dark-mode");
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("DELETE");
    expect(req.url).toContain("/api/v1/flags/dark-mode");
  });

  it("throws SmplNotFoundError on 404", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(client.flags.delete("missing")).rejects.toThrow(SmplNotFoundError);
  });

  it("throws SmplConnectionError on network failure", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.flags.delete("dark-mode")).rejects.toThrow(SmplConnectionError);
  });

  it("Flag.delete() routes through the client", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    const flag = await client.flags.get("dark-mode");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(flag.delete()).resolves.toBeUndefined();
    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("DELETE");
  });
});

// ===========================================================================
// register / flush / threshold-based auto-flush
// ===========================================================================

describe("ManagementFlagsClient.register()", () => {
  it("buffers a single declaration without flushing", async () => {
    const client = makeClient();
    await client.flags.register(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }));
    expect(mockFetch).not.toHaveBeenCalled();
    expect(client.flags.pendingCount).toBe(1);
  });

  it("buffers an array of declarations", async () => {
    const client = makeClient();
    await client.flags.register([
      new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }),
      new FlagDeclaration({ id: "f2", type: "STRING", default: "x" }),
    ]);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(client.flags.pendingCount).toBe(2);
  });

  it("flushes immediately when flush: true", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 1 }));
    await client.flags.register(
      new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }),
      { flush: true },
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.url).toContain("/api/v1/flags/bulk");
    expect(client.flags.pendingCount).toBe(0);
  });

  it("auto-flushes when buffer hits 50 items", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValue(jsonResponse({ registered: 50 }));

    for (let i = 0; i < 49; i++) {
      await client.flags.register(
        new FlagDeclaration({ id: `f${i}`, type: "BOOLEAN", default: false }),
      );
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(client.flags.pendingCount).toBe(49);

    // The 50th registration triggers an auto-flush. drain() runs synchronously
    // before the first await inside flush(), so pendingCount becomes 0 immediately.
    await client.flags.register(
      new FlagDeclaration({ id: "f49", type: "BOOLEAN", default: false }),
    );
    expect(client.flags.pendingCount).toBe(0);

    // Let the async POST settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("ManagementFlagsClient.flush()", () => {
  it("POSTs buffered flags to /api/v1/flags/bulk", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: 2 }));

    await client.flags.register(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }));
    await client.flags.register(new FlagDeclaration({ id: "f2", type: "STRING", default: "x" }));
    await client.flags.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.flags).toHaveLength(2);
    expect(body.flags[0].id).toBe("f1");
    expect(body.flags[1].id).toBe("f2");
  });

  it("is a no-op when buffer is empty", async () => {
    const client = makeClient();
    await client.flags.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("clears buffer after flush", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.flags.register(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }));
    await client.flags.flush();
    expect(client.flags.pendingCount).toBe(0);
  });

  it("silently swallows network errors", async () => {
    const client = makeClient();
    mockFetch.mockRejectedValueOnce(new TypeError("network"));
    await client.flags.register(new FlagDeclaration({ id: "f1", type: "BOOLEAN", default: false }));
    await expect(client.flags.flush()).resolves.toBeUndefined();
  });
});

// ===========================================================================
// _evaluateHandle — flags created via mgmt.flags.* cannot evaluate
// ===========================================================================

describe("_evaluateHandle()", () => {
  it("throws when called on a flag from mgmt.flags.*", () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });
    expect(() => flag.get()).toThrow(/cannot be evaluated/i);
  });
});

// ===========================================================================
// Flag.save() — create flow
// ===========================================================================

describe("Flag.save() — create (createdAt === null)", () => {
  it("POSTs to /api/v1/flags", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    await flag.save();

    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.method).toBe("POST");
    expect(req.url).toContain("/api/v1/flags");
  });

  it("sends JSON:API body with attributes", async () => {
    const client = makeClient();
    const flag = client.flags.newStringFlag("theme", {
      default: "light",
      values: [{ name: "Light", value: "light" }],
    });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_STRING_FLAG }));
    await flag.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.type).toBe("flag");
    expect(body.data.id).toBe("theme");
    expect(body.data.attributes.name).toBe("Theme");
    expect(body.data.attributes.type).toBe("STRING");
    expect(body.data.attributes.default).toBe("light");
    expect(body.data.attributes.values).toEqual([{ name: "Light", value: "light" }]);
    // No environments configured → omitted from body.
    expect(body.data.attributes.environments).toBeUndefined();
  });

  it("sends environments dict when rules are configured", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });
    flag.addRule(
      new Rule("Enterprise users", { environment: "production" })
        .when("user.plan", Op.EQ, "enterprise")
        .serve(true),
    );

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    await flag.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.environments).toBeDefined();
    expect(body.data.attributes.environments.production.enabled).toBe(true);
    expect(body.data.attributes.environments.production.rules).toHaveLength(1);
    expect(body.data.attributes.environments.production.rules[0].description).toBe(
      "Enterprise users",
    );
  });

  it("omits rule description in wire body when null", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });
    // Build a FlagRule with no description, then place it directly on a FlagEnvironment.
    const env = new FlagEnvironment({
      enabled: true,
      default: null,
      rules: [new FlagRule({ logic: {}, value: true, description: null })],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (flag as any)._environments["staging"] = env;

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    await flag.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.environments.staging.rules[0]).toEqual({
      logic: {},
      value: true,
    });
    expect(body.data.attributes.environments.staging.rules[0].description).toBeUndefined();
  });

  it("uses empty string when description is null", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });
    expect(flag.description).toBeNull();

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    await flag.save();

    const req: Request = mockFetch.mock.calls[0][0];
    const body = JSON.parse(await req.text());
    expect(body.data.attributes.description).toBe("");
  });

  it("applies response fields after creation", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    await flag.save();

    expect(flag.id).toBe("dark-mode");
    expect(flag.createdAt).toBe("2026-04-01T10:00:00Z");
  });

  it("throws SmplValidationError when server returns no data", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(flag.save()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplConnectionError on network failure during create", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(flag.save()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplValidationError on 422 during create", async () => {
    const client = makeClient();
    const flag = client.flags.newBooleanFlag("dark-mode", { default: false });

    mockFetch.mockResolvedValueOnce(textResponse("invalid", 422));
    await expect(flag.save()).rejects.toThrow(SmplValidationError);
  });
});

// ===========================================================================
// Flag.save() — update flow
// ===========================================================================

describe("Flag.save() — update (createdAt set)", () => {
  it("PUTs to /api/v1/flags/{id}", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    const flag = await client.flags.get("dark-mode");
    flag.name = "Dark Mode V2";

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    await flag.save();

    const req: Request = mockFetch.mock.calls[1][0];
    expect(req.method).toBe("PUT");
    expect(req.url).toContain("/api/v1/flags/dark-mode");
  });

  it("throws SmplConnectionError on network failure during update", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    const flag = await client.flags.get("dark-mode");

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(flag.save()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplValidationError on empty response body during update", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    const flag = await client.flags.get("dark-mode");

    mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(flag.save()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplNotFoundError on 404 during update", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_BOOLEAN_FLAG }));
    const flag = await client.flags.get("dark-mode");

    mockFetch.mockResolvedValueOnce(textResponse("not found", 404));
    await expect(flag.save()).rejects.toThrow(SmplNotFoundError);
  });
});

// ===========================================================================
// _updateFlag — guard against null id
// ===========================================================================

describe("_updateFlag() guard", () => {
  it("throws when called on a Flag with no id", async () => {
    const client = makeClient();
    const flag = new Flag(client.flags as ManagementFlagsClient, {
      id: null,
      name: "x",
      type: "BOOLEAN",
      default: false,
      values: null,
      description: null,
      environments: {},
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((client.flags as any)._updateFlag(flag)).rejects.toThrow(
      "Cannot update a Flag with no id",
    );
  });
});
