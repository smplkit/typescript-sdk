/**
 * The shared standalone sub-client config resolution (`subclient_config.ts`):
 *
 * - Fast path: apiKey + baseUrl + environment all explicit → used directly,
 *   no resolver, no env reads.
 * - Env fallback (edge entries): defaults → SMPLKIT_* env vars → options,
 *   with a clear error when no API key resolves.
 * - Injected-resolver path (package root): the resolver's values fill in
 *   whatever options omit; options always win.
 *
 * NOTE ON ORDER: `_setSubclientConfigResolver` mutates module state for the
 * rest of this file, so every non-injected case runs before the injection
 * tests at the bottom.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { _setSubclientConfigResolver, resolveSubclientConfig } from "../../src/subclient_config.js";
import { SmplError } from "../../src/errors.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fast path (apiKey + baseUrl + environment all explicit)", () => {
  test("uses the options directly, including scheme/baseDomain/service passthrough", () => {
    const cfg = resolveSubclientConfig("audit", {
      apiKey: "sk_explicit",
      baseUrl: "https://audit.example.com",
      environment: "production",
      scheme: "http",
      baseDomain: "example.com",
      service: "checkout",
    });
    expect(cfg).toEqual({
      apiKey: "sk_explicit",
      baseUrl: "https://audit.example.com",
      scheme: "http",
      baseDomain: "example.com",
      environment: "production",
      service: "checkout",
    });
  });

  test("defaults scheme/baseDomain when the fast path is taken without them", () => {
    const cfg = resolveSubclientConfig("flags", {
      apiKey: "sk_explicit",
      baseUrl: "https://flags.example.com",
      environment: "staging",
    });
    expect(cfg.scheme).toBe("https");
    expect(cfg.baseDomain).toBe("smplkit.com");
    expect(cfg.service).toBeUndefined();
  });
});

describe("env fallback (no injected resolver)", () => {
  test("throws a clear SmplError when no API key resolves anywhere", () => {
    expect(() => resolveSubclientConfig("jobs", {})).toThrowError(
      /No API key provided.*SMPLKIT_API_KEY/s,
    );
    expect(() => resolveSubclientConfig("jobs", {})).toThrowError(SmplError);
  });

  test("resolves every field from SMPLKIT_* env vars and composes the base URL", () => {
    vi.stubEnv("SMPLKIT_API_KEY", "sk_from_env");
    vi.stubEnv("SMPLKIT_SCHEME", "http");
    vi.stubEnv("SMPLKIT_BASE_DOMAIN", "env.example");
    vi.stubEnv("SMPLKIT_ENVIRONMENT", "staging");
    vi.stubEnv("SMPLKIT_SERVICE", "billing");
    const cfg = resolveSubclientConfig("config", {});
    expect(cfg).toEqual({
      apiKey: "sk_from_env",
      baseUrl: "http://config.env.example",
      scheme: "http",
      baseDomain: "env.example",
      environment: "staging",
      service: "billing",
    });
  });

  test("options beat env vars field-by-field; empty env vars count as unset", () => {
    vi.stubEnv("SMPLKIT_API_KEY", "sk_from_env");
    vi.stubEnv("SMPLKIT_ENVIRONMENT", "");
    vi.stubEnv("SMPLKIT_SERVICE", "");
    const cfg = resolveSubclientConfig("logging", {
      apiKey: "sk_option",
      scheme: "http",
      baseDomain: "opt.example",
    });
    expect(cfg.apiKey).toBe("sk_option");
    expect(cfg.baseUrl).toBe("http://logging.opt.example");
    expect(cfg.environment).toBeUndefined();
    expect(cfg.service).toBeUndefined();
  });

  test("an explicit baseUrl wins over the composed service URL", () => {
    vi.stubEnv("SMPLKIT_API_KEY", "sk_from_env");
    const cfg = resolveSubclientConfig("app", { baseUrl: "https://app.other.example" });
    expect(cfg.baseUrl).toBe("https://app.other.example");
  });
});

// LAST in the file: mutates module-level resolver state.
describe("injected-resolver path (package root)", () => {
  test("the resolver fills in whatever the options omit; options win per field", () => {
    const resolver = vi.fn(() => ({
      apiKey: "sk_resolved",
      scheme: "http",
      baseDomain: "resolved.example",
      environment: "prod-from-file",
      service: "svc-from-file",
    }));
    _setSubclientConfigResolver(resolver);

    const fromResolver = resolveSubclientConfig("audit", {});
    expect(fromResolver).toEqual({
      apiKey: "sk_resolved",
      baseUrl: "http://audit.resolved.example",
      scheme: "http",
      baseDomain: "resolved.example",
      environment: "prod-from-file",
      service: "svc-from-file",
    });

    const withOverrides = resolveSubclientConfig("audit", {
      apiKey: "sk_option",
      baseUrl: "https://audit.example.com",
      environment: "staging",
      service: "checkout",
    });
    // apiKey+baseUrl+environment all set → fast path, resolver untouched.
    expect(withOverrides.apiKey).toBe("sk_option");
    expect(withOverrides.baseUrl).toBe("https://audit.example.com");
    expect(withOverrides.environment).toBe("staging");
    expect(withOverrides.service).toBe("checkout");
  });

  test("a resolver returning null environment/service maps to undefined", () => {
    _setSubclientConfigResolver(() => ({
      apiKey: "sk_resolved",
      scheme: "https",
      baseDomain: "resolved.example",
      environment: null,
      service: null,
    }));
    const cfg = resolveSubclientConfig("flags", {});
    expect(cfg.environment).toBeUndefined();
    expect(cfg.service).toBeUndefined();
  });

  test("partial options merge over the resolver's values", () => {
    _setSubclientConfigResolver(() => ({
      apiKey: "sk_resolved",
      scheme: "https",
      baseDomain: "resolved.example",
      environment: "prod",
    }));
    const cfg = resolveSubclientConfig("jobs", { environment: "staging" });
    expect(cfg.apiKey).toBe("sk_resolved");
    expect(cfg.environment).toBe("staging");
    // A resolver that omits `service` entirely leaves it undefined.
    expect(cfg.service).toBeUndefined();
  });
});
