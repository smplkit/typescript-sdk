import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplError } from "../../src/errors.js";
import { resolveApiKey } from "../../src/resolve.js";

vi.mock("node:fs");
vi.mock("node:os");

const mockReadFileSync = vi.mocked(readFileSync);
const mockHomedir = vi.mocked(homedir);

describe("resolveApiKey", () => {
  const originalEnv = process.env.SMPLKIT_API_KEY;

  beforeEach(() => {
    delete process.env.SMPLKIT_API_KEY;
    mockHomedir.mockReturnValue("/mock/home");
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SMPLKIT_API_KEY = originalEnv;
    } else {
      delete process.env.SMPLKIT_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it("should return explicit key when provided", () => {
    expect(resolveApiKey("sk_api_explicit")).toBe("sk_api_explicit");
  });

  it("should use env var when no explicit key", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    expect(resolveApiKey()).toBe("sk_api_env");
  });

  it("should use config file when no explicit key and no env var", () => {
    mockReadFileSync.mockReturnValue('[default]\napi_key = "sk_api_file"\n');
    expect(resolveApiKey()).toBe("sk_api_file");
    expect(mockReadFileSync).toHaveBeenCalledWith(join("/mock/home", ".smplkit"), "utf-8");
  });

  it("should throw when no key found anywhere", () => {
    expect(() => resolveApiKey()).toThrow(SmplError);
    expect(() => resolveApiKey()).toThrow("No API key provided");
  });

  it("should throw when file has no api_key", () => {
    mockReadFileSync.mockReturnValue('[default]\nother_key = "value"\n');
    expect(() => resolveApiKey()).toThrow(SmplError);
  });

  it("should throw when file is malformed", () => {
    mockReadFileSync.mockReturnValue("not valid toml {{{}}");
    expect(() => resolveApiKey()).toThrow(SmplError);
  });

  it("should prefer explicit key over env var", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    expect(resolveApiKey("sk_api_explicit")).toBe("sk_api_explicit");
  });

  it("should prefer env var over config file", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    mockReadFileSync.mockReturnValue('[default]\napi_key = "sk_api_file"\n');
    expect(resolveApiKey()).toBe("sk_api_env");
  });

  it("should treat empty env var as unset", () => {
    process.env.SMPLKIT_API_KEY = "";
    mockReadFileSync.mockReturnValue('[default]\napi_key = "sk_api_file"\n');
    expect(resolveApiKey()).toBe("sk_api_file");
  });

  it("should include all three methods in error message", () => {
    try {
      resolveApiKey();
    } catch (e) {
      expect(e).toBeInstanceOf(SmplError);
      const msg = (e as SmplError).message;
      expect(msg).toContain("Pass apiKey to the constructor");
      expect(msg).toContain("SMPLKIT_API_KEY");
      expect(msg).toContain("~/.smplkit");
    }
  });
});
