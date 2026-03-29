import { describe, expect, it } from "vitest";
import { SmplClient } from "../../src/client.js";
import { SmplError } from "../../src/errors.js";
import { ConfigClient } from "../../src/config/client.js";

describe("SmplClient", () => {
  it("should throw SmplError when no apiKey and no env/config fallback", () => {
    const original = process.env.SMPLKIT_API_KEY;
    delete process.env.SMPLKIT_API_KEY;
    try {
      expect(() => new SmplClient({ apiKey: "" })).toThrow(SmplError);
    } finally {
      if (original !== undefined) process.env.SMPLKIT_API_KEY = original;
    }
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
