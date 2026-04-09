import { describe, it, expect, vi, beforeEach } from "vitest";
import { WinstonAdapter } from "../../../../src/logging/adapters/winston.js";

// ---------------------------------------------------------------------------
// Mock winston module factory
// ---------------------------------------------------------------------------

function createMockWinston() {
  const loggers = new Map<string, { level: string }>();

  const container: Record<string, unknown> = {
    loggers,
    add: (id: string, opts?: { level?: string }) => {
      const logger = { level: opts?.level ?? "info" };
      loggers.set(id, logger);
      return logger;
    },
  };

  const defaultLogger = { level: "info" };

  return {
    loggers: container,
    default: defaultLogger,
    level: "info",
    _map: loggers,
  };
}

describe("WinstonAdapter", () => {
  let mockWinston: ReturnType<typeof createMockWinston>;

  beforeEach(() => {
    mockWinston = createMockWinston();
  });

  function makeAdapter(opts?: { discoverDefault?: boolean }) {
    return new WinstonAdapter({
      discoverDefault: opts?.discoverDefault,
      _winston: mockWinston,
    });
  }

  /** Type-safe helper to call the container's add method. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function addLogger(id: string, opts?: { level?: string }): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mockWinston.loggers.add as any)(id, opts);
  }

  describe("constructor", () => {
    it("should have name 'winston'", () => {
      const adapter = makeAdapter();
      expect(adapter.name).toBe("winston");
    });

    it("should require winston when no _winston injected", () => {
      // This exercises the require("winston") fallback path.
      // winston is a devDependency so require succeeds.
      const adapter = new WinstonAdapter();
      expect(adapter.name).toBe("winston");
      // Should be able to discover (real winston module)
      expect(adapter.discover()).toBeInstanceOf(Array);
    });
  });

  describe("discover()", () => {
    it("should find existing loggers in the container", () => {
      addLogger("api-server", { level: "debug" });
      addLogger("db-layer", { level: "warn" });

      const adapter = makeAdapter();
      const discovered = adapter.discover();

      const named = discovered.filter((d) => d.name !== "__default__");
      expect(named).toHaveLength(2);
      expect(named).toContainEqual({ name: "api-server", level: "DEBUG" });
      expect(named).toContainEqual({ name: "db-layer", level: "WARN" });
    });

    it("should include the default logger when discoverDefault is true", () => {
      const adapter = makeAdapter({ discoverDefault: true });
      const discovered = adapter.discover();

      expect(discovered).toContainEqual({ name: "__default__", level: "INFO" });
    });

    it("should exclude the default logger when discoverDefault is false", () => {
      const adapter = makeAdapter({ discoverDefault: false });
      const discovered = adapter.discover();

      expect(discovered.find((d) => d.name === "__default__")).toBeUndefined();
    });

    it("should convert winston levels to smplkit levels", () => {
      addLogger("silly-logger", { level: "silly" });
      addLogger("error-logger", { level: "error" });

      const adapter = makeAdapter({ discoverDefault: false });
      const discovered = adapter.discover();

      expect(discovered).toContainEqual({ name: "silly-logger", level: "TRACE" });
      expect(discovered).toContainEqual({ name: "error-logger", level: "ERROR" });
    });
  });

  describe("applyLevel()", () => {
    it("should set the correct winston level on a named logger", () => {
      addLogger("my-logger", { level: "info" });

      const adapter = makeAdapter();
      adapter.applyLevel("my-logger", "DEBUG");

      const logger = mockWinston._map.get("my-logger")!;
      expect(logger.level).toBe("debug");
    });

    it("should set the level on the default logger", () => {
      const adapter = makeAdapter();
      adapter.applyLevel("__default__", "WARN");

      expect(mockWinston.default.level).toBe("warn");
    });

    it("should convert FATAL to error (winston has no fatal)", () => {
      addLogger("fatal-test", { level: "info" });

      const adapter = makeAdapter();
      adapter.applyLevel("fatal-test", "FATAL");

      const logger = mockWinston._map.get("fatal-test")!;
      expect(logger.level).toBe("error");
    });

    it("should not throw for unknown logger name", () => {
      const adapter = makeAdapter();
      expect(() => adapter.applyLevel("nonexistent", "DEBUG")).not.toThrow();
    });
  });

  describe("installHook()", () => {
    it("should detect new loggers added after hook installation", () => {
      const adapter = makeAdapter();
      const callback = vi.fn();

      adapter.installHook(callback);

      // Add a logger after hook — callback should fire via the patched add()
      addLogger("new-logger", { level: "debug" });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith("new-logger", "DEBUG");
    });

    it("should still return the logger from add()", () => {
      const adapter = makeAdapter();
      adapter.installHook(vi.fn());

      const logger = addLogger("test", { level: "warn" });
      expect(logger).toBeDefined();
      expect(logger.level).toBe("warn");
    });

    it("should swallow callback errors", () => {
      const adapter = makeAdapter();
      const callback = vi.fn(() => {
        throw new Error("callback boom");
      });

      adapter.installHook(callback);

      expect(() => {
        addLogger("boom-logger", { level: "info" });
      }).not.toThrow();
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("uninstallHook()", () => {
    it("should restore the original add() method", () => {
      const adapter = makeAdapter();
      const callback = vi.fn();

      adapter.installHook(callback);

      // After hook, add should trigger callback
      addLogger("during-hook", { level: "info" });
      expect(callback).toHaveBeenCalledTimes(1);

      adapter.uninstallHook();

      // After unhook, callback should not fire
      callback.mockClear();
      addLogger("after-unhook", { level: "info" });
      expect(callback).not.toHaveBeenCalled();
    });

    it("should be safe to call without prior installHook", () => {
      const adapter = makeAdapter();
      expect(() => adapter.uninstallHook()).not.toThrow();
    });
  });
});
