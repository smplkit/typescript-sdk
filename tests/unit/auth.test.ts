import { describe, expect, it } from "vitest";
import { buildAuthHeader } from "../../src/auth.js";

describe("buildAuthHeader", () => {
  it("should return a Bearer token string", () => {
    expect(buildAuthHeader("sk_api_test")).toBe("Bearer sk_api_test");
  });

  it("should include the full API key", () => {
    const key = "sk_api_1234567890abcdef";
    expect(buildAuthHeader(key)).toBe(`Bearer ${key}`);
  });
});
