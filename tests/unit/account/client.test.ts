import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountClient, SettingsClient } from "../../../src/account/client.js";
import { AccountSettings } from "../../../src/account/models.js";
import {
  SmplConnectionError,
  SmplValidationError,
  SmplNotFoundError,
} from "../../../src/errors.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_test";

function makeClient(): AccountClient {
  return new AccountClient({ apiKey: API_KEY, baseDomain: "test", scheme: "http" });
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

// ===========================================================================
// SettingsClient.get()
// ===========================================================================

describe("SettingsClient.get()", () => {
  it("returns an AccountSettings parsed from the JSON body", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ environment_order: ["production", "staging"] }));
    const settings = await makeClient().settings.get();
    expect(settings).toBeInstanceOf(AccountSettings);
    expect(settings.environmentOrder).toEqual(["production", "staging"]);
  });

  it("GETs /api/v1/accounts/current/settings", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await makeClient().settings.get();
    const [url, init] = mockFetch.mock.calls[0];
    expect(typeof url).toBe("string");
    expect(url).toContain("/api/v1/accounts/current/settings");
    // GET — no method override means undefined/GET
    expect(init.method).toBeUndefined();
  });

  it("includes the Authorization and Content-Type headers", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await makeClient().settings.get();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("defaults to an empty settings object when the body is null", async () => {
    mockFetch.mockResolvedValueOnce(new Response("null", { status: 200 }));
    const settings = await makeClient().settings.get();
    expect(settings.raw).toEqual({});
  });

  it("throws SmplConnectionError on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(makeClient().settings.get()).rejects.toThrow(SmplConnectionError);
  });

  it("wraps a non-Error rejection in a SmplConnectionError", async () => {
    mockFetch.mockRejectedValueOnce("boom");
    await expect(makeClient().settings.get()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplValidationError on a 422 response", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("Unprocessable", 422));
    await expect(makeClient().settings.get()).rejects.toThrow(SmplValidationError);
  });

  it("throws SmplNotFoundError on a 404 response", async () => {
    mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
    await expect(makeClient().settings.get()).rejects.toThrow(SmplNotFoundError);
  });
});

// ===========================================================================
// AccountSettings.save() (SettingsClient._save)
// ===========================================================================

describe("AccountSettings.save()", () => {
  it("PUTs the full settings object back to the server", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ environment_order: ["production"] }));
    const settings = await makeClient().settings.get();

    settings.environmentOrder = ["production", "staging"];
    mockFetch.mockResolvedValueOnce(jsonResponse({ environment_order: ["production", "staging"] }));
    await settings.save();

    const [url, init] = mockFetch.mock.calls[1];
    expect(init.method).toBe("PUT");
    expect(url).toContain("/api/v1/accounts/current/settings");
    const body = JSON.parse(init.body as string);
    expect(body.environment_order).toEqual(["production", "staging"]);
  });

  it("applies the response data after save", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const settings = await makeClient().settings.get();

    settings.environmentOrder = ["development"];
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ environment_order: ["development", "production"] }),
    );
    await settings.save();
    expect(settings.environmentOrder).toEqual(["development", "production"]);
  });

  it("defaults to an empty object when the save response is null", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ foo: "bar" }));
    const settings = await makeClient().settings.get();
    mockFetch.mockResolvedValueOnce(new Response("null", { status: 200 }));
    await settings.save();
    expect(settings.raw).toEqual({});
  });

  it("throws SmplConnectionError on network failure during save", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const settings = await makeClient().settings.get();
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(settings.save()).rejects.toThrow(SmplConnectionError);
  });

  it("wraps a non-Error rejection during save in a SmplConnectionError", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const settings = await makeClient().settings.get();
    mockFetch.mockRejectedValueOnce("boom");
    await expect(settings.save()).rejects.toThrow(SmplConnectionError);
  });

  it("throws SmplValidationError on a 422 during save", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    const settings = await makeClient().settings.get();
    mockFetch.mockResolvedValueOnce(textResponse("Unprocessable", 422));
    await expect(settings.save()).rejects.toThrow(SmplValidationError);
  });
});

// ===========================================================================
// AccountClient construction
// ===========================================================================

describe("AccountClient", () => {
  it("exposes a settings sub-client", () => {
    expect(makeClient().settings).toBeInstanceOf(SettingsClient);
  });

  it("uses a supplied baseUrl directly, stripping a trailing slash", async () => {
    const client = new AccountClient({ apiKey: API_KEY, baseUrl: "http://app.test///" });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.settings.get();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://app.test/api/v1/accounts/current/settings");
  });

  it("merges extraHeaders into every request", async () => {
    const client = new AccountClient({
      apiKey: API_KEY,
      baseUrl: "http://app.test",
      extraHeaders: { "X-Tenant": "acme" },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.settings.get();
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers["X-Tenant"]).toBe("acme");
    expect(init.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("omits extra headers when none are supplied", async () => {
    const client = new AccountClient({ apiKey: API_KEY, baseUrl: "http://app.test" });
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await client.settings.get();
    const [, init] = mockFetch.mock.calls[0];
    // Only the SDK-owned headers are present.
    expect(Object.keys(init.headers).sort()).toEqual(["Authorization", "Content-Type"]);
  });

  it("close() is a no-op that does not throw", () => {
    expect(() => makeClient().close()).not.toThrow();
  });
});
