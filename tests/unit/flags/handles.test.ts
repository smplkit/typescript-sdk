import { describe, expect, it } from "vitest";
import { FlagsClient } from "../../../src/flags/client.js";
import { Flag, BooleanFlag, StringFlag, NumberFlag, JsonFlag } from "../../../src/flags/models.js";
import { SmplError } from "../../../src/errors.js";

function makeFlagsClient(): FlagsClient {
  const mockWs = { on: () => {}, off: () => {}, connectionStatus: "disconnected" };
  return new FlagsClient("sk_test", () => mockWs as never, 30000);
}

function setFlagStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  (client as Record<string, unknown>)["_flagStore"] = store;
  (client as Record<string, unknown>)["_initialized"] = true;
  (client as Record<string, unknown>)["_environment"] = "staging";
}

describe("Typed flag handles", () => {
  describe("handle declarations", () => {
    it("booleanFlag() returns BooleanFlag", () => {
      const client = makeFlagsClient();
      const handle = client.booleanFlag("b", false);
      expect(handle).toBeInstanceOf(BooleanFlag);
    });

    it("stringFlag() returns StringFlag", () => {
      const client = makeFlagsClient();
      const handle = client.stringFlag("s", "default");
      expect(handle).toBeInstanceOf(StringFlag);
    });

    it("numberFlag() returns NumberFlag", () => {
      const client = makeFlagsClient();
      const handle = client.numberFlag("n", 0);
      expect(handle).toBeInstanceOf(NumberFlag);
    });

    it("jsonFlag() returns JsonFlag", () => {
      const client = makeFlagsClient();
      const handle = client.jsonFlag("j", {});
      expect(handle).toBeInstanceOf(JsonFlag);
    });
  });

  describe("handle properties", () => {
    it("should expose key and default properties", () => {
      const client = makeFlagsClient();
      const handle = client.booleanFlag("my-flag", true);
      expect(handle.key).toBe("my-flag");
      expect(handle.default).toBe(true);
    });

    it("should have id: null on declaration", () => {
      const client = makeFlagsClient();
      const handle = client.stringFlag("color", "red");
      expect(handle.id).toBeNull();
    });
  });

  describe("BooleanFlag.get()", () => {
    it("should return boolean when type matches", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        "my-flag": {
          key: "my-flag",
          default: true,
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.booleanFlag("my-flag", false);
      expect(handle.get()).toBe(true);
      expect(typeof handle.get()).toBe("boolean");
    });

    it("should return code default on type mismatch", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        "my-flag": {
          key: "my-flag",
          default: "not a bool",
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.booleanFlag("my-flag", false);
      expect(handle.get()).toBe(false);
    });

    it("should throw SmplError when not initialized", () => {
      const client = makeFlagsClient();
      const handle = client.booleanFlag("my-flag", false);
      expect(() => handle.get()).toThrow(SmplError);
      expect(() => handle.get()).toThrow("Flags not initialized");
    });
  });

  describe("StringFlag.get()", () => {
    it("should return string when type matches", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        color: {
          key: "color",
          default: "blue",
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.stringFlag("color", "red");
      expect(handle.get()).toBe("blue");
      expect(typeof handle.get()).toBe("string");
    });

    it("should return code default on type mismatch", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        color: {
          key: "color",
          default: 42,
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.stringFlag("color", "red");
      expect(handle.get()).toBe("red");
    });

    it("should throw SmplError when not initialized", () => {
      const client = makeFlagsClient();
      const handle = client.stringFlag("color", "red");
      expect(() => handle.get()).toThrow(SmplError);
      expect(() => handle.get()).toThrow("Flags not initialized");
    });
  });

  describe("NumberFlag.get()", () => {
    it("should return number when type matches", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        retries: {
          key: "retries",
          default: 5,
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.numberFlag("retries", 3);
      expect(handle.get()).toBe(5);
      expect(typeof handle.get()).toBe("number");
    });

    it("should return code default on type mismatch", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        retries: {
          key: "retries",
          default: "not a number",
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.numberFlag("retries", 3);
      expect(handle.get()).toBe(3);
    });

    it("should throw SmplError when not initialized", () => {
      const client = makeFlagsClient();
      const handle = client.numberFlag("retries", 3);
      expect(() => handle.get()).toThrow(SmplError);
    });
  });

  describe("JsonFlag.get()", () => {
    it("should return object when type matches", () => {
      const client = makeFlagsClient();
      const theme = { mode: "dark", accent: "#fff" };
      setFlagStore(client, {
        theme: {
          key: "theme",
          default: theme,
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.jsonFlag("theme", { mode: "light" });
      expect(handle.get()).toEqual(theme);
    });

    it("should return code default on type mismatch (string)", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        theme: {
          key: "theme",
          default: "not an object",
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const defaultTheme = { mode: "light" };
      const handle = client.jsonFlag("theme", defaultTheme);
      expect(handle.get()).toEqual(defaultTheme);
    });

    it("should return code default on type mismatch (array)", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        theme: {
          key: "theme",
          default: [1, 2, 3],
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const defaultTheme = { mode: "light" };
      const handle = client.jsonFlag("theme", defaultTheme);
      expect(handle.get()).toEqual(defaultTheme);
    });

    it("should return code default on type mismatch (null)", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        theme: {
          key: "theme",
          default: null,
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const defaultTheme = { mode: "light" };
      const handle = client.jsonFlag("theme", defaultTheme);
      expect(handle.get()).toEqual(defaultTheme);
    });

    it("should throw SmplError when not initialized", () => {
      const client = makeFlagsClient();
      const handle = client.jsonFlag("theme", {});
      expect(() => handle.get()).toThrow(SmplError);
    });
  });

  describe("Flag.get() (base class)", () => {
    it("should evaluate via the base Flag class directly", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        "my-flag": {
          key: "my-flag",
          default: "hello",
          environments: { staging: { enabled: true, rules: [] } },
        },
      });

      // Instantiate the base Flag class directly (as _resourceToModel does)
      const flag = new Flag(client, {
        id: "f-1",
        key: "my-flag",
        name: "My Flag",
        type: "STRING",
        default: "fallback",
        values: [],
        description: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      expect(flag.get()).toBe("hello");
    });

    it("should return code default when flag not in store", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {});

      const handle = client.booleanFlag("nonexistent", false);
      expect(handle.get()).toBe(false);
    });
  });
});
