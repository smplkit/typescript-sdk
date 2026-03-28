import { describe, expect, it } from "vitest";
import { SmplClient } from "../../src/client.js";
import { ConfigClient } from "../../src/config/client.js";

describe("SmplClient", () => {
  it("should require an apiKey", () => {
    expect(() => new SmplClient({ apiKey: "" })).toThrow("apiKey is required");
  });

  it("should create a client with an apiKey", () => {
    const client = new SmplClient({ apiKey: "sk_api_test" });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should expose a config sub-client", () => {
    const client = new SmplClient({ apiKey: "sk_api_test" });
    expect(client.config).toBeInstanceOf(ConfigClient);
  });

  it("should accept a custom timeout", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      timeout: 5000,
    });
    expect(client).toBeInstanceOf(SmplClient);
  });

  it("should accept all options together", () => {
    const client = new SmplClient({
      apiKey: "sk_api_test",
      timeout: 10000,
    });
    expect(client).toBeInstanceOf(SmplClient);
    expect(client.config).toBeInstanceOf(ConfigClient);
  });
});
