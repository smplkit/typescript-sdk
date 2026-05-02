import { describe, expect, it, vi } from "vitest";
import { Config, ConfigEnvironment, ConfigItem, ItemType } from "../../../src/config/types.js";
import type { ConfigModelClient } from "../../../src/config/types.js";

/** Create a minimal mock of ConfigModelClient with the methods Config needs. */
function makeMockClient() {
  return {
    _apiKey: "sk_test",
    _baseUrl: "https://config.smplkit.com",
    _createConfig: vi.fn(),
    _updateConfig: vi.fn(),
    _deleteConfig: vi.fn(),
    _fetchConfig: vi.fn(),
  } as unknown as ConfigModelClient;
}

function makeConfig(
  client: ConfigModelClient,
  fields?: Partial<{
    id: string | null;
    name: string;
    description: string | null;
    parent: string | null;
    items: Record<string, unknown>;
    environments: Record<string, unknown>;
    createdAt: string | null;
    updatedAt: string | null;
  }>,
): Config {
  return new Config(client, {
    id: "my-config",
    name: "My Config",
    description: "A test config",
    parent: null,
    items: { timeout: 30 },
    environments: {},
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-02T00:00:00Z",
    ...fields,
  });
}

// ---------------------------------------------------------------------------
// ConfigItem
// ---------------------------------------------------------------------------

describe("ConfigItem", () => {
  it("toString includes name, type, and JSON-stringified value", () => {
    const item = new ConfigItem("retries", 3, ItemType.NUMBER);
    expect(item.toString()).toBe("ConfigItem(name=retries, type=NUMBER, value=3)");
  });

  it("toString quotes strings in the JSON-stringified value", () => {
    const item = new ConfigItem("region", "us-east", ItemType.STRING);
    expect(item.toString()).toContain('value="us-east"');
  });
});

// ---------------------------------------------------------------------------
// ConfigEnvironment
// ---------------------------------------------------------------------------

describe("ConfigEnvironment", () => {
  it("toString reports the unwrapped values dict", () => {
    const env = new ConfigEnvironment({ retries: 5, timeout: 30 });
    expect(env.toString()).toBe('ConfigEnvironment(values={"retries":5,"timeout":30})');
  });
});

// ---------------------------------------------------------------------------
// Config — convertEnvironments preserves ConfigEnvironment instances
// ---------------------------------------------------------------------------

describe("convertEnvironments (via Config constructor)", () => {
  it("preserves an existing ConfigEnvironment instance unchanged", () => {
    const client = {
      _apiKey: "sk_test",
      _baseUrl: "https://config.smplkit.com",
      _createConfig: vi.fn(),
      _updateConfig: vi.fn(),
      _deleteConfig: vi.fn(),
      _fetchConfig: vi.fn(),
    } as unknown as ConfigModelClient;

    const env = new ConfigEnvironment({ retries: 5 });
    const cfg = new Config(client, {
      id: "x",
      name: "X",
      description: null,
      parent: null,
      items: {},
      environments: { production: env },
      createdAt: null,
      updatedAt: null,
    });

    expect(cfg.environments.production).toBe(env);
  });
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("Config", () => {
  describe("constructor", () => {
    it("should set all fields from constructor args", () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      expect(config.id).toBe("my-config");
      expect(config.name).toBe("My Config");
      expect(config.description).toBe("A test config");
      expect(config.parent).toBeNull();
      expect(config.items).toEqual({ timeout: 30 });
      expect(config.environments).toEqual({});
      expect(config.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(config.updatedAt).toBe("2024-01-02T00:00:00Z");
    });

    it("should accept null id for unsaved configs", () => {
      const client = makeMockClient();
      const config = makeConfig(client, { id: null });

      expect(config.id).toBeNull();
    });

    it("should accept null timestamps", () => {
      const client = makeMockClient();
      const config = makeConfig(client, { createdAt: null, updatedAt: null });

      expect(config.createdAt).toBeNull();
      expect(config.updatedAt).toBeNull();
    });

    it("should store reference to client", () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      expect(config._client).toBe(client);
    });
  });

  // ---------------------------------------------------------------------------
  // toString
  // ---------------------------------------------------------------------------

  describe("toString", () => {
    it("should return a human-readable string", () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      expect(config.toString()).toBe("Config(id=my-config, name=My Config)");
    });

    it("should handle null id", () => {
      const client = makeMockClient();
      const config = makeConfig(client, { id: null });

      expect(config.toString()).toBe("Config(id=null, name=My Config)");
    });
  });

  // ---------------------------------------------------------------------------
  // save()
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // itemsRaw getter
  // ---------------------------------------------------------------------------

  describe("itemsRaw", () => {
    it("returns a deep copy of typed items including value and type", () => {
      const client = makeMockClient();
      const config = makeConfig(client);
      config.setNumber("retries", 3, { description: "max retries" });

      const raw = config.itemsRaw;
      expect(raw.retries).toMatchObject({ value: 3, type: "NUMBER", description: "max retries" });
    });

    it("mutating the copy does not affect the underlying state", () => {
      const client = makeMockClient();
      const config = makeConfig(client);
      config.setNumber("retries", 3);
      const raw = config.itemsRaw;
      raw.retries.value = 99;
      expect(config.items.retries).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // remove()
  // ---------------------------------------------------------------------------

  describe("remove", () => {
    it("removes a top-level item", () => {
      const client = makeMockClient();
      const config = makeConfig(client);
      config.setNumber("retries", 3);
      expect(config.items).toHaveProperty("retries");
      config.remove("retries");
      expect(config.items).not.toHaveProperty("retries");
    });

    it("removes an environment-scoped override only", () => {
      const client = makeMockClient();
      const config = makeConfig(client);
      config.setNumber("retries", 3);
      config.setNumber("retries", 5, { environment: "production" });

      config.remove("retries", { environment: "production" });

      expect(config.items.retries).toBe(3);
      expect(config.environments.production.values).not.toHaveProperty("retries");
    });
  });

  // ---------------------------------------------------------------------------
  // setJson
  // ---------------------------------------------------------------------------

  describe("setJson", () => {
    it("should set a JSON-typed item", () => {
      const client = makeMockClient();
      const config = makeConfig(client, { items: {} });

      config.setJson("payload", { foo: 1, bar: [2, 3] });

      // raw stored value preserves the typed wrapper
      expect(config.items).toHaveProperty("payload");
    });

    it("should set a JSON-typed item with environment override", () => {
      const client = makeMockClient();
      const config = makeConfig(client, { items: {} });

      config.setJson("payload", { v: 1 }, { environment: "production" });

      expect(config.environments.production).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // delete()
  // ---------------------------------------------------------------------------

  describe("delete", () => {
    it("should call _deleteConfig with id when client and id are present", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, { id: "my-config" });

      await config.delete();

      expect(client._deleteConfig).toHaveBeenCalledWith("my-config");
    });

    it("should throw when client is null", async () => {
      const config = new Config(null, {
        id: "my-config",
        name: "My Config",
        description: null,
        parent: null,
        items: {},
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(config.delete()).rejects.toThrow("cannot delete");
    });

    it("should throw when id is null", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, { id: null });
      await expect(config.delete()).rejects.toThrow("cannot delete");
    });
  });

  // ---------------------------------------------------------------------------
  // save() — no client
  // ---------------------------------------------------------------------------

  describe("save() — no client", () => {
    it("should throw when client is null", async () => {
      const config = new Config(null, {
        id: null,
        name: "Untethered",
        description: null,
        parent: null,
        items: {},
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(config.save()).rejects.toThrow("cannot save");
    });
  });

  describe("save", () => {
    it("should call _createConfig when createdAt is null and apply result", async () => {
      const client = makeMockClient();
      const savedConfig = makeConfig(client, {
        id: "new-config",
        createdAt: "2024-02-01T00:00:00Z",
        updatedAt: "2024-02-01T00:00:00Z",
      });
      (client._createConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(savedConfig);

      const config = makeConfig(client, { id: "new-config", createdAt: null });
      expect(config.createdAt).toBeNull();

      await config.save();

      expect(client._createConfig).toHaveBeenCalledWith(config);
      expect(config.id).toBe("new-config");
      expect(config.createdAt).toBe("2024-02-01T00:00:00Z");
    });

    it("should call _updateConfig when createdAt is set and apply result", async () => {
      const client = makeMockClient();
      const updatedConfig = makeConfig(client, {
        name: "Updated Name",
        updatedAt: "2024-03-01T00:00:00Z",
      });
      (client._updateConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedConfig);

      const config = makeConfig(client, { id: "existing-config" });

      await config.save();

      expect(client._updateConfig).toHaveBeenCalledWith(config);
      expect(config.name).toBe("Updated Name");
      expect(config.updatedAt).toBe("2024-03-01T00:00:00Z");
    });
  });

  // ---------------------------------------------------------------------------
  // _apply()
  // ---------------------------------------------------------------------------

  describe("_apply", () => {
    it("should copy all fields from another Config", () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        id: "original-id",
        name: "Original",
        description: "Original desc",
        parent: null,
        items: { a: 1 },
        environments: {},
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });

      const other = makeConfig(client, {
        id: "new-id",
        name: "New Name",
        description: "New desc",
        parent: "parent-id",
        items: { b: 2 },
        environments: { prod: { values: { x: 1 } } },
        createdAt: "2024-02-01T00:00:00Z",
        updatedAt: "2024-02-02T00:00:00Z",
      });

      config._apply(other);

      expect(config.id).toBe("new-id");
      expect(config.name).toBe("New Name");
      expect(config.description).toBe("New desc");
      expect(config.parent).toBe("parent-id");
      expect(config.items).toEqual({ b: 2 });
      // environments is now a Record<string, ConfigEnvironment>; check the env's values
      expect(Object.keys(config.environments)).toEqual(["prod"]);
      expect(config.environments.prod).toBeInstanceOf(ConfigEnvironment);
      expect(config.environments.prod.values).toEqual({ x: 1 });
      expect(config.createdAt).toBe("2024-02-01T00:00:00Z");
      expect(config.updatedAt).toBe("2024-02-02T00:00:00Z");
    });

    it("should handle applying config with null fields", () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      const other = makeConfig(client, {
        id: null,
        description: null,
        parent: null,
        createdAt: null,
        updatedAt: null,
      });

      config._apply(other);

      expect(config.id).toBeNull();
      expect(config.description).toBeNull();
      expect(config.parent).toBeNull();
      expect(config.createdAt).toBeNull();
      expect(config.updatedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // _buildChain()
  // ---------------------------------------------------------------------------

  describe("_buildChain", () => {
    it("should return single-element chain for root config (no parent)", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, { parent: null });

      const chain = await config._buildChain();

      expect(chain).toHaveLength(1);
      expect(chain[0].id).toBe("my-config");
      // chain returns wire-format items: {key: {value: raw, type?: ItemType}}
      expect(chain[0].items).toEqual({ timeout: { value: 30 } });
      expect(client._fetchConfig).not.toHaveBeenCalled();
    });

    it("should walk single-parent chain", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        id: "child-id",
        parent: "parent-id",
        items: { child_val: 1 },
        environments: {},
      });

      const parentConfig = makeConfig(client, {
        id: "parent-id",
        name: "Parent",
        parent: null,
        items: { parent_val: 2 },
        environments: {},
      });

      (client._fetchConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(parentConfig);

      const chain = await config._buildChain();

      expect(chain).toHaveLength(2);
      expect(chain[0].id).toBe("child-id");
      expect(chain[0].items).toEqual({ child_val: { value: 1 } });
      expect(chain[1].id).toBe("parent-id");
      expect(chain[1].items).toEqual({ parent_val: { value: 2 } });
      expect(client._fetchConfig).toHaveBeenCalledWith("parent-id");
    });

    it("should use configs list for parent lookup when provided", async () => {
      const client = makeMockClient();
      const parentConfig = makeConfig(client, {
        id: "parent-id",
        name: "Parent",
        parent: null,
        items: { parent_val: 2 },
        environments: {},
      });

      const config = makeConfig(client, {
        id: "child-id",
        parent: "parent-id",
        items: { child_val: 1 },
        environments: {},
      });

      const chain = await config._buildChain([parentConfig, config]);

      expect(chain).toHaveLength(2);
      expect(chain[0].id).toBe("child-id");
      expect(chain[1].id).toBe("parent-id");
      expect(client._fetchConfig).not.toHaveBeenCalled();
    });

    it("should walk multi-level parent chain (grandchild -> child -> root)", async () => {
      const client = makeMockClient();

      const grandchild = makeConfig(client, {
        id: "gc-id",
        parent: "child-id",
        items: { level: "grandchild" },
        environments: {},
      });

      const child = makeConfig(client, {
        id: "child-id",
        parent: "root-id",
        items: { level: "child" },
        environments: {},
      });

      const root = makeConfig(client, {
        id: "root-id",
        parent: null,
        items: { level: "root" },
        environments: {},
      });

      (client._fetchConfig as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(root);

      const chain = await grandchild._buildChain();

      expect(chain).toHaveLength(3);
      expect(chain[0].id).toBe("gc-id");
      expect(chain[1].id).toBe("child-id");
      expect(chain[2].id).toBe("root-id");
      expect(client._fetchConfig).toHaveBeenCalledTimes(2);
      expect(client._fetchConfig).toHaveBeenCalledWith("child-id");
      expect(client._fetchConfig).toHaveBeenCalledWith("root-id");
    });

    it("should preserve null id in chain entry", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        id: null,
        parent: null,
        items: { a: 1 },
      });

      const chain = await config._buildChain();

      expect(chain[0].id).toBeNull();
    });

    it("should include environments in chain entries", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        id: "child-id",
        parent: "parent-id",
        items: { retries: 3 },
        environments: { prod: { values: { retries: 5 } } },
      });

      const parent = makeConfig(client, {
        id: "parent-id",
        parent: null,
        items: { timeout: 30 },
        environments: { prod: { values: { timeout: 60 } } },
      });

      (client._fetchConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(parent);

      const chain = await config._buildChain();

      // chain entries return environments in wire format: { env: { values: { key: { value: raw } } } }
      expect(chain[0].environments).toEqual({ prod: { values: { retries: { value: 5 } } } });
      expect(chain[1].environments).toEqual({ prod: { values: { timeout: { value: 60 } } } });
    });

    it("should throw when client is null and parent cannot be resolved from configs", async () => {
      const config = new Config(null, {
        id: "child-id",
        name: "Child",
        description: null,
        parent: "parent-id",
        items: { x: 1 },
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      await expect(config._buildChain()).rejects.toThrow(
        /cannot resolve parent config .* without a client/,
      );
    });

    it("should not throw when parent is supplied via configs list (no client needed)", async () => {
      const parent = new Config(null, {
        id: "parent-id",
        name: "Parent",
        description: null,
        parent: null,
        items: { y: 2 },
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      const config = new Config(null, {
        id: "child-id",
        name: "Child",
        description: null,
        parent: "parent-id",
        items: { x: 1 },
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      const chain = await config._buildChain([parent]);

      expect(chain).toHaveLength(2);
      expect(chain[0].id).toBe("child-id");
      expect(chain[1].id).toBe("parent-id");
    });
  });
});
