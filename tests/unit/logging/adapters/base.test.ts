import { describe, it, expect, vi } from "vitest";
import type { LoggingAdapter } from "../../../../src/logging/adapters/base.js";

describe("LoggingAdapter interface", () => {
  it("should accept a mock adapter implementing all required methods", () => {
    const adapter: LoggingAdapter = {
      name: "mock",
      discover: vi.fn(() => [{ name: "test-logger", level: "INFO" }]),
      applyLevel: vi.fn(),
      installHook: vi.fn(),
      uninstallHook: vi.fn(),
    };

    expect(adapter.name).toBe("mock");

    const discovered = adapter.discover();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toEqual({ name: "test-logger", level: "INFO" });

    adapter.applyLevel("test-logger", "DEBUG");
    expect(adapter.applyLevel).toHaveBeenCalledWith("test-logger", "DEBUG");

    const hookCb = vi.fn();
    adapter.installHook(hookCb);
    expect(adapter.installHook).toHaveBeenCalledWith(hookCb);

    adapter.uninstallHook();
    expect(adapter.uninstallHook).toHaveBeenCalledTimes(1);
  });

  it("should work with minimal adapter returning empty discovery", () => {
    const adapter: LoggingAdapter = {
      name: "empty",
      discover: () => [],
      applyLevel: () => {},
      installHook: () => {},
      uninstallHook: () => {},
    };

    expect(adapter.discover()).toEqual([]);
    expect(adapter.name).toBe("empty");
  });
});
