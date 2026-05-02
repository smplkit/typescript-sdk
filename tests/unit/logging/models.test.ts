import { describe, it, expect, vi } from "vitest";
import { Logger, LogGroup } from "../../../src/logging/models.js";
import { LogLevel, LoggerEnvironment } from "../../../src/logging/types.js";
import type { LoggingClient } from "../../../src/logging/client.js";

/** Minimal mock of LoggingClient for model construction. */
function mockClient(): LoggingClient {
  return {
    _saveLogger: vi.fn(),
    _saveLogGroup: vi.fn(),
    _saveGroup: vi.fn(),
  } as unknown as LoggingClient;
}

// ---------------------------------------------------------------
// Logger
// ---------------------------------------------------------------

describe("Logger", () => {
  function makeLogger(overrides: Partial<ConstructorParameters<typeof Logger>[1]> = {}): Logger {
    return new Logger(mockClient(), {
      id: "sqlalchemy.engine",
      name: "SQLAlchemy Engine",
      level: LogLevel.DEBUG,
      group: null,
      managed: true,
      sources: [{ service: "api-gateway", first_observed: "2026-04-01T10:00:00Z" }],
      environments: { production: { level: "WARN" } },
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:00:00Z",
      ...overrides,
    });
  }

  describe("constructor", () => {
    it("should set all fields from the fields object", () => {
      const logger = makeLogger();
      expect(logger.id).toBe("sqlalchemy.engine");
      expect(logger.name).toBe("SQLAlchemy Engine");
      expect(logger.level).toBe(LogLevel.DEBUG);
      expect(logger.group).toBeNull();
      expect(logger.managed).toBe(true);
      expect(logger.sources).toHaveLength(1);
      expect(logger.environments.production).toBeInstanceOf(LoggerEnvironment);
      expect(logger.environments.production.level).toBe("WARN");
      expect(logger.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(logger.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("should store a reference to the client", () => {
      const client = mockClient();
      const logger = new Logger(client, {
        id: "test",
        name: "Test",
        level: null,
        group: null,
        managed: false,
        sources: [],
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      expect(logger._client).toBe(client);
    });

    it("should accept null for optional fields", () => {
      const logger = makeLogger({
        level: null,
        group: null,
        createdAt: null,
        updatedAt: null,
      });
      expect(logger.level).toBeNull();
      expect(logger.group).toBeNull();
      expect(logger.createdAt).toBeNull();
      expect(logger.updatedAt).toBeNull();
    });

    it("defaults sources to [] when omitted", () => {
      const logger = new Logger(mockClient(), {
        id: "no-sources",
        name: "No Sources",
        level: null,
        group: null,
        managed: false,
        // sources intentionally omitted to exercise the `?? []` fallback
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      expect(logger.sources).toEqual([]);
    });
  });

  describe("setLevel()", () => {
    it("should set the base level", () => {
      const logger = makeLogger({ level: null });
      logger.setLevel(LogLevel.ERROR);
      expect(logger.level).toBe(LogLevel.ERROR);
    });

    it("should overwrite an existing level", () => {
      const logger = makeLogger({ level: LogLevel.DEBUG });
      logger.setLevel(LogLevel.WARN);
      expect(logger.level).toBe(LogLevel.WARN);
    });
  });

  describe("clearLevel()", () => {
    it("should clear the base level to null", () => {
      const logger = makeLogger({ level: LogLevel.INFO });
      logger.clearLevel();
      expect(logger.level).toBeNull();
    });

    it("should be a no-op when level is already null", () => {
      const logger = makeLogger({ level: null });
      logger.clearLevel();
      expect(logger.level).toBeNull();
    });
  });

  describe("setLevel() with environment option", () => {
    it("should set an environment-specific level", () => {
      const logger = makeLogger({ environments: {} });
      logger.setLevel(LogLevel.DEBUG, { environment: "staging" });
      expect(logger.environments.staging).toBeInstanceOf(LoggerEnvironment);
      expect(logger.environments.staging.level).toBe("DEBUG");
    });

    it("should preserve existing environment entries", () => {
      const logger = makeLogger({ environments: { production: { level: "WARN" } } });
      logger.setLevel(LogLevel.INFO, { environment: "staging" });
      expect(logger.environments.production.level).toBe("WARN");
      expect(logger.environments.staging.level).toBe("INFO");
    });

    it("should overwrite an existing environment level", () => {
      const logger = makeLogger({ environments: { production: { level: "WARN" } } });
      logger.setLevel(LogLevel.ERROR, { environment: "production" });
      expect(logger.environments.production.level).toBe("ERROR");
    });
  });

  describe("clearLevel() with environment option", () => {
    it("should remove the level from the specified environment", () => {
      const logger = makeLogger({ environments: { production: { level: "WARN" } } });
      logger.clearLevel({ environment: "production" });
      expect(logger.environments.production).toBeUndefined();
    });

    it("should be a no-op for a non-existent environment", () => {
      const logger = makeLogger({ environments: {} });
      logger.clearLevel({ environment: "staging" });
      expect(logger.environments).toEqual({});
    });

    it("should not affect other environments", () => {
      const logger = makeLogger({
        environments: {
          production: { level: "WARN" },
          staging: { level: "DEBUG" },
        },
      });
      logger.clearLevel({ environment: "staging" });
      expect(logger.environments.production.level).toBe("WARN");
    });
  });

  describe("clearAllEnvironmentLevels()", () => {
    it("should clear all environment overrides", () => {
      const logger = makeLogger({
        environments: {
          production: { level: "WARN" },
          staging: { level: "DEBUG" },
        },
      });
      logger.clearAllEnvironmentLevels();
      expect(logger.environments).toEqual({});
    });

    it("should be a no-op when environments is already empty", () => {
      const logger = makeLogger({ environments: {} });
      logger.clearAllEnvironmentLevels();
      expect(logger.environments).toEqual({});
    });
  });

  describe("_apply()", () => {
    it("should copy all fields from another Logger", () => {
      const logger = makeLogger({ id: "old", level: null });
      const other = makeLogger({
        id: "new.key",
        name: "New Name",
        level: LogLevel.ERROR,
        group: "group-id",
        managed: false,
        sources: [{ service: "new-svc" }],
        environments: { staging: { level: "TRACE" } },
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      });

      logger._apply(other);

      expect(logger.id).toBe("new.key");
      expect(logger.name).toBe("New Name");
      expect(logger.level).toBe(LogLevel.ERROR);
      expect(logger.group).toBe("group-id");
      expect(logger.managed).toBe(false);
      expect(logger.sources).toEqual([{ service: "new-svc" }]);
      expect(logger.environments.staging.level).toBe("TRACE");
      expect(logger.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(logger.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("save()", () => {
    it("should call _saveLogger and apply the result", async () => {
      const client = mockClient();
      const logger = new Logger(client, {
        id: "test",
        name: "Test",
        level: null,
        group: null,
        managed: false,
        sources: [],
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      const saved = new Logger(client, {
        id: "test",
        name: "Test",
        level: null,
        group: null,
        managed: false,
        sources: [],
        environments: {},
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      });

      (client._saveLogger as ReturnType<typeof vi.fn>).mockResolvedValue(saved);

      await logger.save();

      expect(client._saveLogger).toHaveBeenCalledWith(logger);
      expect(logger.id).toBe("test");
      expect(logger.createdAt).toBe("2026-04-01T00:00:00Z");
    });

    it("should throw when client is null", async () => {
      const logger = new Logger(null, {
        id: "test",
        name: "Test",
        level: null,
        group: null,
        managed: false,
        sources: [],
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(logger.save()).rejects.toThrow("cannot save");
    });
  });

  describe("delete()", () => {
    it("should call _deleteLogger when client and id present", async () => {
      const client = mockClient();
      (client as unknown as Record<string, unknown>)._deleteLogger = vi.fn();
      const logger = new Logger(client, {
        id: "test",
        name: "Test",
        level: null,
        group: null,
        managed: false,
        sources: [],
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await logger.delete();
      expect(client._deleteLogger).toHaveBeenCalledWith("test");
    });

    it("should throw when client is null", async () => {
      const logger = new Logger(null, {
        id: "test",
        name: "Test",
        level: null,
        group: null,
        managed: false,
        sources: [],
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(logger.delete()).rejects.toThrow("cannot delete");
    });

    it("should throw when id is null", async () => {
      const client = mockClient();
      const logger = new Logger(client, {
        id: null,
        name: "Test",
        level: null,
        group: null,
        managed: false,
        sources: [],
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(logger.delete()).rejects.toThrow("cannot delete");
    });
  });

  describe("toString()", () => {
    it("should return a human-readable representation", () => {
      const logger = makeLogger({ id: "app.server", level: LogLevel.INFO });
      expect(logger.toString()).toBe("Logger(id=app.server, level=INFO)");
    });

    it("should handle null level", () => {
      const logger = makeLogger({ id: "app.db", level: null });
      expect(logger.toString()).toBe("Logger(id=app.db, level=null)");
    });
  });
});

// ---------------------------------------------------------------
// LogGroup
// ---------------------------------------------------------------

describe("LogGroup", () => {
  function makeGroup(overrides: Partial<ConstructorParameters<typeof LogGroup>[1]> = {}): LogGroup {
    return new LogGroup(mockClient(), {
      id: "database-loggers",
      name: "Database Loggers",
      level: LogLevel.WARN,
      group: null,
      environments: { production: { level: "ERROR" } },
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-01T10:00:00Z",
      ...overrides,
    });
  }

  describe("constructor", () => {
    it("should set all fields from the fields object", () => {
      const group = makeGroup();
      expect(group.id).toBe("database-loggers");
      expect(group.name).toBe("Database Loggers");
      expect(group.level).toBe(LogLevel.WARN);
      expect(group.group).toBeNull();
      expect(group.environments.production).toBeInstanceOf(LoggerEnvironment);
      expect(group.environments.production.level).toBe("ERROR");
      expect(group.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(group.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("should store a reference to the client", () => {
      const client = mockClient();
      const group = new LogGroup(client, {
        id: "test",
        name: "Test",
        level: null,
        group: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      expect(group._client).toBe(client);
    });
  });

  describe("setLevel()", () => {
    it("should set the base level", () => {
      const group = makeGroup({ level: null });
      group.setLevel(LogLevel.ERROR);
      expect(group.level).toBe(LogLevel.ERROR);
    });
  });

  describe("clearLevel()", () => {
    it("should clear the base level to null", () => {
      const group = makeGroup({ level: LogLevel.WARN });
      group.clearLevel();
      expect(group.level).toBeNull();
    });
  });

  describe("setLevel() with environment option", () => {
    it("should set an environment-specific level", () => {
      const group = makeGroup({ environments: {} });
      group.setLevel(LogLevel.DEBUG, { environment: "staging" });
      expect(group.environments.staging).toBeInstanceOf(LoggerEnvironment);
      expect(group.environments.staging.level).toBe("DEBUG");
    });

    it("should preserve existing environment entries", () => {
      const group = makeGroup({ environments: { production: { level: "ERROR" } } });
      group.setLevel(LogLevel.INFO, { environment: "staging" });
      expect(group.environments.production.level).toBe("ERROR");
      expect(group.environments.staging.level).toBe("INFO");
    });
  });

  describe("clearLevel() with environment option", () => {
    it("should remove the level from the specified environment", () => {
      const group = makeGroup({ environments: { production: { level: "ERROR" } } });
      group.clearLevel({ environment: "production" });
      expect(group.environments.production).toBeUndefined();
    });

    it("should be a no-op for a non-existent environment", () => {
      const group = makeGroup({ environments: {} });
      group.clearLevel({ environment: "staging" });
      expect(group.environments).toEqual({});
    });
  });

  describe("clearAllEnvironmentLevels()", () => {
    it("should clear all environment overrides", () => {
      const group = makeGroup({
        environments: { production: { level: "ERROR" }, staging: { level: "DEBUG" } },
      });
      group.clearAllEnvironmentLevels();
      expect(group.environments).toEqual({});
    });
  });

  describe("_apply()", () => {
    it("should copy all fields from another LogGroup", () => {
      const group = makeGroup({ id: "old" });
      const other = makeGroup({
        id: "new-group",
        name: "New Group",
        level: LogLevel.FATAL,
        group: "parent-group",
        environments: { staging: { level: "TRACE" } },
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      });

      group._apply(other);

      expect(group.id).toBe("new-group");
      expect(group.name).toBe("New Group");
      expect(group.level).toBe(LogLevel.FATAL);
      expect(group.group).toBe("parent-group");
      expect(group.environments.staging.level).toBe("TRACE");
      expect(group.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(group.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("save()", () => {
    it("should call _saveGroup and apply the result", async () => {
      const client = mockClient();
      const group = new LogGroup(client, {
        id: "test-group",
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      const saved = new LogGroup(client, {
        id: "test-group",
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      });

      (client._saveGroup as ReturnType<typeof vi.fn>).mockResolvedValue(saved);

      await group.save();

      expect(client._saveGroup).toHaveBeenCalledWith(group);
      expect(group.id).toBe("test-group");
      expect(group.createdAt).toBe("2026-04-01T00:00:00Z");
    });

    it("should throw when client is null", async () => {
      const group = new LogGroup(null, {
        id: "test-group",
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(group.save()).rejects.toThrow("cannot save");
    });
  });

  describe("delete()", () => {
    it("should call _deleteGroup with id when client and id are present", async () => {
      const client = mockClient();
      (client as unknown as Record<string, unknown>)._deleteGroup = vi.fn();
      const group = new LogGroup(client, {
        id: "test-group",
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      await group.delete();

      expect(client._deleteGroup).toHaveBeenCalledWith("test-group");
    });

    it("should throw when client is null", async () => {
      const group = new LogGroup(null, {
        id: "test-group",
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(group.delete()).rejects.toThrow("cannot delete");
    });

    it("should throw when id is null", async () => {
      const client = mockClient();
      const group = new LogGroup(client, {
        id: null,
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });
      await expect(group.delete()).rejects.toThrow("cannot delete");
    });
  });

  describe("toString()", () => {
    it("should return a human-readable representation", () => {
      const group = makeGroup({ id: "db-loggers", level: LogLevel.WARN });
      expect(group.toString()).toBe("LogGroup(id=db-loggers, level=WARN)");
    });

    it("should handle null level", () => {
      const group = makeGroup({ id: "misc", level: null });
      expect(group.toString()).toBe("LogGroup(id=misc, level=null)");
    });
  });
});
