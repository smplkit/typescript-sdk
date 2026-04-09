import { describe, it, expect, vi, beforeEach } from "vitest";
import { PinoAdapter } from "../../../../src/logging/adapters/pino.js";

// ---------------------------------------------------------------------------
// Mock pino module factory
// ---------------------------------------------------------------------------

function createMockPino() {
  const pinoFn = (opts?: Record<string, unknown>) => {
    const logger: Record<string, unknown> = {
      level: (opts?.level as string) ?? "info",
      child: (bindings: Record<string, unknown>) => {
        const childLogger: Record<string, unknown> = {
          level: logger.level,
          ...bindings,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          child: logger.child as (...args: any[]) => any,
        };
        return childLogger;
      },
    };
    // Copy name from opts if present
    if (opts?.name) {
      logger.name = opts.name;
    }
    return logger;
  };

  return pinoFn;
}

describe("PinoAdapter", () => {
  let mockPino: ReturnType<typeof createMockPino>;

  beforeEach(() => {
    mockPino = createMockPino();
  });

  function makeAdapter(opts?: { nameField?: string }) {
    return new PinoAdapter({
      nameField: opts?.nameField,
      _pino: mockPino,
    });
  }

  describe("constructor", () => {
    it("should have name 'pino'", () => {
      const adapter = makeAdapter();
      expect(adapter.name).toBe("pino");
    });

    it("should require pino when no _pino injected", () => {
      // This exercises the require("pino") fallback path.
      // pino is a devDependency so require succeeds.
      const adapter = new PinoAdapter();
      expect(adapter.name).toBe("pino");
      expect(adapter.discover()).toEqual([]);
    });
  });

  describe("discover()", () => {
    it("should return empty list (no global registry)", () => {
      const adapter = makeAdapter();
      const discovered = adapter.discover();
      expect(discovered).toEqual([]);
    });

    it("should return tracked loggers from internal registry", () => {
      const adapter = makeAdapter();

      // Manually register a logger in the internal registry
      const mockLogger = { level: "warn" };
      (adapter as any)._registry.set("alive", new WeakRef(mockLogger));

      const discovered = adapter.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toEqual({ name: "alive", level: "WARN" });
    });

    it("should remove GC'd entries during discovery", () => {
      const adapter = makeAdapter();
      const aliveLogger = { level: "warn" };
      const deadRef = { deref: () => undefined } as WeakRef<any>;

      (adapter as any)._registry.set("alive", new WeakRef(aliveLogger));
      (adapter as any)._registry.set("dead", deadRef);

      const discovered = adapter.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toEqual({ name: "alive", level: "WARN" });
      expect((adapter as any)._registry.has("dead")).toBe(false);
    });
  });

  describe("applyLevel()", () => {
    it("should set level on a tracked logger", () => {
      const adapter = makeAdapter();

      const mockLogger = { level: "info" };
      (adapter as any)._registry.set("test-logger", new WeakRef(mockLogger));

      adapter.applyLevel("test-logger", "DEBUG");
      expect(mockLogger.level).toBe("debug");
    });

    it("should convert smplkit levels to pino levels", () => {
      const adapter = makeAdapter();
      const mockLogger = { level: "info" };
      (adapter as any)._registry.set("lvl-test", new WeakRef(mockLogger));

      adapter.applyLevel("lvl-test", "TRACE");
      expect(mockLogger.level).toBe("trace");

      adapter.applyLevel("lvl-test", "FATAL");
      expect(mockLogger.level).toBe("fatal");

      adapter.applyLevel("lvl-test", "WARN");
      expect(mockLogger.level).toBe("warn");
    });

    it("should not throw for unknown logger name", () => {
      const adapter = makeAdapter();
      expect(() => adapter.applyLevel("nonexistent", "DEBUG")).not.toThrow();
    });

    it("should clean up GC'd references", () => {
      const adapter = makeAdapter();
      const deadRef = { deref: () => undefined } as WeakRef<any>;
      (adapter as any)._registry.set("gc-logger", deadRef);

      adapter.applyLevel("gc-logger", "DEBUG");

      expect((adapter as any)._registry.has("gc-logger")).toBe(false);
    });
  });

  describe("installHook()", () => {
    it("should respect custom nameField", () => {
      const adapter = makeAdapter({ nameField: "module" });
      expect((adapter as any)._nameField).toBe("module");
    });

    it("should accept hook callback without errors for plain function modules", () => {
      const adapter = makeAdapter();
      const callback = vi.fn();
      adapter.installHook(callback);

      // For plain function modules (no .default), the wrapper can't replace
      // the export. The hook still installs without error and patchChild
      // works for loggers created via the wrapped function.
      expect(adapter.discover()).toEqual([]);
    });

    it("should handle pino module with default export", () => {
      // Create a module-style pino mock with .default property
      const pinoFn = (opts?: Record<string, unknown>) => ({
        level: (opts?.level as string) ?? "info",
        name: opts?.name,
        child: (bindings: Record<string, unknown>) => ({
          level: "info",
          ...bindings,
        }),
      });
      const pinoWithDefault = { default: pinoFn };

      const adapter = new PinoAdapter({ _pino: pinoWithDefault });
      const callback = vi.fn();
      adapter.installHook(callback);

      // The wrapped function should have replaced pinoWithDefault.default
      const logger = pinoWithDefault.default({ name: "app-server", level: "warn" });
      expect(logger).toBeDefined();
      expect(callback).toHaveBeenCalledWith("app-server", "WARN");

      // Logger should be in the registry
      const discovered = adapter.discover();
      expect(discovered).toContainEqual({ name: "app-server", level: "WARN" });

      adapter.uninstallHook();

      // After unhook, the original function should be restored
      expect(pinoWithDefault.default).toBe(pinoFn);
    });

    it("should swallow callback errors during child creation", () => {
      const pinoFn = (opts?: Record<string, unknown>) => ({
        level: (opts?.level as string) ?? "info",
        name: opts?.name,
        child: (bindings: Record<string, unknown>) => ({
          level: "info",
          ...bindings,
        }),
      });
      const pinoWithDefault = { default: pinoFn };

      const adapter = new PinoAdapter({ _pino: pinoWithDefault });
      const callback = vi.fn(() => {
        throw new Error("boom");
      });
      adapter.installHook(callback);

      // Should not throw despite callback error
      expect(() => {
        pinoWithDefault.default({ name: "error-app" });
      }).not.toThrow();
      expect(callback).toHaveBeenCalledTimes(1);

      adapter.uninstallHook();
    });

    it("should swallow callback errors during child creation", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinoFn = (opts?: Record<string, unknown>): any => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logger: any = {
          level: (opts?.level as string) ?? "info",
          child: (bindings: Record<string, unknown>) => ({
            level: logger.level,
            ...bindings,
          }),
        };
        return logger;
      };
      const pinoWithDefault = { default: pinoFn };

      const adapter = new PinoAdapter({ _pino: pinoWithDefault });
      const callback = vi.fn(() => {
        throw new Error("child callback boom");
      });
      adapter.installHook(callback);

      const parent = pinoWithDefault.default({ level: "info" });
      // Creating child with name should trigger callback which throws — should be swallowed
      expect(() => {
        parent.child({ name: "boom-child" });
      }).not.toThrow();
      expect(callback).toHaveBeenCalledTimes(1);

      adapter.uninstallHook();
    });

    it("should copy properties from original pino function to wrapper", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pinoFn: any = (opts?: Record<string, unknown>) => ({
        level: (opts?.level as string) ?? "info",
        child: () => ({ level: "info" }),
      });
      pinoFn.version = "8.0.0";
      pinoFn.destination = vi.fn();

      const pinoWithDefault = { default: pinoFn };

      const adapter = new PinoAdapter({ _pino: pinoWithDefault });
      adapter.installHook(vi.fn());

      // The wrapper should have copied the properties
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((pinoWithDefault.default as any).version).toBe("8.0.0");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((pinoWithDefault.default as any).destination).toBe(pinoFn.destination);

      adapter.uninstallHook();
    });

    it("should intercept child loggers with name binding", () => {
      const pinoFn = (opts?: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const logger: any = {
          level: (opts?.level as string) ?? "info",
          child: (bindings: Record<string, unknown>) => ({
            level: logger.level,
            ...bindings,
          }),
        };
        return logger;
      };
      const pinoWithDefault = { default: pinoFn };

      const adapter = new PinoAdapter({ _pino: pinoWithDefault });
      const callback = vi.fn();
      adapter.installHook(callback);

      // Create parent logger (no name — should not trigger callback)
      const parent = pinoWithDefault.default({ level: "info" });
      expect(callback).not.toHaveBeenCalled();

      // Create child with a name binding — should trigger callback
      const child = parent.child({ name: "db-pool" });
      expect(child).toBeDefined();
      expect(callback).toHaveBeenCalledWith("db-pool", "INFO");

      adapter.uninstallHook();
    });
  });

  describe("uninstallHook()", () => {
    it("should be safe to call without prior installHook", () => {
      const adapter = makeAdapter();
      expect(() => adapter.uninstallHook()).not.toThrow();
    });

    it("should clean up after installHook", () => {
      const adapter = makeAdapter();
      adapter.installHook(vi.fn());
      expect(() => adapter.uninstallHook()).not.toThrow();
    });
  });
});
