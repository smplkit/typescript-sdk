import { describe, it, expect, vi } from "vitest";
import {
  Environment,
  ContextType,
  ContextEntity,
  AccountSettings,
} from "../../../src/management/models.js";
import { EnvironmentClassification } from "../../../src/management/types.js";
import type {
  EnvironmentsClient,
  ContextTypesClient,
  AccountSettingsClient,
} from "../../../src/management/client.js";

// ---------------------------------------------------------------------------
// Mock clients
// ---------------------------------------------------------------------------

function mockEnvsClient(): EnvironmentsClient {
  return {
    _create: vi.fn(),
    _update: vi.fn(),
  } as unknown as EnvironmentsClient;
}

function mockCtClient(): ContextTypesClient {
  return {
    _create: vi.fn(),
    _update: vi.fn(),
  } as unknown as ContextTypesClient;
}

function mockSettingsClient(): AccountSettingsClient {
  return {
    _save: vi.fn(),
  } as unknown as AccountSettingsClient;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

describe("Environment", () => {
  function makeEnv(
    overrides: Partial<ConstructorParameters<typeof Environment>[1]> = {},
  ): Environment {
    return new Environment(mockEnvsClient(), {
      id: "production",
      name: "Production",
      color: "#ff0000",
      classification: EnvironmentClassification.STANDARD,
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:00:00Z",
      ...overrides,
    });
  }

  describe("constructor", () => {
    it("should set all fields", () => {
      const env = makeEnv();
      expect(env.id).toBe("production");
      expect(env.name).toBe("Production");
      expect(env.color).toBe("#ff0000");
      expect(env.classification).toBe(EnvironmentClassification.STANDARD);
      expect(env.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(env.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("should store a reference to the client", () => {
      const client = mockEnvsClient();
      const env = new Environment(client, {
        id: "staging",
        name: "Staging",
        color: null,
        classification: EnvironmentClassification.AD_HOC,
        createdAt: null,
        updatedAt: null,
      });
      expect(env._client).toBe(client);
    });

    it("should accept null for optional fields", () => {
      const env = makeEnv({ id: null, color: null, createdAt: null, updatedAt: null });
      expect(env.id).toBeNull();
      expect(env.color).toBeNull();
      expect(env.createdAt).toBeNull();
      expect(env.updatedAt).toBeNull();
    });
  });

  describe("save() — create path (createdAt === null)", () => {
    it("should call _create and apply result", async () => {
      const client = mockEnvsClient();
      const env = new Environment(client, {
        id: "new-env",
        name: "New Env",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: null,
        updatedAt: null,
      });
      const saved = new Environment(client, {
        id: "new-env",
        name: "New Env",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      });
      (client._create as ReturnType<typeof vi.fn>).mockResolvedValue(saved);

      await env.save();

      expect(client._create).toHaveBeenCalledWith(env);
      expect(env.createdAt).toBe("2026-04-01T00:00:00Z");
    });
  });

  describe("save() — update path (createdAt set)", () => {
    it("should call _update and apply result", async () => {
      const client = mockEnvsClient();
      const env = new Environment(client, {
        id: "production",
        name: "Production",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-01T10:00:00Z",
      });
      const updated = new Environment(client, {
        id: "production",
        name: "Production Updated",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-02T10:00:00Z",
      });
      (client._update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

      await env.save();

      expect(client._update).toHaveBeenCalledWith(env);
      expect(env.name).toBe("Production Updated");
    });
  });

  describe("save() — no client", () => {
    it("should throw when client is null", async () => {
      const env = new Environment(null, {
        id: "x",
        name: "X",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: null,
        updatedAt: null,
      });
      await expect(env.save()).rejects.toThrow("cannot save");
    });
  });

  describe("_apply()", () => {
    it("should copy all fields from another Environment", () => {
      const env = makeEnv({ id: "old" });
      const other = makeEnv({
        id: "new-env",
        name: "New Name",
        color: "#00ff00",
        classification: EnvironmentClassification.AD_HOC,
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      });
      env._apply(other);
      expect(env.id).toBe("new-env");
      expect(env.name).toBe("New Name");
      expect(env.color).toBe("#00ff00");
      expect(env.classification).toBe(EnvironmentClassification.AD_HOC);
      expect(env.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(env.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("toString()", () => {
    it("should return a human-readable representation", () => {
      const env = makeEnv();
      expect(env.toString()).toBe(
        "Environment(id=production, name=Production, classification=STANDARD)",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// ContextType
// ---------------------------------------------------------------------------

describe("ContextType", () => {
  function makeCt(
    overrides: Partial<ConstructorParameters<typeof ContextType>[1]> = {},
  ): ContextType {
    return new ContextType(mockCtClient(), {
      id: "user",
      name: "User",
      attributes: { plan: {}, region: {} },
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:00:00Z",
      ...overrides,
    });
  }

  describe("constructor", () => {
    it("should set all fields", () => {
      const ct = makeCt();
      expect(ct.id).toBe("user");
      expect(ct.name).toBe("User");
      expect(ct.attributes).toEqual({ plan: {}, region: {} });
      expect(ct.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(ct.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("should shallow-copy attributes", () => {
      const attrs = { plan: {} };
      const ct = makeCt({ attributes: attrs });
      attrs["extra"] = {};
      expect(ct.attributes).not.toHaveProperty("extra");
    });
  });

  describe("addAttribute()", () => {
    it("should add a new attribute", () => {
      const ct = makeCt({ attributes: {} });
      ct.addAttribute("tier");
      expect(ct.attributes).toHaveProperty("tier");
      expect(ct.attributes.tier).toEqual({});
    });

    it("should accept metadata object", () => {
      const ct = makeCt({ attributes: {} });
      ct.addAttribute("plan", { label: "Plan" });
      expect(ct.attributes.plan).toEqual({ label: "Plan" });
    });

    it("should preserve existing attributes", () => {
      const ct = makeCt({ attributes: { plan: {} } });
      ct.addAttribute("region");
      expect(ct.attributes.plan).toEqual({});
      expect(ct.attributes.region).toEqual({});
    });
  });

  describe("removeAttribute()", () => {
    it("should remove an existing attribute", () => {
      const ct = makeCt({ attributes: { plan: {}, region: {} } });
      ct.removeAttribute("plan");
      expect(ct.attributes).not.toHaveProperty("plan");
      expect(ct.attributes.region).toEqual({});
    });

    it("should be a no-op for non-existent attribute", () => {
      const ct = makeCt({ attributes: { plan: {} } });
      ct.removeAttribute("tier");
      expect(ct.attributes).toEqual({ plan: {} });
    });
  });

  describe("updateAttribute()", () => {
    it("should replace metadata for an existing attribute", () => {
      const ct = makeCt({ attributes: { plan: { label: "Old" } } });
      ct.updateAttribute("plan", { label: "New", required: true });
      expect(ct.attributes.plan).toEqual({ label: "New", required: true });
    });

    it("should add the attribute if not present", () => {
      const ct = makeCt({ attributes: {} });
      ct.updateAttribute("tier", { values: ["free", "pro"] });
      expect(ct.attributes.tier).toEqual({ values: ["free", "pro"] });
    });
  });

  describe("save() — create path (createdAt === null)", () => {
    it("should call _create and apply result", async () => {
      const client = mockCtClient();
      const ct = new ContextType(client, {
        id: "user",
        name: "User",
        attributes: {},
        createdAt: null,
        updatedAt: null,
      });
      const saved = new ContextType(client, {
        id: "user",
        name: "User",
        attributes: {},
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      });
      (client._create as ReturnType<typeof vi.fn>).mockResolvedValue(saved);

      await ct.save();

      expect(client._create).toHaveBeenCalledWith(ct);
      expect(ct.createdAt).toBe("2026-04-01T00:00:00Z");
    });
  });

  describe("save() — update path (createdAt set)", () => {
    it("should call _update and apply result", async () => {
      const client = mockCtClient();
      const ct = new ContextType(client, {
        id: "user",
        name: "User",
        attributes: {},
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-01T10:00:00Z",
      });
      const updated = new ContextType(client, {
        id: "user",
        name: "Updated User",
        attributes: {},
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-02T10:00:00Z",
      });
      (client._update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);

      await ct.save();

      expect(client._update).toHaveBeenCalledWith(ct);
      expect(ct.name).toBe("Updated User");
    });
  });

  describe("save() — no client", () => {
    it("should throw when client is null", async () => {
      const ct = new ContextType(null, {
        id: "x",
        name: "X",
        attributes: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(ct.save()).rejects.toThrow("cannot save");
    });
  });

  describe("_apply()", () => {
    it("should copy all fields from another ContextType", () => {
      const ct = makeCt({ id: "old" });
      const other = makeCt({
        id: "account",
        name: "Account",
        attributes: { tier: { label: "Tier" } },
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      });
      ct._apply(other);
      expect(ct.id).toBe("account");
      expect(ct.name).toBe("Account");
      expect(ct.attributes).toEqual({ tier: { label: "Tier" } });
    });
  });

  describe("toString()", () => {
    it("should return a human-readable representation", () => {
      const ct = makeCt();
      expect(ct.toString()).toBe("ContextType(id=user, name=User)");
    });
  });
});

// ---------------------------------------------------------------------------
// ContextEntity
// ---------------------------------------------------------------------------

describe("ContextEntity", () => {
  function makeEntity(
    overrides: Partial<ConstructorParameters<typeof ContextEntity>[0]> = {},
  ): ContextEntity {
    return new ContextEntity({
      type: "user",
      key: "u-123",
      name: "Alice",
      attributes: { plan: "enterprise" },
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:00:00Z",
      ...overrides,
    });
  }

  describe("constructor", () => {
    it("should set all fields", () => {
      const entity = makeEntity();
      expect(entity.type).toBe("user");
      expect(entity.key).toBe("u-123");
      expect(entity.name).toBe("Alice");
      expect(entity.attributes).toEqual({ plan: "enterprise" });
      expect(entity.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(entity.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("should shallow-copy attributes", () => {
      const attrs = { plan: "free" };
      const entity = makeEntity({ attributes: attrs });
      attrs["extra"] = "x";
      expect(entity.attributes).not.toHaveProperty("extra");
    });

    it("should accept null name", () => {
      const entity = makeEntity({ name: null });
      expect(entity.name).toBeNull();
    });
  });

  describe("id getter", () => {
    it("should return composite type:key id", () => {
      const entity = makeEntity({ type: "account", key: "a-456" });
      expect(entity.id).toBe("account:a-456");
    });

    it("should handle key containing colons", () => {
      const entity = makeEntity({ type: "user", key: "u:123:abc" });
      expect(entity.id).toBe("user:u:123:abc");
    });
  });

  describe("toString()", () => {
    it("should return a human-readable representation", () => {
      const entity = makeEntity();
      expect(entity.toString()).toBe("ContextEntity(type=user, key=u-123)");
    });
  });
});

// ---------------------------------------------------------------------------
// AccountSettings
// ---------------------------------------------------------------------------

describe("AccountSettings", () => {
  function makeSettings(data: Record<string, unknown> = {}): AccountSettings {
    return new AccountSettings(mockSettingsClient(), data);
  }

  describe("constructor", () => {
    it("should store initial data", () => {
      const settings = makeSettings({ environment_order: ["production", "staging"] });
      expect(settings.environmentOrder).toEqual(["production", "staging"]);
    });
  });

  describe("raw getter/setter", () => {
    it("should return the raw data dict", () => {
      const settings = makeSettings({ foo: "bar" });
      expect(settings.raw).toEqual({ foo: "bar" });
    });

    it("should replace the data dict via setter", () => {
      const settings = makeSettings({ foo: "bar" });
      settings.raw = { baz: "qux" };
      expect(settings.raw).toEqual({ baz: "qux" });
      expect(settings.raw).not.toHaveProperty("foo");
    });
  });

  describe("environmentOrder getter/setter", () => {
    it("should return empty array when unset", () => {
      const settings = makeSettings({});
      expect(settings.environmentOrder).toEqual([]);
    });

    it("should return the environment order", () => {
      const settings = makeSettings({ environment_order: ["production", "staging"] });
      expect(settings.environmentOrder).toEqual(["production", "staging"]);
    });

    it("should set the environment order", () => {
      const settings = makeSettings({});
      settings.environmentOrder = ["development", "production"];
      expect(settings.environmentOrder).toEqual(["development", "production"]);
    });

    it("should return a copy (mutations do not affect internal state)", () => {
      const settings = makeSettings({ environment_order: ["production"] });
      const order = settings.environmentOrder;
      order.push("staging");
      expect(settings.environmentOrder).toEqual(["production"]);
    });
  });

  describe("save()", () => {
    it("should call _save with raw data and apply result", async () => {
      const client = mockSettingsClient();
      const settings = new AccountSettings(client, { environment_order: ["production"] });
      const savedSettings = new AccountSettings(client, {
        environment_order: ["production", "staging"],
      });
      (client._save as ReturnType<typeof vi.fn>).mockResolvedValue(savedSettings);

      await settings.save();

      expect(client._save).toHaveBeenCalledWith({ environment_order: ["production"] });
      expect(settings.environmentOrder).toEqual(["production", "staging"]);
    });
  });

  describe("save() — no client", () => {
    it("should throw when client is null", async () => {
      const settings = new AccountSettings(null, {});
      await expect(settings.save()).rejects.toThrow("cannot save");
    });
  });

  describe("_rawData getter", () => {
    it("should expose internal data for _save()", () => {
      const settings = makeSettings({ environment_order: ["production"] });
      expect(settings._rawData).toEqual({ environment_order: ["production"] });
    });
  });

  describe("_apply()", () => {
    it("should replace internal data from another AccountSettings", () => {
      const client = mockSettingsClient();
      const settings = new AccountSettings(client, { environment_order: ["production"] });
      const other = new AccountSettings(client, { environment_order: ["staging", "production"] });
      settings._apply(other);
      expect(settings.environmentOrder).toEqual(["staging", "production"]);
    });
  });

  describe("toString()", () => {
    it("should return JSON representation", () => {
      const settings = makeSettings({ environment_order: ["production"] });
      expect(settings.toString()).toBe('AccountSettings({"environment_order":["production"]})');
    });
  });
});
