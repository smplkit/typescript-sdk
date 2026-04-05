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
    expect(resolveApiKey("sk_api_explicit", "production")).toBe("sk_api_explicit");
  });

  it("should use env var when no explicit key", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_env");
  });

  it("should use config file [default] when no explicit key and no env var", () => {
    mockReadFileSync.mockReturnValue("[default]\napi_key = sk_api_file\n");
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_file");
    expect(mockReadFileSync).toHaveBeenCalledWith(join("/mock/home", ".smplkit"), "utf-8");
  });

  it("should throw when no key found anywhere", () => {
    expect(() => resolveApiKey(undefined, "production")).toThrow(SmplError);
    expect(() => resolveApiKey(undefined, "production")).toThrow("No API key provided");
  });

  it("should throw when file has no api_key", () => {
    mockReadFileSync.mockReturnValue("[default]\nother_key = value\n");
    expect(() => resolveApiKey(undefined, "production")).toThrow(SmplError);
  });

  it("should throw when file is malformed", () => {
    mockReadFileSync.mockReturnValue("not valid ini {{{}}");
    expect(() => resolveApiKey(undefined, "production")).toThrow(SmplError);
  });

  it("should prefer explicit key over env var", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    expect(resolveApiKey("sk_api_explicit", "production")).toBe("sk_api_explicit");
  });

  it("should prefer env var over config file", () => {
    process.env.SMPLKIT_API_KEY = "sk_api_env";
    mockReadFileSync.mockReturnValue("[default]\napi_key = sk_api_file\n");
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_env");
  });

  it("should treat empty env var as unset", () => {
    process.env.SMPLKIT_API_KEY = "";
    mockReadFileSync.mockReturnValue("[default]\napi_key = sk_api_file\n");
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_file");
  });

  it("should ignore comments", () => {
    mockReadFileSync.mockReturnValue(
      "# comment\n[default]\n# another comment\napi_key = sk_api_comment\n",
    );
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_comment");
  });

  it("should throw when no matching section has api_key", () => {
    mockReadFileSync.mockReturnValue("[staging]\napi_key = sk_api_staging\n");
    expect(() => resolveApiKey(undefined, "production")).toThrow(SmplError);
  });

  it("should throw when default section has no api_key", () => {
    mockReadFileSync.mockReturnValue("[default]\nsome_other = value\n");
    expect(() => resolveApiKey(undefined, "production")).toThrow(SmplError);
  });

  it("should include all three methods in error message", () => {
    try {
      resolveApiKey(undefined, "production");
    } catch (e) {
      expect(e).toBeInstanceOf(SmplError);
      const msg = (e as SmplError).message;
      expect(msg).toContain("Pass apiKey to the constructor");
      expect(msg).toContain("SMPLKIT_API_KEY");
      expect(msg).toContain("~/.smplkit");
    }
  });

  it("should show resolved environment name in error message", () => {
    try {
      resolveApiKey(undefined, "staging");
    } catch (e) {
      expect(e).toBeInstanceOf(SmplError);
      const msg = (e as SmplError).message;
      expect(msg).toContain("[staging]");
    }
  });

  it("should prefer environment-scoped section over [default]", () => {
    mockReadFileSync.mockReturnValue(
      "[production]\napi_key = sk_api_prod\n\n[default]\napi_key = sk_api_default\n",
    );
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_prod");
  });

  it("should fall back to [default] when environment section is missing", () => {
    mockReadFileSync.mockReturnValue(
      "[staging]\napi_key = sk_api_staging\n\n[default]\napi_key = sk_api_default\n",
    );
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_default");
  });

  it("should match environment section case-insensitively", () => {
    mockReadFileSync.mockReturnValue("[Production]\napi_key = sk_api_prod\n");
    expect(resolveApiKey(undefined, "production")).toBe("sk_api_prod");
  });
});
