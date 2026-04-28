import { describe, it, expect, vi } from "vitest";
import { Logger, LogGroup } from "../../../src/logging/models.js";
import { LogLevel } from "../../../src/logging/types.js";
import type { LoggingClient } from "../../../src/logging/client.js";

/** Minimal mock of LoggingClient for model construction. */
function mockClient(): LoggingClient {
  return {
    _saveLogger: vi.fn(),
    _saveLogGroup: vi.fn(),
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
      expect(logger.environments).toEqual({ production: { level: "WARN" } });
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

  describe("setEnvironmentLevel()", () => {
    it("should set an environment-specific level", () => {
      const logger = makeLogger({ environments: {} });
      logger.setEnvironmentLevel("staging", LogLevel.DEBUG);
      expect(logger.environments).toEqual({ staging: { level: "DEBUG" } });
    });

    it("should preserve existing environment entries", () => {
      const logger = makeLogger({ environments: { production: { level: "WARN" } } });
      logger.setEnvironmentLevel("staging", LogLevel.INFO);
      expect(logger.environments.production).toEqual({ level: "WARN" });
      expect(logger.environments.staging).toEqual({ level: "INFO" });
    });

    it("should overwrite an existing environment level", () => {
      const logger = makeLogger({ environments: { production: { level: "WARN" } } });
      logger.setEnvironmentLevel("production", LogLevel.ERROR);
      expect(logger.environments.production).toEqual({ level: "ERROR" });
    });
  });

  describe("clearEnvironmentLevel()", () => {
    it("should remove the level from the specified environment", () => {
      const logger = makeLogger({ environments: { production: { level: "WARN" } } });
      logger.clearEnvironmentLevel("production");
      expect(logger.environments.production.level).toBeUndefined();
    });

    it("should be a no-op for a non-existent environment", () => {
      const logger = makeLogger({ environments: {} });
      logger.clearEnvironmentLevel("staging");
      expect(logger.environments).toEqual({});
    });

    it("should not affect other environments", () => {
      const logger = makeLogger({
        environments: {
          production: { level: "WARN" },
          staging: { level: "DEBUG" },
        },
      });
      logger.clearEnvironmentLevel("staging");
      expect(logger.environments.production).toEqual({ level: "WARN" });
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
      expect(logger.environments).toEqual({ staging: { level: "TRACE" } });
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
      key: null,
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
      expect(group.environments).toEqual({ production: { level: "ERROR" } });
      expect(group.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(group.updatedAt).toBe("2026-04-01T10:00:00Z");
    });

    it("should store a reference to the client", () => {
      const client = mockClient();
      const group = new LogGroup(client, {
        id: "test",
        key: null,
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

  describe("setEnvironmentLevel()", () => {
    it("should set an environment-specific level", () => {
      const group = makeGroup({ environments: {} });
      group.setEnvironmentLevel("staging", LogLevel.DEBUG);
      expect(group.environments).toEqual({ staging: { level: "DEBUG" } });
    });

    it("should preserve existing environment entries", () => {
      const group = makeGroup({ environments: { production: { level: "ERROR" } } });
      group.setEnvironmentLevel("staging", LogLevel.INFO);
      expect(group.environments.production).toEqual({ level: "ERROR" });
      expect(group.environments.staging).toEqual({ level: "INFO" });
    });
  });

  describe("clearEnvironmentLevel()", () => {
    it("should remove the level from the specified environment", () => {
      const group = makeGroup({ environments: { production: { level: "ERROR" } } });
      group.clearEnvironmentLevel("production");
      expect(group.environments.production.level).toBeUndefined();
    });

    it("should be a no-op for a non-existent environment", () => {
      const group = makeGroup({ environments: {} });
      group.clearEnvironmentLevel("staging");
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
      expect(group.environments).toEqual({ staging: { level: "TRACE" } });
      expect(group.createdAt).toBe("2026-05-01T00:00:00Z");
      expect(group.updatedAt).toBe("2026-05-01T00:00:00Z");
    });
  });

  describe("save()", () => {
    it("should call _saveLogGroup and apply the result", async () => {
      const client = mockClient();
      const group = new LogGroup(client, {
        id: "test-group",
        key: null,
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      const saved = new LogGroup(client, {
        id: "test-group",
        key: null,
        name: "Test Group",
        level: null,
        group: null,
        environments: {},
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      });

      (client._saveLogGroup as ReturnType<typeof vi.fn>).mockResolvedValue(saved);

      await group.save();

      expect(client._saveLogGroup).toHaveBeenCalledWith(group);
      expect(group.id).toBe("test-group");
      expect(group.createdAt).toBe("2026-04-01T00:00:00Z");
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
