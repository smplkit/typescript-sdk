import { describe, it, expect, vi } from "vitest";
import { Environment, ContextType, Service } from "../../../src/platform/models.js";
import { EnvironmentClassification, Color } from "../../../src/platform/types.js";
import type {
  EnvironmentModelClient,
  ContextTypeModelClient,
  ServiceModelClient,
} from "../../../src/platform/models.js";

// ---------------------------------------------------------------------------
// Mock clients
// ---------------------------------------------------------------------------

function mockEnvClient(): EnvironmentModelClient {
  return {
    _create: vi.fn(),
    _update: vi.fn(),
    delete: vi.fn(),
  } as unknown as EnvironmentModelClient;
}

function mockCtClient(): ContextTypeModelClient {
  return {
    _create: vi.fn(),
    _update: vi.fn(),
    delete: vi.fn(),
  } as unknown as ContextTypeModelClient;
}

function mockSvcClient(): ServiceModelClient {
  return {
    _create: vi.fn(),
    _update: vi.fn(),
    delete: vi.fn(),
  } as unknown as ServiceModelClient;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

describe("Environment", () => {
  function makeEnv(
    overrides: Partial<ConstructorParameters<typeof Environment>[1]> = {},
  ): Environment {
    return new Environment(mockEnvClient(), {
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
    it("sets all fields", () => {
      const env = makeEnv();
      expect(env.id).toBe("production");
      expect(env.name).toBe("Production");
      expect(env.color?.hex).toBe("#ff0000");
      expect(env.classification).toBe(EnvironmentClassification.STANDARD);
      expect(env.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(env.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("stores a reference to the client", () => {
      const client = mockEnvClient();
      const env = new Environment(client, {
        id: "staging",
        name: "Staging",
        color: null,
        classification: EnvironmentClassification.AD_HOC,
      });
      expect(env._client).toBe(client);
    });

    it("accepts a Color instance directly", () => {
      const env = makeEnv({ color: new Color("#00ff00") });
      expect(env.color?.hex).toBe("#00ff00");
    });

    it("defaults createdAt/updatedAt to null when omitted", () => {
      const env = new Environment(mockEnvClient(), {
        id: "x",
        name: "X",
        classification: EnvironmentClassification.STANDARD,
      });
      expect(env.createdAt).toBeNull();
      expect(env.updatedAt).toBeNull();
      expect(env.color).toBeNull();
    });

    it("accepts null for optional fields", () => {
      const env = makeEnv({ id: null, color: null, createdAt: null, updatedAt: null });
      expect(env.id).toBeNull();
      expect(env.color).toBeNull();
      expect(env.createdAt).toBeNull();
      expect(env.updatedAt).toBeNull();
    });
  });

  describe("save() — create (createdAt === null)", () => {
    it("calls _create and applies the result", async () => {
      const client = mockEnvClient();
      const env = new Environment(client, {
        id: "new-env",
        name: "New Env",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: null,
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

  describe("save() — update (createdAt set)", () => {
    it("calls _update and applies the result", async () => {
      const client = mockEnvClient();
      const env = makeEnv();
      const updated = makeEnv({ name: "Production Updated", updatedAt: "2026-04-02T10:00:00Z" });
      (client._update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
      // rebuild env on this client so the spy is the one we assert against
      const env2 = new Environment(client, {
        id: "production",
        name: "Production",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: "2026-04-01T10:00:00Z",
      });
      await env2.save();
      expect(client._update).toHaveBeenCalledWith(env2);
      expect(env2.name).toBe("Production Updated");
      // env is unused beyond constructing; keep reference to avoid lint noise
      expect(env).toBeInstanceOf(Environment);
    });
  });

  describe("save() — no client", () => {
    it("throws when client is null", async () => {
      const env = new Environment(null, {
        id: "x",
        name: "X",
        color: null,
        classification: EnvironmentClassification.STANDARD,
      });
      await expect(env.save()).rejects.toThrow("cannot save");
    });
  });

  describe("delete()", () => {
    it("calls client.delete() with id when both present", async () => {
      const client = mockEnvClient();
      const env = new Environment(client, {
        id: "production",
        name: "Production",
        color: null,
        classification: EnvironmentClassification.STANDARD,
        createdAt: "2026-04-01T10:00:00Z",
      });
      await env.delete();
      expect(client.delete).toHaveBeenCalledWith("production");
    });

    it("throws when client is null", async () => {
      const env = new Environment(null, {
        id: "x",
        name: "X",
        color: null,
        classification: EnvironmentClassification.STANDARD,
      });
      await expect(env.delete()).rejects.toThrow("cannot delete");
    });

    it("throws when id is null", async () => {
      const env = new Environment(mockEnvClient(), {
        id: null,
        name: "X",
        color: null,
        classification: EnvironmentClassification.STANDARD,
      });
      await expect(env.delete()).rejects.toThrow("cannot delete");
    });
  });

  describe("_apply()", () => {
    it("copies all fields from another Environment", () => {
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
      expect(env.color?.hex).toBe("#00ff00");
      expect(env.classification).toBe(EnvironmentClassification.AD_HOC);
      expect(env.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(env.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("toString()", () => {
    it("returns a human-readable representation without a managed field", () => {
      const env = makeEnv();
      expect(env.toString()).toBe(
        "Environment(id=production, name=Production, classification=STANDARD)",
      );
    });
  });

  describe("color getter/setter", () => {
    it("coerces an assigned hex string to a Color instance", () => {
      const env = makeEnv({ color: null });
      env.color = "#00ff00";
      expect(env.color).toBeInstanceOf(Color);
      expect(env.color?.hex).toBe("#00ff00");
    });

    it("accepts a Color instance on assignment", () => {
      const env = makeEnv({ color: null });
      env.color = new Color("#123456");
      expect(env.color?.hex).toBe("#123456");
    });

    it("accepts null on assignment", () => {
      const env = makeEnv();
      env.color = null;
      expect(env.color).toBeNull();
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
    it("sets all fields", () => {
      const ct = makeCt();
      expect(ct.id).toBe("user");
      expect(ct.name).toBe("User");
      expect(ct.attributes).toEqual({ plan: {}, region: {} });
      expect(ct.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(ct.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("shallow-copies attributes", () => {
      const attrs = { plan: {} };
      const ct = makeCt({ attributes: attrs });
      (attrs as Record<string, unknown>).extra = {};
      expect(ct.attributes).not.toHaveProperty("extra");
    });

    it("defaults attributes to {} and timestamps to null", () => {
      const ct = new ContextType(mockCtClient(), { id: "device", name: "Device" });
      expect(ct.attributes).toEqual({});
      expect(ct.createdAt).toBeNull();
      expect(ct.updatedAt).toBeNull();
    });
  });

  describe("addAttribute()", () => {
    it("adds a new attribute with empty metadata by default", () => {
      const ct = makeCt({ attributes: {} });
      ct.addAttribute("tier");
      expect(ct.attributes.tier).toEqual({});
    });

    it("accepts a metadata object", () => {
      const ct = makeCt({ attributes: {} });
      ct.addAttribute("plan", { label: "Plan" });
      expect(ct.attributes.plan).toEqual({ label: "Plan" });
    });

    it("preserves existing attributes", () => {
      const ct = makeCt({ attributes: { plan: {} } });
      ct.addAttribute("region");
      expect(ct.attributes.plan).toEqual({});
      expect(ct.attributes.region).toEqual({});
    });
  });

  describe("removeAttribute()", () => {
    it("removes an existing attribute", () => {
      const ct = makeCt({ attributes: { plan: {}, region: {} } });
      ct.removeAttribute("plan");
      expect(ct.attributes).not.toHaveProperty("plan");
      expect(ct.attributes.region).toEqual({});
    });

    it("is a no-op for a non-existent attribute", () => {
      const ct = makeCt({ attributes: { plan: {} } });
      ct.removeAttribute("tier");
      expect(ct.attributes).toEqual({ plan: {} });
    });
  });

  describe("updateAttribute()", () => {
    it("replaces metadata for an existing attribute", () => {
      const ct = makeCt({ attributes: { plan: { label: "Old" } } });
      ct.updateAttribute("plan", { label: "New", required: true });
      expect(ct.attributes.plan).toEqual({ label: "New", required: true });
    });

    it("adds the attribute if not present", () => {
      const ct = makeCt({ attributes: {} });
      ct.updateAttribute("tier", { values: ["free", "pro"] });
      expect(ct.attributes.tier).toEqual({ values: ["free", "pro"] });
    });
  });

  describe("save()", () => {
    it("calls _create and applies the result (create path)", async () => {
      const client = mockCtClient();
      const ct = new ContextType(client, { id: "user", name: "User", attributes: {} });
      const saved = new ContextType(client, {
        id: "user",
        name: "User",
        attributes: {},
        createdAt: "2026-04-01T00:00:00Z",
      });
      (client._create as ReturnType<typeof vi.fn>).mockResolvedValue(saved);
      await ct.save();
      expect(client._create).toHaveBeenCalledWith(ct);
      expect(ct.createdAt).toBe("2026-04-01T00:00:00Z");
    });

    it("calls _update and applies the result (update path)", async () => {
      const client = mockCtClient();
      const ct = new ContextType(client, {
        id: "user",
        name: "User",
        attributes: {},
        createdAt: "2026-04-01T10:00:00Z",
      });
      const updated = new ContextType(client, {
        id: "user",
        name: "Updated User",
        attributes: {},
        createdAt: "2026-04-01T10:00:00Z",
      });
      (client._update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
      await ct.save();
      expect(client._update).toHaveBeenCalledWith(ct);
      expect(ct.name).toBe("Updated User");
    });

    it("throws when client is null", async () => {
      const ct = new ContextType(null, { id: "x", name: "X", attributes: {} });
      await expect(ct.save()).rejects.toThrow("cannot save");
    });
  });

  describe("delete()", () => {
    it("calls client.delete() with id when both present", async () => {
      const client = mockCtClient();
      const ct = new ContextType(client, {
        id: "user",
        name: "User",
        attributes: {},
        createdAt: "2026-04-01T10:00:00Z",
      });
      await ct.delete();
      expect(client.delete).toHaveBeenCalledWith("user");
    });

    it("throws when client is null", async () => {
      const ct = new ContextType(null, { id: "x", name: "X", attributes: {} });
      await expect(ct.delete()).rejects.toThrow("cannot delete");
    });

    it("throws when id is null", async () => {
      const ct = new ContextType(mockCtClient(), { id: null, name: "X", attributes: {} });
      await expect(ct.delete()).rejects.toThrow("cannot delete");
    });
  });

  describe("_apply()", () => {
    it("copies all fields from another ContextType", () => {
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
      expect(ct.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(ct.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("toString()", () => {
    it("returns a human-readable representation", () => {
      expect(makeCt().toString()).toBe("ContextType(id=user, name=User)");
    });
  });
});

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

describe("Service", () => {
  function makeSvc(overrides: Partial<ConstructorParameters<typeof Service>[1]> = {}): Service {
    return new Service(mockSvcClient(), {
      id: "user_service",
      name: "User Service",
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:00:00Z",
      ...overrides,
    });
  }

  describe("constructor", () => {
    it("sets all fields", () => {
      const svc = makeSvc();
      expect(svc.id).toBe("user_service");
      expect(svc.name).toBe("User Service");
      expect(svc.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(svc.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("stores a reference to the client", () => {
      const client = mockSvcClient();
      const svc = new Service(client, { id: "billing", name: "Billing" });
      expect(svc._client).toBe(client);
    });

    it("defaults timestamps to null when omitted", () => {
      const svc = new Service(mockSvcClient(), { id: "x", name: "X" });
      expect(svc.createdAt).toBeNull();
      expect(svc.updatedAt).toBeNull();
    });

    it("accepts null for optional fields", () => {
      const svc = makeSvc({ id: null, createdAt: null, updatedAt: null });
      expect(svc.id).toBeNull();
      expect(svc.createdAt).toBeNull();
      expect(svc.updatedAt).toBeNull();
    });
  });

  describe("save()", () => {
    it("calls _create and applies the result (create path)", async () => {
      const client = mockSvcClient();
      const svc = new Service(client, { id: "user_service", name: "User Service" });
      const saved = new Service(client, {
        id: "user_service",
        name: "User Service",
        createdAt: "2026-04-01T00:00:00Z",
      });
      (client._create as ReturnType<typeof vi.fn>).mockResolvedValue(saved);
      await svc.save();
      expect(client._create).toHaveBeenCalledWith(svc);
      expect(svc.createdAt).toBe("2026-04-01T00:00:00Z");
    });

    it("calls _update and applies the result (update path)", async () => {
      const client = mockSvcClient();
      const svc = new Service(client, {
        id: "user_service",
        name: "User Service",
        createdAt: "2026-04-01T10:00:00Z",
      });
      const updated = new Service(client, {
        id: "user_service",
        name: "User Service Updated",
        createdAt: "2026-04-01T10:00:00Z",
      });
      (client._update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
      await svc.save();
      expect(client._update).toHaveBeenCalledWith(svc);
      expect(svc.name).toBe("User Service Updated");
    });

    it("throws when client is null", async () => {
      const svc = new Service(null, { id: "x", name: "X" });
      await expect(svc.save()).rejects.toThrow("cannot save");
    });
  });

  describe("delete()", () => {
    it("calls client.delete() with id when both present", async () => {
      const client = mockSvcClient();
      const svc = new Service(client, {
        id: "user_service",
        name: "User Service",
        createdAt: "2026-04-01T10:00:00Z",
      });
      await svc.delete();
      expect(client.delete).toHaveBeenCalledWith("user_service");
    });

    it("throws when client is null", async () => {
      const svc = new Service(null, { id: "x", name: "X" });
      await expect(svc.delete()).rejects.toThrow("cannot delete");
    });

    it("throws when id is null", async () => {
      const svc = new Service(mockSvcClient(), { id: null, name: "X" });
      await expect(svc.delete()).rejects.toThrow("cannot delete");
    });
  });

  describe("_apply()", () => {
    it("copies all fields from another Service", () => {
      const svc = makeSvc({ id: "old" });
      const other = makeSvc({
        id: "new-svc",
        name: "New Name",
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      });
      svc._apply(other);
      expect(svc.id).toBe("new-svc");
      expect(svc.name).toBe("New Name");
      expect(svc.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(svc.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("toString()", () => {
    it("returns a human-readable representation", () => {
      expect(makeSvc().toString()).toBe("Service(id=user_service, name=User Service)");
    });
  });
});
