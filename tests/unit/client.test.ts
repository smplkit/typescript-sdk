import { describe, expect, it } from "vitest";
import { SmplkitClient } from "../../src/client.js";
import { ConfigClient } from "../../src/config/client.js";

describe("SmplkitClient", () => {
  it("should require an apiKey", () => {
    expect(() => new SmplkitClient({ apiKey: "" })).toThrow("apiKey is required");
  });

  it("should create a client with an apiKey", () => {
    const client = new SmplkitClient({ apiKey: "sk_api_test" });
    expect(client).toBeInstanceOf(SmplkitClient);
  });

  it("should expose a config sub-client", () => {
    const client = new SmplkitClient({ apiKey: "sk_api_test" });
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should accept a custom baseUrl", () => {
    const client = new SmplkitClient({
      apiKey: "sk_api_test",
      baseUrl: "https://custom.example.com",
    });
    expect(client).toBeInstanceOf(SmplkitClient);
  });

  it("should accept a custom timeout", () => {
    const client = new SmplkitClient({
      apiKey: "sk_api_test",
      timeout: 5000,
    });
    expect(client).toBeInstanceOf(SmplkitClient);
  });

  it("should accept all options together", () => {
    const client = new SmplkitClient({
      apiKey: "sk_api_test",
      baseUrl: "https://custom.example.com",
      timeout: 10000,
    });
    expect(client).toBeInstanceOf(SmplkitClient);
    expect(client.config).toBeInstanceOf(ConfigClient);
  });
});
