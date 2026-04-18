/**
 * Integration tests: SmplClient constructor with config resolution.
 *
 * These tests verify that the SmplClient wires up the config resolver
 * correctly — profiles, env vars, and constructor args all flow through.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplError } from "../../src/errors.js";
import { SmplClient } from "../../src/client.js";

vi.mock("node:fs");
vi.mock("node:os");

const mockReadFileSync = vi.mocked(readFileSync);
const mockHomedir = vi.mocked(homedir);

// Stub fetch globally so fire-and-forget calls don't hit the network.
const mockFetch = vi.fn();

const SMPLKIT_VARS = [
  "SMPLKIT_API_KEY",
  "SMPLKIT_BASE_DOMAIN",
  "SMPLKIT_SCHEME",
  "SMPLKIT_ENVIRONMENT",
  "SMPLKIT_SERVICE",
  "SMPLKIT_DEBUG",
  "SMPLKIT_DISABLE_TELEMETRY",
  "SMPLKIT_PROFILE",
] as const;

describe("SmplClient config integration", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ registered: 1 }), { status: 200 }));

    for (const v of SMPLKIT_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    mockHomedir.mockReturnValue("/mock/home");
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
    vi.restoreAllMocks();
  });

  it("should create a client with explicit constructor args", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "production",
      service: "my-svc",
    });
    expect(client).toBeInstanceOf(SmplClient);
    expect(client._environment).toBe("production");
    expect(client._service).toBe("my-svc");
    client.close();
  });

  it("should resolve all config from a config file profile", () => {
    mockReadFileSync.mockReturnValue(
      [
        "[common]",
        "api_key = sk_api_file",
        "base_domain = custom.example.com",
        "",
        "[staging]",
        "environment = staging",
        "service = file-svc",
      ].join("\n"),
    );

    const client = new SmplClient({ profile: "staging" });
    expect(client._environment).toBe("staging");
    expect(client._service).toBe("file-svc");
    client.close();
  });

  it("should resolve config from env vars", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    process.env.SMPLKIT_ENVIRONMENT = "env-env";
    process.env.SMPLKIT_SERVICE = "env-svc";

    const client = new SmplClient();
    expect(client._environment).toBe("env-env");
    expect(client._service).toBe("env-svc");
    client.close();
  });

  it("should throw when required fields are missing", () => {
    expect(() => new SmplClient()).toThrow(SmplError);
  });

  it("should accept baseDomain and scheme options", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "svc",
      baseDomain: "local.dev",
      scheme: "http",
    });
    // Verify the sub-clients got the custom base URLs
    expect(client.config._baseUrl).toBe("http://config.local.dev");
    expect(client.flags._baseUrl).toBe("http://flags.local.dev");
    expect(client.logging._baseUrl).toBe("http://logging.local.dev");
    client.close();
  });

  it("should accept profile option to select config file section", () => {
    mockReadFileSync.mockReturnValue(
      "[production]\napi_key = sk_prod\nenvironment = production\nservice = prod-svc\n" +
        "[staging]\napi_key = sk_stg\nenvironment = staging\nservice = stg-svc\n",
    );

    const client = new SmplClient({ profile: "staging" });
    expect(client._environment).toBe("staging");
    client.close();
  });

  it("should use SMPLKIT_PROFILE env var when no explicit profile", () => {
    process.env.SMPLKIT_PROFILE = "staging";
    mockReadFileSync.mockReturnValue(
      "[common]\napi_key = sk_common\n[staging]\nenvironment = staging\nservice = stg-svc\n",
    );

    const client = new SmplClient();
    expect(client._environment).toBe("staging");
    client.close();
  });

  it("should prefer explicit key over env var over config file", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    mockReadFileSync.mockReturnValue(
      "[default]\napi_key = sk_api_file\nenvironment = test\nservice = svc\n",
    );

    const client = new SmplClient({ apiKey: "sk_api_explicit" });
    // Environment and service come from file, apiKey from constructor
    expect(client._environment).toBe("test");
    client.close();
  });

  it("should silently skip missing config file", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      environment: "test",
      service: "svc",
    });
    expect(client).toBeInstanceOf(SmplClient);
    client.close();
  });
});
