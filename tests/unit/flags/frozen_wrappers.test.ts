/**
 * Tests for frozen value wrappers (rules 5 + 8 of PR #127):
 *   FlagValue, FlagRule, FlagEnvironment, ConfigEnvironment, LoggerEnvironment.
 *
 * Each is a class with `readonly` fields + `Object.freeze(this)` so that
 * customer mutation does not silently take effect.
 */

import { describe, expect, it } from "vitest";

import {
  ConfigEnvironment,
  FlagEnvironment,
  FlagRule,
  FlagValue,
  LoggerEnvironment,
  LogLevel,
} from "../../../src/index.js";

describe("FlagValue", () => {
  it("freezes the instance", () => {
    const fv = new FlagValue({ name: "Red", value: "red" });
    expect(fv.name).toBe("Red");
    expect(fv.value).toBe("red");
    expect(() => {
      // @ts-expect-error — readonly enforced
      fv.name = "Other";
    }).toThrow();
  });
});

describe("FlagRule", () => {
  it("freezes the instance and the logic dict", () => {
    const rule = new FlagRule({ logic: { "==": [{ var: "x" }, 1] }, value: true });
    expect(rule.value).toBe(true);
    expect(() => {
      // @ts-expect-error — readonly enforced
      rule.value = false;
    }).toThrow();
    expect(() => {
      (rule.logic as Record<string, unknown>)["new"] = 1;
    }).toThrow();
  });
});

describe("FlagEnvironment", () => {
  it("freezes the rules tuple — push/append blocked", () => {
    const env = new FlagEnvironment({
      enabled: true,
      default: null,
      rules: [new FlagRule({ logic: {}, value: true })],
    });
    expect(env.rules.length).toBe(1);
    expect(() => {
      (env.rules as FlagRule[]).push(new FlagRule({ logic: {}, value: false }));
    }).toThrow();
  });

  it("_replace returns a new FlagEnvironment without mutating the original", () => {
    const env = new FlagEnvironment({ enabled: true });
    const next = env._replace({ enabled: false });
    expect(env.enabled).toBe(true);
    expect(next.enabled).toBe(false);
  });
});

describe("ConfigEnvironment", () => {
  it("returns defensive copies on values / valuesRaw", () => {
    const env = new ConfigEnvironment({ host: "localhost" });
    const copy1 = env.values;
    const copy2 = env.values;
    expect(copy1).not.toBe(copy2);
    copy1["host"] = "mutated";
    expect(env.values.host).toBe("localhost");
  });

  it("normalizes plain values into typed wire entries", () => {
    const env = new ConfigEnvironment({ host: "localhost" });
    expect(env.valuesRaw.host).toEqual({ value: "localhost" });
  });

  it("preserves typed wire entries when given them", () => {
    const env = new ConfigEnvironment({
      host: { value: "localhost", type: "STRING" },
    });
    expect(env.valuesRaw.host).toEqual({ value: "localhost", type: "STRING" });
  });
});

describe("LoggerEnvironment", () => {
  it("is frozen; level is the only field", () => {
    const env = new LoggerEnvironment({ level: LogLevel.WARN });
    expect(env.level).toBe(LogLevel.WARN);
    expect(() => {
      // @ts-expect-error — readonly enforced
      env.level = LogLevel.ERROR;
    }).toThrow();
  });
});
