import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplClient } from "../../src/client.js";
import { SmplError } from "../../src/errors.js";
import { ConfigClient } from "../../src/config/client.js";
import { FlagsClient } from "../../src/flags/client.js";
import { LoggingClient } from "../../src/logging/client.js";

// Stub fetch globally so the fire-and-forget _registerServiceContext never hits the network.
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ registered: 1 }), { status: 200 }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const DEFAULT_OPTS = { apiKey: "sk_api_test", environment: "test", service: "test-svc" };

describe("SmplClient", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.SMPLKIT_SERVICE = process.env.SMPLKIT_SERVICE;
    savedEnv.SMPLKIT_ENVIRONMENT = process.env.SMPLKIT_ENVIRONMENT;
    savedEnv.SMPLKIT_API_KEY = process.env.SMPLKIT_API_KEY;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  it("should throw SmplError when no apiKey and no env/config fallback", () => {
    // Skip if a config file exists on this machine (CI has no ~/.smplkit)
    if (existsSync(join(homedir(), ".smplkit"))) return;
    delete process.env.SMPLKIT_API_KEY;
    expect(() => new SmplClient({ apiKey: "", environment: "test", service: "test-svc" })).toThrow(
      SmplError,
    );
  });

  it("should create a client with all required options", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should expose a config sub-client", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should accept a custom timeout", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, timeout: 5000 });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should accept all options together", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, timeout: 10000 });
    expect(client).toBeInstanceOf(SmplClient);
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should expose a flags sub-client", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.flags).toBeInstanceOf(FlagsClient);
  });

  it("should expose a logging sub-client", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.logging).toBeInstanceOf(LoggingClient);
  });

  it("should return the same config instance every time (singleton accessor)", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.config).toBe(client.config);
  });

  it("should return the same flags instance every time (singleton accessor)", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(client.flags).toBe(client.flags);
  });

  it("should close without error when no WS is active", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    expect(() => client.close()).not.toThrow();
  });

  it("should accept a long API key (> 14 chars) without throwing", () => {
    const client = new SmplClient({ ...DEFAULT_OPTS, apiKey: "sk_api_1234567890abcdef" });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should call logging._close() on close()", () => {
    const client = new SmplClient(DEFAULT_OPTS);
    const spy = vi.spyOn(client.logging, "_close");
    client.close();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should throw SmplError when no environment and no env var", () => {
    delete process.env.SMPLKIT_ENVIRONMENT;
    expect(() => new SmplClient({ apiKey: "sk_api_test", service: "test-svc" })).toThrow(SmplError);
    expect(() => new SmplClient({ apiKey: "sk_api_test", service: "test-svc" })).toThrow(
      "No environment provided",
    );
  });

  it("should resolve environment from SMPLKIT_ENVIRONMENT env var", () => {
    process.env.SMPLKIT_ENVIRONMENT = "staging";
    const client = new SmplClient({ apiKey: "sk_api_test", service: "test-svc" });
    expect(client._environment).toBe("staging");
  });

  it("should prefer explicit environment over env var", () => {
    process.env.SMPLKIT_ENVIRONMENT = "staging";
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "production",
      service: "test-svc",
    });
    expect(client._environment).toBe("production");
  });

  it("should store service when provided", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "my-svc",
    });
    expect(client._service).toBe("my-svc");
  });

  it("should throw SmplError when no service and no env var", () => {
    delete process.env.SMPLKIT_SERVICE;
    expect(() => new SmplClient({ apiKey: "sk_api_test", environment: "test" })).toThrow(SmplError);
    expect(() => new SmplClient({ apiKey: "sk_api_test", environment: "test" })).toThrow(
      "No service provided",
    );
  });

  it("should include both methods in service error message", () => {
    delete process.env.SMPLKIT_SERVICE;
    try {
      new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    } catch (e) {
      expect(e).toBeInstanceOf(SmplError);
      const msg = (e as SmplError).message;
      expect(msg).toContain("Pass service in options");
      expect(msg).toContain("SMPLKIT_SERVICE");
      expect(msg).not.toContain("~/.smplkit");
    }
  });

  it("should resolve service from SMPLKIT_SERVICE env var", () => {
    process.env.SMPLKIT_SERVICE = "env-service";
    const client = new SmplClient({ apiKey: "sk_api_test", environment: "test" });
    expect(client._service).toBe("env-service");
  });

  it("should not mention ~/.smplkit in environment error message", () => {
    delete process.env.SMPLKIT_ENVIRONMENT;
    try {
      new SmplClient({ apiKey: "sk_api_test", service: "test-svc" });
    } catch (e) {
      expect(e).toBeInstanceOf(SmplError);
      const msg = (e as SmplError).message;
      expect(msg).not.toContain("~/.smplkit");
    }
  });

  it("should resolve environment before service before API key", () => {
    // Verify resolution order by checking that:
    // 1. Environment error fires before service/API key are checked
    // 2. Service error fires before API key is checked
    // 3. API key error fires last and includes the resolved environment

    delete process.env.SMPLKIT_ENVIRONMENT;
    delete process.env.SMPLKIT_SERVICE;
    delete process.env.SMPLKIT_API_KEY;

    // Missing environment → environment error (not service or api_key error)
    expect(() => new SmplClient({})).toThrow("No environment provided");

    // Has environment, missing service → service error (not api_key error)
    expect(() => new SmplClient({ environment: "test" })).toThrow("No service provided");

    // Skip if a config file exists on this machine
    if (!existsSync(join(homedir(), ".smplkit"))) {
      // Has environment + service, missing API key → api_key error with environment name
      try {
        new SmplClient({ environment: "staging", service: "test-svc" });
      } catch (e) {
        expect(e).toBeInstanceOf(SmplError);
        const msg = (e as SmplError).message;
        expect(msg).toContain("No API key provided");
        expect(msg).toContain("[staging]");
      }
    }
  });

  it("should show resolved environment name in API key error message", () => {
    // Skip if a config file exists on this machine
    if (existsSync(join(homedir(), ".smplkit"))) return;
    delete process.env.SMPLKIT_API_KEY;
    try {
      new SmplClient({ environment: "production", service: "test-svc" });
    } catch (e) {
      expect(e).toBeInstanceOf(SmplError);
      const msg = (e as SmplError).message;
      expect(msg).toContain("[production]");
      expect(msg).toContain("~/.smplkit");
    }
  });
});
