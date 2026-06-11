import { describe, it, expect, vi } from "vitest";
import { AccountSettings } from "../../../src/account/models.js";
import type { AccountSettingsModelClient } from "../../../src/account/models.js";

function mockSettingsClient(): AccountSettingsModelClient {
  return { _save: vi.fn() } as unknown as AccountSettingsModelClient;
}

describe("AccountSettings", () => {
  function makeSettings(data: Record<string, unknown> = {}): AccountSettings {
    return new AccountSettings(mockSettingsClient(), data);
  }

  describe("constructor", () => {
    it("stores the initial data", () => {
      const settings = makeSettings({ environment_order: ["production", "staging"] });
      expect(settings.environmentOrder).toEqual(["production", "staging"]);
    });

    it("shallow-copies the incoming data (later source mutation does not leak in)", () => {
      const source: Record<string, unknown> = { environment_order: ["production"] };
      const settings = new AccountSettings(null, source);
      source.extra = "x";
      expect(settings.raw).not.toHaveProperty("extra");
    });

    it("stores a reference to the client", () => {
      const client = mockSettingsClient();
      const settings = new AccountSettings(client, {});
      expect(settings._client).toBe(client);
    });
  });

  describe("raw getter/setter", () => {
    it("returns the live data dict (mutations persist)", () => {
      const settings = makeSettings({ foo: "bar" });
      settings.raw.baz = "qux";
      expect(settings.raw).toEqual({ foo: "bar", baz: "qux" });
    });

    it("replaces the data dict via the setter, copying the assigned value", () => {
      const settings = makeSettings({ foo: "bar" });
      const replacement = { baz: "qux" };
      settings.raw = replacement;
      expect(settings.raw).toEqual({ baz: "qux" });
      expect(settings.raw).not.toHaveProperty("foo");
      // setter copies, so mutating the source after assignment doesn't leak in
      replacement.baz = "changed";
      expect(settings.raw.baz).toBe("qux");
    });
  });

  describe("environmentOrder getter/setter", () => {
    it("returns an empty array when unset", () => {
      expect(makeSettings({}).environmentOrder).toEqual([]);
    });

    it("returns an empty array when the stored value is not an array", () => {
      expect(makeSettings({ environment_order: "nope" }).environmentOrder).toEqual([]);
    });

    it("returns the stored environment order", () => {
      expect(
        makeSettings({ environment_order: ["production", "staging"] }).environmentOrder,
      ).toEqual(["production", "staging"]);
    });

    it("returns a copy (mutating the result does not change internal state)", () => {
      const settings = makeSettings({ environment_order: ["production"] });
      settings.environmentOrder.push("staging");
      expect(settings.environmentOrder).toEqual(["production"]);
    });

    it("sets the environment order, copying the assigned array", () => {
      const settings = makeSettings({});
      const order = ["development", "production"];
      settings.environmentOrder = order;
      order.push("staging");
      expect(settings.environmentOrder).toEqual(["development", "production"]);
    });
  });

  describe("save()", () => {
    it("calls _save with the live data dict and applies the result", async () => {
      const client = mockSettingsClient();
      const settings = new AccountSettings(client, { environment_order: ["production"] });
      const saved = new AccountSettings(client, { environment_order: ["production", "staging"] });
      (client._save as ReturnType<typeof vi.fn>).mockResolvedValue(saved);

      await settings.save();
      expect(client._save).toHaveBeenCalledWith({ environment_order: ["production"] });
      expect(settings.environmentOrder).toEqual(["production", "staging"]);
    });

    it("persists ad-hoc raw mutations through save()", async () => {
      const client = mockSettingsClient();
      const settings = new AccountSettings(client, {});
      settings.raw.custom = "value";
      const saved = new AccountSettings(client, { custom: "value" });
      (client._save as ReturnType<typeof vi.fn>).mockResolvedValue(saved);

      await settings.save();
      expect(client._save).toHaveBeenCalledWith({ custom: "value" });
    });

    it("throws when the client is null", async () => {
      const settings = new AccountSettings(null, {});
      await expect(settings.save()).rejects.toThrow("cannot save");
    });
  });

  describe("_apply()", () => {
    it("replaces internal data from another AccountSettings", () => {
      const settings = makeSettings({ environment_order: ["production"] });
      const other = makeSettings({ environment_order: ["staging", "production"] });
      settings._apply(other);
      expect(settings.environmentOrder).toEqual(["staging", "production"]);
    });
  });

  describe("toString()", () => {
    it("returns a JSON representation", () => {
      expect(makeSettings({ environment_order: ["production"] }).toString()).toBe(
        'AccountSettings({"environment_order":["production"]})',
      );
    });
  });
});
