import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplClient } from "../../src/client.js";
import { SmplError } from "../../src/errors.js";
import { ConfigClient } from "../../src/config/client.js";
import { FlagsClient } from "../../src/flags/client.js";

describe("SmplClient", () => {
  it("should throw SmplError when no apiKey and no env/config fallback", () => {
    // Skip if a config file exists on this machine (CI has no ~/.smplkit)
    if (existsSync(join(homedir(), ".smplkit"))) return;
    const original = process.env.SMPLKIT_API_KEY;
    delete process.env.SMPLKIT_API_KEY;
    try {
      expect(() => new SmplClient({ apiKey: "" })).toThrow(SmplError);
    } finally {
      if (original !== undefined) process.env.SMPLKIT_API_KEY = original;
    }
  });

  it("should create a client with an apiKey", () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should expose a config sub-client", () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should accept a custom timeout", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      timeout: 5000,
    });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should accept all options together", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      timeout: 10000,
    });
    expect(client).toBeInstanceOf(SmplClient);
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should expose a flags sub-client", () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client.flags).toBeInstanceOf(FlagsClient);
  });

  it("should return the same config instance every time (singleton accessor)", () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client.config).toBe(client.config);
  });

  it("should return the same flags instance every time (singleton accessor)", () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client.flags).toBe(client.flags);
  });

  it("should close without error when no WS is active", () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(() => client.close()).not.toThrow();
  });

  it("should throw SmplError when no environment and no env var", () => {
    const original = process.env.SMPLKIT_ENVIRONMENT;
    delete process.env.SMPLKIT_ENVIRONMENT;
    try {
      expect(() => new SmplClient({ apiKey: "sk_api_test" })).toThrow(SmplError);
      expect(() => new SmplClient({ apiKey: "sk_api_test" })).toThrow("No environment provided");
    } finally {
      if (original !== undefined) process.env.SMPLKIT_ENVIRONMENT = original;
    }
  });

  it("should resolve environment from SMPLKIT_ENVIRONMENT env var", () => {
    const original = process.env.SMPLKIT_ENVIRONMENT;
    process.env.SMPLKIT_ENVIRONMENT = "staging";
    try {
      const client = new SmplClient({ apiKey: "sk_api_test" });
      expect(client._environment).toBe("staging");
    } finally {
      if (original !== undefined) {
        process.env.SMPLKIT_ENVIRONMENT = original;
      } else {
        delete process.env.SMPLKIT_ENVIRONMENT;
      }
    }
  });

  it("should prefer explicit environment over env var", () => {
    const original = process.env.SMPLKIT_ENVIRONMENT;
    process.env.SMPLKIT_ENVIRONMENT = "staging";
    try {
      const client = new SmplClient({ apiKey: "sk_api_test", environment: "production" });
      expect(client._environment).toBe("production");
    } finally {
      if (original !== undefined) {
        process.env.SMPLKIT_ENVIRONMENT = original;
      } else {
        delete process.env.SMPLKIT_ENVIRONMENT;
      }
    }
  });

  it("should store service when provided", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "my-svc",
    });
    expect(client._service).toBe("my-svc");
  });

  it("should have null service when not provided", () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client._service).toBeNull();
  });

  it("should resolve service from SMPLKIT_SERVICE env var", () => {
    const original = process.env.SMPLKIT_SERVICE;
    process.env.SMPLKIT_SERVICE = "env-service";
    try {
      const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
      expect(client._service).toBe("env-service");
    } finally {
      if (original !== undefined) {
        process.env.SMPLKIT_SERVICE = original;
      } else {
        delete process.env.SMPLKIT_SERVICE;
      }
    }
  });
});

describe("SmplClient connect()", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body: object, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("should call flags._connectInternal and config._connectInternal", async () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    const flagsSpy = vi.spyOn(client.flags, "_connectInternal").mockResolvedValue(undefined);
    const configSpy = vi.spyOn(client.config, "_connectInternal").mockResolvedValue(undefined);

    await client.connect();

    expect(flagsSpy).toHaveBeenCalledWith("test");
    expect(configSpy).toHaveBeenCalledWith("test");
  });

  it("should be idempotent", async () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    const flagsSpy = vi.spyOn(client.flags, "_connectInternal").mockResolvedValue(undefined);
    vi.spyOn(client.config, "_connectInternal").mockResolvedValue(undefined);

    await client.connect();
    await client.connect();

    expect(flagsSpy).toHaveBeenCalledTimes(1);
  });

  it("should register service context when service is set", async () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "my-svc",
    });
    vi.spyOn(client.flags, "_connectInternal").mockResolvedValue(undefined);
    vi.spyOn(client.config, "_connectInternal").mockResolvedValue(undefined);

    // Mock the service registration POST and the connect internals
    mockFetch.mockResolvedValueOnce(jsonResponse({}));

    await client.connect();

    // First fetch call is the service registration
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("/api/v1/contexts/bulk");
    const body = JSON.parse(call[1].body);
    expect(body.contexts[0].type).toBe("service");
    expect(body.contexts[0].key).toBe("my-svc");
  });

  it("should not register service when service is null", async () => {
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    vi.spyOn(client.flags, "_connectInternal").mockResolvedValue(undefined);
    vi.spyOn(client.config, "_connectInternal").mockResolvedValue(undefined);

    await client.connect();

    // No fetch calls for service registration
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should swallow service registration failure", async () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "my-svc",
    });
    vi.spyOn(client.flags, "_connectInternal").mockResolvedValue(undefined);
    vi.spyOn(client.config, "_connectInternal").mockResolvedValue(undefined);

    mockFetch.mockRejectedValueOnce(new Error("network error"));

    await client.connect(); // Should not throw
  });
});
