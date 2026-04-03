import { describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/types.js";

/** Create a mock client that returns an updated Config from _updateConfig. */
function makeMockClient(overrides?: Partial<Config>) {
  const client = {
    _apiKey: "sk_test",
    _baseUrl: "https://config.smplkit.com",
    _updateConfig: vi.fn(),
    get: vi.fn(),
  };

  // By default, _updateConfig returns a Config with the same fields
  client._updateConfig.mockImplementation(async (payload: Record<string, unknown>) => {
    return new Config(client, {
      id: payload.configId as string,
      key: (payload.key as string) ?? "",
      name: (payload.name as string) ?? "",
      description: (payload.description as string | null) ?? null,
      parent: (payload.parent as string | null) ?? null,
      items: (payload.items as Record<string, unknown>) ?? {},
      environments: (payload.environments as Record<string, unknown>) ?? {},
      createdAt: null,
      updatedAt: new Date("2024-02-01T00:00:00Z"),
      ...overrides,
    });
  });

  return client;
}

function makeConfig(
  client: ReturnType<typeof makeMockClient>,
  fields?: Partial<{
    id: string;
    key: string;
    name: string;
    description: string | null;
    parent: string | null;
    items: Record<string, unknown>;
    environments: Record<string, unknown>;
    createdAt: Date | null;
    updatedAt: Date | null;
  }>,
) {
  return new Config(client, {
    id: "cfg-1",
    key: "my_config",
    name: "My Config",
    description: "A test config",
    parent: null,
    items: { timeout: 30 },
    environments: {},
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-02T00:00:00Z"),
    ...fields,
  });
}

describe("Config", () => {
  describe("constructor", () => {
    it("should set all fields from constructor args", () => {
      const client = makeMockClient();
      const config = makeConfig(client);
      expect(config.id).toBe("cfg-1");
      expect(config.key).toBe("my_config");
      expect(config.name).toBe("My Config");
      expect(config.description).toBe("A test config");
      expect(config.parent).toBeNull();
      expect(config.items).toEqual({ timeout: 30 });
      expect(config.environments).toEqual({});
      expect(config.createdAt).toBeInstanceOf(Date);
      expect(config.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe("toString", () => {
    it("should return a human-readable string", () => {
      const client = makeMockClient();
      const config = makeConfig(client);
      expect(config.toString()).toBe("Config(id=cfg-1, key=my_config, name=My Config)");
    });
  });

  describe("update", () => {
    it("should call _updateConfig with merged fields", async () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      await config.update({ name: "Updated Name" });

      expect(client._updateConfig).toHaveBeenCalledWith({
        configId: "cfg-1",
        name: "Updated Name",
        key: "my_config",
        description: "A test config",
        parent: null,
        items: { timeout: 30 },
        environments: {},
      });
    });

    it("should update local fields after successful update", async () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      await config.update({ name: "New Name", description: "New desc" });

      expect(config.name).toBe("New Name");
      expect(config.description).toBe("New desc");
      expect(config.updatedAt).toBeInstanceOf(Date);
    });

    it("should allow clearing description with empty string", async () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      await config.update({ description: "" });

      expect(client._updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ description: "" }),
      );
    });

    it("should replace items entirely when provided", async () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      await config.update({ items: { new_key: "new_val" } });

      expect(client._updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ items: { new_key: "new_val" } }),
      );
    });

    it("should replace environments entirely when provided", async () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      await config.update({ environments: { prod: { values: { x: 1 } } } });

      expect(client._updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ environments: { prod: { values: { x: 1 } } } }),
      );
    });
  });

  describe("setValues", () => {
    it("should replace base items when no environment is given", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, { items: { old: true } });

      await config.setValues({ new_key: "val" });

      expect(client._updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ items: { new_key: "val" } }),
      );
    });

    it("should set environment values with nested format when environment is given", async () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      await config.setValues({ retries: 5 }, "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.production).toEqual({ values: { retries: 5 } });
      // base items should be preserved
      expect(call.items).toEqual({ timeout: 30 });
    });

    it("should preserve existing environment entries when setting a different environment", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        environments: {
          staging: { values: { x: 1 } },
        },
      });

      await config.setValues({ y: 2 }, "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.staging).toEqual({ values: { x: 1 } });
      expect(call.environments.production).toEqual({ values: { y: 2 } });
    });

    it("should replace existing env values entirely", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        environments: {
          production: { values: { old_key: "old" } },
        },
      });

      await config.setValues({ new_key: "new" }, "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.production.values).toEqual({ new_key: "new" });
    });

    it("should handle null existing environment entry", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        environments: { production: null as unknown as Record<string, unknown> },
      });

      await config.setValues({ x: 1 }, "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.production).toEqual({ values: { x: 1 } });
    });

    it("should update local items/environments after success", async () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      await config.setValues({ new_val: 42 });

      expect(config.items).toEqual({ new_val: 42 });
      expect(config.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe("setValue", () => {
    it("should merge a single key into base items when no environment is given", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, { items: { a: 1 } });

      await config.setValue("b", 2);

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.items).toEqual({ a: 1, b: 2 });
    });

    it("should merge a single key into environment values", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        environments: {
          production: { values: { existing: "yes" } },
        },
      });

      await config.setValue("new_key", "val", "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.production.values).toEqual({
        existing: "yes",
        new_key: "val",
      });
    });

    it("should handle environment with no existing values", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, { environments: {} });

      await config.setValue("key", "val", "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.production).toEqual({ values: { key: "val" } });
    });

    it("should handle null environment entry for setValue", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        environments: { production: null as unknown as Record<string, unknown> },
      });

      await config.setValue("key", "val", "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.production).toEqual({ values: { key: "val" } });
    });

    it("should handle environment entry with null values sub-key", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        environments: { production: { values: null } },
      });

      await config.setValue("key", "val", "production");

      const call = client._updateConfig.mock.calls[0][0];
      expect(call.environments.production.values).toEqual({ key: "val" });
    });
  });

  describe("_buildChain", () => {
    it("should build chain for config with parent", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        id: "child-id",
        parent: "parent-id",
        items: { child_val: 1 },
        environments: {},
      });

      client.get.mockResolvedValueOnce(
        new Config(client, {
          id: "parent-id",
          key: "parent",
          name: "Parent",
          description: null,
          parent: null,
          items: { parent_val: 2 },
          environments: {},
          createdAt: null,
          updatedAt: null,
        }),
      );

      const chain = await config._buildChain();
      expect(chain).toHaveLength(2);
      expect(chain[0].id).toBe("child-id");
      expect(chain[1].id).toBe("parent-id");
      expect(client.get).toHaveBeenCalledWith({ id: "parent-id" });
    });

    it("should return single-element chain for root config", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, { parent: null });

      const chain = await config._buildChain();
      expect(chain).toHaveLength(1);
      expect(client.get).not.toHaveBeenCalled();
    });
  });
});
