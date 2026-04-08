import { describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/types.js";
import type { ConfigClient } from "../../../src/config/client.js";

/** Create a minimal mock of ConfigClient with the methods Config needs. */
function makeMockClient() {
  return {
    _apiKey: "sk_test",
    _baseUrl: "https://config.smplkit.com",
    _createConfig: vi.fn(),
    _updateConfig: vi.fn(),
    _getById: vi.fn(),
  } as unknown as ConfigClient;
}

function makeConfig(
  client: ConfigClient,
  fields?: Partial<{
    id: string | null;
    key: string;
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
    id: "cfg-1",
    key: "my-config",
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
// Constructor
// ---------------------------------------------------------------------------

describe("Config", () => {
  describe("constructor", () => {
    it("should set all fields from constructor args", () => {
      const client = makeMockClient();
      const config = makeConfig(client);

      expect(config.id).toBe("cfg-1");
      expect(config.key).toBe("my-config");
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

      expect(config.toString()).toBe("Config(id=cfg-1, key=my-config, name=My Config)");
    });

    it("should handle null id", () => {
      const client = makeMockClient();
      const config = makeConfig(client, { id: null });

      expect(config.toString()).toBe("Config(id=null, key=my-config, name=My Config)");
    });
  });

  // ---------------------------------------------------------------------------
  // save()
  // ---------------------------------------------------------------------------

  describe("save", () => {
    it("should call _createConfig when id is null and apply result", async () => {
      const client = makeMockClient();
      const savedConfig = makeConfig(client, {
        id: "new-uuid",
        createdAt: "2024-02-01T00:00:00Z",
        updatedAt: "2024-02-01T00:00:00Z",
      });
      (client._createConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(savedConfig);

      const config = makeConfig(client, { id: null });
      expect(config.id).toBeNull();

      await config.save();

      expect(client._createConfig).toHaveBeenCalledWith(config);
      expect(config.id).toBe("new-uuid");
      expect(config.createdAt).toBe("2024-02-01T00:00:00Z");
    });

    it("should call _updateConfig when id is set and apply result", async () => {
      const client = makeMockClient();
      const updatedConfig = makeConfig(client, {
        name: "Updated Name",
        updatedAt: "2024-03-01T00:00:00Z",
      });
      (client._updateConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce(updatedConfig);

      const config = makeConfig(client, { id: "existing-uuid" });

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
        key: "original-key",
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
        key: "new-key",
        name: "New Name",
        description: "New desc",
        parent: "parent-uuid",
        items: { b: 2 },
        environments: { prod: { values: { x: 1 } } },
        createdAt: "2024-02-01T00:00:00Z",
        updatedAt: "2024-02-02T00:00:00Z",
      });

      config._apply(other);

      expect(config.id).toBe("new-id");
      expect(config.key).toBe("new-key");
      expect(config.name).toBe("New Name");
      expect(config.description).toBe("New desc");
      expect(config.parent).toBe("parent-uuid");
      expect(config.items).toEqual({ b: 2 });
      expect(config.environments).toEqual({ prod: { values: { x: 1 } } });
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
      expect(chain[0].id).toBe("cfg-1");
      expect(chain[0].items).toEqual({ timeout: 30 });
      expect(client._getById).not.toHaveBeenCalled();
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
        key: "parent",
        name: "Parent",
        parent: null,
        items: { parent_val: 2 },
        environments: {},
      });

      (client._getById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(parentConfig);

      const chain = await config._buildChain();

      expect(chain).toHaveLength(2);
      expect(chain[0].id).toBe("child-id");
      expect(chain[0].items).toEqual({ child_val: 1 });
      expect(chain[1].id).toBe("parent-id");
      expect(chain[1].items).toEqual({ parent_val: 2 });
      expect(client._getById).toHaveBeenCalledWith("parent-id");
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

      (client._getById as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(child)
        .mockResolvedValueOnce(root);

      const chain = await grandchild._buildChain();

      expect(chain).toHaveLength(3);
      expect(chain[0].id).toBe("gc-id");
      expect(chain[1].id).toBe("child-id");
      expect(chain[2].id).toBe("root-id");
      expect(client._getById).toHaveBeenCalledTimes(2);
      expect(client._getById).toHaveBeenCalledWith("child-id");
      expect(client._getById).toHaveBeenCalledWith("root-id");
    });

    it("should use empty string for null id in chain entry", async () => {
      const client = makeMockClient();
      const config = makeConfig(client, {
        id: null,
        parent: null,
        items: { a: 1 },
      });

      const chain = await config._buildChain();

      expect(chain[0].id).toBe("");
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

      (client._getById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(parent);

      const chain = await config._buildChain();

      expect(chain[0].environments).toEqual({ prod: { values: { retries: 5 } } });
      expect(chain[1].environments).toEqual({ prod: { values: { timeout: 60 } } });
    });
  });
});
