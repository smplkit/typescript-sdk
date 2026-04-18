import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplError } from "../../src/errors.js";
import { parseIniFile, parseBool, resolveConfig, serviceUrl } from "../../src/config.js";

vi.mock("node:fs");
vi.mock("node:os");

const mockReadFileSync = vi.mocked(readFileSync);
const mockHomedir = vi.mocked(homedir);

// Save/restore all SMPLKIT_* env vars to avoid leaking between tests.
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

describe("parseIniFile", () => {
  it("should parse [common] and overlay profile section", () => {
    const content = [
      "[common]",
      "api_key = sk_common",
      "base_domain = common.example.com",
      "",
      "[production]",
      "api_key = sk_prod",
    ].join("\n");

    const result = parseIniFile(content, "production");
    expect(result.api_key).toBe("sk_prod");
    expect(result.base_domain).toBe("common.example.com");
  });

  it("should return [common] values when profile is default and no [default] section", () => {
    const content = "[common]\napi_key = sk_common\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_common");
  });

  it("should support [default] profile section overlaying [common]", () => {
    const content = [
      "[common]",
      "base_domain = common.example.com",
      "",
      "[default]",
      "api_key = sk_default",
    ].join("\n");

    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_default");
    expect(result.base_domain).toBe("common.example.com");
  });

  it("should ignore # comments", () => {
    const content = "# comment\n[common]\n# another\napi_key = sk_val\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_val");
  });

  it("should ignore ; comments", () => {
    const content = "; comment\n[common]\n; another\napi_key = sk_val\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_val");
  });

  it("should skip empty values", () => {
    const content = "[common]\napi_key = \nbase_domain = example.com\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBeUndefined();
    expect(result.base_domain).toBe("example.com");
  });

  it("should skip lines without = sign", () => {
    const content = "[common]\napi_key = sk_val\ngarbage line\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_val");
  });

  it("should skip lines before any section header", () => {
    const content = "api_key = orphan\n[common]\napi_key = sk_val\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_val");
  });

  it("should match profile case-insensitively", () => {
    const content = "[Production]\napi_key = sk_prod\n";
    const result = parseIniFile(content, "production");
    expect(result.api_key).toBe("sk_prod");
  });

  it("should throw when named profile is missing but other non-common sections exist", () => {
    const content = "[common]\napi_key = sk_common\n[staging]\napi_key = sk_staging\n";
    expect(() => parseIniFile(content, "production")).toThrow(SmplError);
    expect(() => parseIniFile(content, "production")).toThrow('profile "production" not found');
  });

  it("should not throw for missing default profile", () => {
    const content = "[staging]\napi_key = sk_staging\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBeUndefined();
  });

  it("should trim keys and values", () => {
    const content = "[common]\n  api_key  =  sk_trimmed  \n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_trimmed");
  });

  it("should handle values with = signs", () => {
    const content = "[common]\napi_key = sk_key=with=equals\n";
    const result = parseIniFile(content, "default");
    expect(result.api_key).toBe("sk_key=with=equals");
  });
});

describe("parseBool", () => {
  it.each([
    ["true", true],
    ["True", true],
    ["TRUE", true],
    ["1", true],
    ["yes", true],
    ["Yes", true],
    ["YES", true],
    ["false", false],
    ["False", false],
    ["FALSE", false],
    ["0", false],
    ["no", false],
    ["No", false],
    ["NO", false],
  ])("should parse %s as %s", (input, expected) => {
    expect(parseBool(input, "test_key")).toBe(expected);
  });

  it("should throw for invalid boolean values", () => {
    expect(() => parseBool("maybe", "test_key")).toThrow(SmplError);
    expect(() => parseBool("maybe", "test_key")).toThrow("Invalid boolean value");
  });

  it("should include key name in error", () => {
    expect(() => parseBool("nope", "debug")).toThrow("debug");
  });
});

describe("serviceUrl", () => {
  it("should build URL from scheme, subdomain, and domain", () => {
    expect(serviceUrl("https", "config", "smplkit.com")).toBe("https://config.smplkit.com");
  });

  it("should support http scheme", () => {
    expect(serviceUrl("http", "app", "localhost:8000")).toBe("http://app.localhost:8000");
  });
});

describe("resolveConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
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

  // ---- Defaults ----

  it("should apply defaults for scheme, baseDomain, debug, disableTelemetry", () => {
    const cfg = resolveConfig({
      apiKey: "sk_api_test",
      environment: "prod",
      service: "svc",
    });
    expect(cfg.scheme).toBe("https");
    expect(cfg.baseDomain).toBe("smplkit.com");
    expect(cfg.debug).toBe(false);
    expect(cfg.disableTelemetry).toBe(false);
  });

  // ---- File resolution ----

  it("should read values from [default] profile in config file", () => {
    mockReadFileSync.mockReturnValue(
      "[default]\napi_key = sk_file\nenvironment = staging\nservice = file-svc\n",
    );
    const cfg = resolveConfig({});
    expect(cfg.apiKey).toBe("sk_file");
    expect(cfg.environment).toBe("staging");
    expect(cfg.service).toBe("file-svc");
  });

  it("should merge [common] with profile section", () => {
    mockReadFileSync.mockReturnValue(
      [
        "[common]",
        "api_key = sk_common",
        "base_domain = custom.example.com",
        "",
        "[production]",
        "environment = production",
        "service = prod-svc",
      ].join("\n"),
    );
    const cfg = resolveConfig({ profile: "production" });
    expect(cfg.apiKey).toBe("sk_common");
    expect(cfg.baseDomain).toBe("custom.example.com");
    expect(cfg.environment).toBe("production");
    expect(cfg.service).toBe("prod-svc");
  });

  it("should select profile via SMPLKIT_PROFILE env var", () => {
    process.env.SMPLKIT_PROFILE = "staging";
    mockReadFileSync.mockReturnValue(
      "[common]\napi_key = sk_common\n[staging]\nenvironment = staging\nservice = stg-svc\n",
    );
    const cfg = resolveConfig({});
    expect(cfg.environment).toBe("staging");
    expect(cfg.service).toBe("stg-svc");
  });

  it("should prefer constructor profile over SMPLKIT_PROFILE", () => {
    process.env.SMPLKIT_PROFILE = "staging";
    mockReadFileSync.mockReturnValue(
      "[staging]\napi_key = sk_stg\nenvironment = staging\nservice = stg\n" +
        "[production]\napi_key = sk_prod\nenvironment = production\nservice = prod\n",
    );
    const cfg = resolveConfig({ profile: "production" });
    expect(cfg.environment).toBe("production");
    expect(cfg.apiKey).toBe("sk_prod");
  });

  it("should throw when named profile is missing from file", () => {
    mockReadFileSync.mockReturnValue(
      "[staging]\napi_key = sk_stg\nenvironment = staging\nservice = stg\n",
    );
    expect(() => resolveConfig({ profile: "production" })).toThrow(SmplError);
    expect(() => resolveConfig({ profile: "production" })).toThrow(
      'profile "production" not found',
    );
  });

  it("should silently skip when config file is missing", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const cfg = resolveConfig({
      apiKey: "sk_test",
      environment: "prod",
      service: "svc",
    });
    expect(cfg.apiKey).toBe("sk_test");
  });

  it("should treat empty value in file as unset", () => {
    mockReadFileSync.mockReturnValue("[default]\napi_key = \nenvironment = prod\nservice = svc\n");
    // api_key is empty in file, so it's not set — needs constructor or env
    expect(() => resolveConfig({})).toThrow("No API key");
  });

  // ---- Env vars ----

  it("should use env vars to override file values", () => {
    mockReadFileSync.mockReturnValue(
      "[default]\napi_key = sk_file\nenvironment = file-env\nservice = file-svc\n",
    );
    process.env.SMPLKIT_API_KEY = "sk_env";
    const cfg = resolveConfig({});
    expect(cfg.apiKey).toBe("sk_env");
    expect(cfg.environment).toBe("file-env"); // not overridden
  });

  it("should skip empty env vars", () => {
    process.env.SMPLKIT_API_KEY = "";
    mockReadFileSync.mockReturnValue(
      "[default]\napi_key = sk_file\nenvironment = prod\nservice = svc\n",
    );
    const cfg = resolveConfig({});
    expect(cfg.apiKey).toBe("sk_file");
  });

  // ---- Constructor args ----

  it("should use constructor args to override env vars", () => {
    process.env.SMPLKIT_API_KEY = "sk_env";
    process.env.SMPLKIT_ENVIRONMENT = "env-env";
    process.env.SMPLKIT_SERVICE = "env-svc";
    const cfg = resolveConfig({
      apiKey: "sk_constructor",
      environment: "ctor-env",
      service: "ctor-svc",
    });
    expect(cfg.apiKey).toBe("sk_constructor");
    expect(cfg.environment).toBe("ctor-env");
    expect(cfg.service).toBe("ctor-svc");
  });

  it("should allow constructor to set baseDomain and scheme", () => {
    const cfg = resolveConfig({
      apiKey: "sk_test",
      environment: "prod",
      service: "svc",
      baseDomain: "custom.io",
      scheme: "http",
    });
    expect(cfg.baseDomain).toBe("custom.io");
    expect(cfg.scheme).toBe("http");
  });

  it("should allow constructor to set debug and disableTelemetry", () => {
    const cfg = resolveConfig({
      apiKey: "sk_test",
      environment: "prod",
      service: "svc",
      debug: true,
      disableTelemetry: true,
    });
    expect(cfg.debug).toBe(true);
    expect(cfg.disableTelemetry).toBe(true);
  });

  // ---- Boolean parsing from file/env ----

  it("should parse boolean debug from file", () => {
    mockReadFileSync.mockReturnValue(
      "[default]\napi_key = sk_test\nenvironment = prod\nservice = svc\ndebug = yes\n",
    );
    const cfg = resolveConfig({});
    expect(cfg.debug).toBe(true);
  });

  it("should parse boolean disable_telemetry from env var", () => {
    process.env.SMPLKIT_DISABLE_TELEMETRY = "1";
    const cfg = resolveConfig({
      apiKey: "sk_test",
      environment: "prod",
      service: "svc",
    });
    expect(cfg.disableTelemetry).toBe(true);
  });

  it("should throw on invalid boolean in file", () => {
    mockReadFileSync.mockReturnValue(
      "[default]\napi_key = sk_test\nenvironment = prod\nservice = svc\ndebug = maybe\n",
    );
    expect(() => resolveConfig({})).toThrow(SmplError);
    expect(() => resolveConfig({})).toThrow("Invalid boolean value");
  });

  // ---- Required field validation ----

  it("should throw when api_key is missing", () => {
    expect(() => resolveConfig({ environment: "prod", service: "svc" })).toThrow("No API key");
  });

  it("should throw when environment is missing", () => {
    expect(() => resolveConfig({ apiKey: "sk_test", service: "svc" })).toThrow("No environment");
  });

  it("should throw when service is missing", () => {
    expect(() => resolveConfig({ apiKey: "sk_test", environment: "prod" })).toThrow("No service");
  });

  // ---- Full 4-step precedence ----

  it("should follow precedence: constructor > env > file > defaults", () => {
    mockReadFileSync.mockReturnValue(
      [
        "[common]",
        "api_key = sk_file",
        "base_domain = file.example.com",
        "scheme = http",
        "environment = file-env",
        "service = file-svc",
        "debug = true",
        "disable_telemetry = true",
      ].join("\n"),
    );
    process.env.SMPLKIT_BASE_DOMAIN = "env.example.com";
    process.env.SMPLKIT_SCHEME = "https";

    const cfg = resolveConfig({
      baseDomain: "ctor.example.com",
    });

    // constructor wins for baseDomain
    expect(cfg.baseDomain).toBe("ctor.example.com");
    // env wins for scheme (over file)
    expect(cfg.scheme).toBe("https");
    // file wins for api_key (no env or constructor)
    expect(cfg.apiKey).toBe("sk_file");
    // file wins for environment and service
    expect(cfg.environment).toBe("file-env");
    expect(cfg.service).toBe("file-svc");
    // file wins for booleans (over defaults)
    expect(cfg.debug).toBe(true);
    expect(cfg.disableTelemetry).toBe(true);
  });
});
