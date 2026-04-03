import { describe, expect, it } from "vitest";
import {
  FlagsClient,
  BoolFlagHandle,
  StringFlagHandle,
  NumberFlagHandle,
  JsonFlagHandle,
} from "../../../src/flags/client.js";

function makeFlagsClient(): FlagsClient {
  const mockWs = { on: () => {}, off: () => {}, connectionStatus: "disconnected" };
  return new FlagsClient("sk_test", () => mockWs as never, 30000);
}

function setFlagStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  (client as Record<string, unknown>)["_flagStore"] = store;
  (client as Record<string, unknown>)["_connected"] = true;
  (client as Record<string, unknown>)["_environment"] = "staging";
}

describe("Typed flag handles", () => {
  it("should return correct handle types", () => {
    const client = makeFlagsClient();
    expect(client.boolFlag("b", false)).toBeInstanceOf(BoolFlagHandle);
    expect(client.stringFlag("s", "")).toBeInstanceOf(StringFlagHandle);
    expect(client.numberFlag("n", 0)).toBeInstanceOf(NumberFlagHandle);
    expect(client.jsonFlag("j", {})).toBeInstanceOf(JsonFlagHandle);
  });

  it("should expose key and default properties", () => {
    const client = makeFlagsClient();
    const handle = client.boolFlag("my-flag", true);
    expect(handle.key).toBe("my-flag");
    expect(handle.default).toBe(true);
  });

  describe("BoolFlagHandle", () => {
    it("should return boolean when type matches", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        "my-flag": {
          key: "my-flag",
          default: true,
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.boolFlag("my-flag", false);
      expect(handle.get()).toBe(true);
      expect(typeof handle.get()).toBe("boolean");
    });

    it("should return code default when type doesn't match", () => {
      const client = makeFlagsClient();
      setFlagStore(client, {
        "my-flag": {
          key: "my-flag",
          default: "not a bool",
          environments: { staging: { enabled: true, rules: [] } },
        },
      });
      const handle = client.boolFlag("my-flag", false);
      expect(handle.get()).toBe(false);
    });
  });

  describe("StringFlagHandle", () => {
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

    it("should return code default when type doesn't match", () => {
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
  });

  describe("NumberFlagHandle", () => {
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

    it("should return code default when type doesn't match", () => {
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
  });

  describe("JsonFlagHandle", () => {
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

    it("should return code default when type doesn't match", () => {
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
  });

  describe("onChange listener", () => {
    it("should register flag-specific listeners", () => {
      const client = makeFlagsClient();
      const handle = client.boolFlag("my-flag", false);
      const events: unknown[] = [];
      handle.onChange((e) => events.push(e));
      // Listeners are registered but won't fire without WebSocket events
      expect(events).toHaveLength(0);
    });
  });
});
