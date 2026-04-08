import { describe, it, expect } from "vitest";
import { keyToDisplayName } from "../../src/helpers.js";

describe("keyToDisplayName", () => {
  it("should convert hyphenated keys to title case", () => {
    expect(keyToDisplayName("checkout-v2")).toBe("Checkout V2");
  });

  it("should convert underscored keys to title case", () => {
    expect(keyToDisplayName("payment_service")).toBe("Payment Service");
  });

  it("should capitalize a single word", () => {
    expect(keyToDisplayName("simple")).toBe("Simple");
  });

  it("should handle multi-word keys with version suffixes", () => {
    expect(keyToDisplayName("multi-word-key-v3")).toBe("Multi Word Key V3");
  });

  it("should handle mixed separators", () => {
    expect(keyToDisplayName("my-service_name")).toBe("My Service Name");
  });

  it("should handle an empty string", () => {
    expect(keyToDisplayName("")).toBe("");
  });
});
