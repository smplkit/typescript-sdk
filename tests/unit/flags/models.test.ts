/**
 * Tests for Flag, BooleanFlag, StringFlag, NumberFlag, JsonFlag — model
 * methods and runtime-client save/delete guards.
 *
 * Management/CRUD on flags lives in tests/unit/management/management_flags.test.ts.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FlagsClient } from "../../../src/flags/client.js";
import { Flag, FlagRule, FlagEnvironment } from "../../../src/flags/models.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

type WsCallback = (data: Record<string, unknown>) => void;

interface MockSharedWs {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  connectionStatus: string;
  _listeners: Record<string, WsCallback[]>;
  _emit: (event: string, data: Record<string, unknown>) => void;
}

function createMockSharedWs(): MockSharedWs {
  const listeners: Record<string, WsCallback[]> = {};
  return {
    on: vi.fn((event: string, cb: WsCallback) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    off: vi.fn((event: string, cb: WsCallback) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== cb);
      }
    }),
    connectionStatus: "connected",
    _listeners: listeners,
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
  };
}

function makeFlagsClient(): FlagsClient {
  const ws = createMockSharedWs();
  return new FlagsClient(API_KEY, () => ws as never, 30000);
}

/** Build a FlagEnvironment from a plain dict shape. */
function makeEnv(fields: {
  enabled?: boolean;
  default?: unknown;
  rules?: Array<{ description?: string; logic?: Record<string, unknown>; value: unknown }>;
}): FlagEnvironment {
  return new FlagEnvironment({
    enabled: fields.enabled ?? true,
    default: fields.default,
    rules: (fields.rules ?? []).map(
      (r) =>
        new FlagRule({
          logic: r.logic ?? {},
          value: r.value,
          description: r.description ?? null,
        }),
    ),
  });
}

// ---------------------------------------------------------------------------
// Save / delete guards
// ---------------------------------------------------------------------------

describe("Flag.save() / Flag.delete() guards", () => {
  it("save() should throw when client is null", async () => {
    const flag = new Flag(null, {
      id: "x",
      name: "X",
      type: "BOOLEAN",
      default: false,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    await expect(flag.save()).rejects.toThrow("cannot save");
  });

  it("delete() should throw when client is null", async () => {
    const flag = new Flag(null, {
      id: "x",
      name: "X",
      type: "BOOLEAN",
      default: false,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    await expect(flag.delete()).rejects.toThrow("cannot delete");
  });

  it("delete() should throw when id is null", async () => {
    const client = makeFlagsClient();
    const flag = new Flag(client, {
      id: null,
      name: "X",
      type: "BOOLEAN",
      default: false,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    await expect(flag.delete()).rejects.toThrow("cannot delete");
  });

  it("save() (create flow) should throw on runtime FlagsClient handles", async () => {
    const client = makeFlagsClient();
    const flag = client.booleanFlag("rt", true);
    flag.createdAt = null;
    await expect(flag.save()).rejects.toThrow(/cannot be saved/);
  });

  it("save() (update flow) should throw on runtime FlagsClient handles", async () => {
    const client = makeFlagsClient();
    const flag = client.booleanFlag("rt", true);
    flag.createdAt = "2024-01-01T00:00:00Z";
    await expect(flag.save()).rejects.toThrow(/cannot be saved/);
  });

  it("delete() should throw on runtime FlagsClient handles", async () => {
    const client = makeFlagsClient();
    const flag = client.booleanFlag("rt", true);
    await expect(flag.delete()).rejects.toThrow(/cannot be deleted/);
  });
});

// ---------------------------------------------------------------------------
// Flag local mutations (sync, no client interaction)
// ---------------------------------------------------------------------------

describe("Flag local mutations", () => {
  function makeFlag(overrides?: Partial<ConstructorParameters<typeof Flag>[1]>): Flag {
    return new Flag(null, {
      id: "my-flag",
      name: "My Flag",
      type: "BOOLEAN",
      default: false,
      values: [
        { name: "True", value: true },
        { name: "False", value: false },
      ],
      description: "test",
      environments: {},
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      ...overrides,
    });
  }

  describe("addRule", () => {
    it("should be synchronous and return this for chaining", () => {
      const flag = makeFlag();
      const result = flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: { "==": [{ var: "user.plan" }, "enterprise"] },
        value: true,
      });
      expect(result).toBe(flag);
    });

    it("should mutate environments locally", () => {
      const flag = makeFlag();
      flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: { "==": [{ var: "user.plan" }, "enterprise"] },
        value: true,
      });

      expect(flag.environments.staging).toBeDefined();
      expect(flag.environments.staging.rules).toHaveLength(1);
      expect(flag.environments.staging.rules[0].description).toBe("rule 1");
    });

    it("should append to existing rules", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({
            enabled: true,
            rules: [{ description: "existing", logic: {}, value: true }],
          }),
        },
      });

      flag.addRule({
        environment: "staging",
        description: "rule 2",
        logic: { "==": [{ var: "user.plan" }, "free"] },
        value: false,
      });

      expect(flag.environments.staging.rules).toHaveLength(2);
      expect(flag.environments.staging.rules[0].description).toBe("existing");
      expect(flag.environments.staging.rules[1].description).toBe("rule 2");
    });

    it("should strip the environment key from the stored rule", () => {
      const flag = makeFlag();
      flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: {},
        value: true,
      });

      const storedRule = flag.environments.staging.rules[0];
      expect(storedRule).not.toHaveProperty("environment");
    });

    it("should throw if built rule has no environment key", () => {
      const flag = makeFlag();
      expect(() => flag.addRule({ description: "no env", logic: {}, value: true })).toThrow(
        "Built rule must include 'environment' key",
      );
    });

    it("should create environment with enabled: true when environment does not exist", () => {
      const flag = makeFlag();
      flag.addRule({
        environment: "production",
        description: "rule 1",
        logic: {},
        value: true,
      });
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("should support chaining multiple addRule calls", () => {
      const flag = makeFlag();
      flag
        .addRule({
          environment: "staging",
          description: "rule 1",
          logic: { "==": [{ var: "user.plan" }, "enterprise"] },
          value: true,
        })
        .addRule({
          environment: "staging",
          description: "rule 2",
          logic: { "==": [{ var: "user.plan" }, "pro"] },
          value: true,
        });

      expect(flag.environments.staging.rules).toHaveLength(2);
    });
  });

  describe("enableRules / disableRules", () => {
    it("should enable an environment", () => {
      const flag = makeFlag();
      flag.enableRules({ environment: "staging" });
      expect(flag.environments.staging.enabled).toBe(true);
    });

    it("should enable rules across all environments when no environment is specified", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ enabled: false, rules: [] }),
          production: makeEnv({ enabled: false, rules: [] }),
        },
      });
      flag.enableRules();
      expect(flag.environments.staging.enabled).toBe(true);
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("should disable an environment", () => {
      const flag = makeFlag({
        environments: { staging: makeEnv({ enabled: true, rules: [] }) },
      });
      flag.disableRules({ environment: "staging" });
      expect(flag.environments.staging.enabled).toBe(false);
    });

    it("should disable rules across all environments when no environment is specified", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ enabled: true, rules: [] }),
          production: makeEnv({ enabled: true, rules: [] }),
        },
      });
      flag.disableRules();
      expect(flag.environments.staging.enabled).toBe(false);
      expect(flag.environments.production.enabled).toBe(false);
    });

    it("should create environment if it does not exist", () => {
      const flag = makeFlag();
      flag.enableRules({ environment: "production" });
      expect(flag.environments.production).toBeDefined();
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("should preserve existing rules when toggling", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({
            enabled: true,
            rules: [{ description: "r1", logic: {}, value: true }],
          }),
        },
      });
      flag.disableRules({ environment: "staging" });
      expect(flag.environments.staging.rules).toHaveLength(1);
      expect(flag.environments.staging.enabled).toBe(false);
    });
  });

  describe("setDefault with environment option", () => {
    it("should set the default value for an environment", () => {
      const flag = makeFlag();
      flag.setDefault(true, { environment: "staging" });
      expect(flag.environments.staging.default).toBe(true);
    });

    it("should set the flag-level default when no environment option is given", () => {
      const flag = makeFlag({ default: false });
      flag.setDefault(true);
      expect(flag.default).toBe(true);
    });

    it("should create environment if it does not exist", () => {
      const flag = makeFlag();
      flag.setDefault("blue", { environment: "production" });
      expect(flag.environments.production).toBeDefined();
      expect(flag.environments.production.default).toBe("blue");
    });

    it("should update existing environment default", () => {
      const flag = makeFlag({
        environments: { staging: makeEnv({ enabled: true, default: "red", rules: [] }) },
      });
      flag.setDefault("green", { environment: "staging" });
      expect(flag.environments.staging.default).toBe("green");
    });
  });

  describe("clearDefault", () => {
    it("should clear the per-environment default", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ enabled: true, default: "red", rules: [] }),
        },
      });

      flag.clearDefault({ environment: "staging" });
      expect(flag.environments.staging.default).toBeNull();
    });

    it("should be a no-op for a non-existent environment", () => {
      const flag = makeFlag();
      flag.clearDefault({ environment: "no-such-env" });
      // The environment was never created.
      expect(flag.environments).not.toHaveProperty("no-such-env");
    });
  });

  describe("clearRules", () => {
    it("should clear rules across all environments when no environment option is given", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({
            enabled: true,
            rules: [{ description: "s1", logic: {}, value: true }],
          }),
          production: makeEnv({
            enabled: true,
            rules: [{ description: "p1", logic: {}, value: false }],
          }),
        },
      });

      flag.clearRules();

      expect(flag.environments.staging.rules).toEqual([]);
      expect(flag.environments.production.rules).toEqual([]);
    });

    it("should clear rules for a specific environment", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({
            enabled: true,
            rules: [
              { description: "r1", logic: {}, value: true },
              { description: "r2", logic: {}, value: false },
            ],
          }),
        },
      });

      flag.clearRules({ environment: "staging" });
      expect(flag.environments.staging.rules).toEqual([]);
    });

    it("should preserve the enabled state", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({
            enabled: true,
            rules: [{ description: "r1", logic: {}, value: true }],
          }),
        },
      });

      flag.clearRules({ environment: "staging" });
      expect(flag.environments.staging.enabled).toBe(true);
    });

    it("should be a no-op for a non-existent environment", () => {
      const flag = makeFlag();
      // Should not throw
      flag.clearRules({ environment: "nonexistent" });
      // clearRules creates an empty FlagEnvironment for the missing env per source semantics
      expect(flag.environments.nonexistent.rules).toEqual([]);
    });

    it("should not affect other environments", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({
            enabled: true,
            rules: [{ description: "s1", logic: {}, value: true }],
          }),
          production: makeEnv({
            enabled: true,
            rules: [{ description: "p1", logic: {}, value: false }],
          }),
        },
      });

      flag.clearRules({ environment: "staging" });
      expect(flag.environments.staging.rules).toEqual([]);
      expect(flag.environments.production.rules).toHaveLength(1);
    });
  });

  describe("addValue / removeValue / clearValues", () => {
    it("addValue should append a new FlagValue", () => {
      const flag = makeFlag({ values: null });
      flag.addValue("On", true);
      flag.addValue("Off", false);
      expect(flag.values).toHaveLength(2);
      expect(flag.values?.[0]).toMatchObject({ name: "On", value: true });
    });

    it("removeValue should drop entries matching the given value", () => {
      const flag = makeFlag();
      flag.removeValue(true);
      expect(flag.values).toHaveLength(1);
      expect(flag.values?.[0].value).toBe(false);
    });

    it("removeValue is a no-op when values is null", () => {
      const flag = makeFlag({ values: null });
      const result = flag.removeValue(true);
      expect(result).toBe(flag);
      expect(flag.values).toBeNull();
    });

    it("clearValues should set values to null (unconstrained)", () => {
      const flag = makeFlag();
      flag.clearValues();
      expect(flag.values).toBeNull();
    });
  });

  describe("toString", () => {
    it("should produce a readable string", () => {
      const flag = makeFlag();
      expect(flag.toString()).toBe("Flag(id=my-flag, type=BOOLEAN, default=false)");
    });
  });

  describe("_apply", () => {
    it("should copy all fields from another Flag instance", () => {
      const flag = new Flag(null, {
        id: "a",
        name: "A",
        type: "BOOLEAN",
        default: false,
        values: [],
        description: null,
        environments: {},
        createdAt: null,
        updatedAt: null,
      });

      const other = new Flag(null, {
        id: "a",
        name: "Updated A",
        type: "BOOLEAN",
        default: true,
        values: [{ name: "T", value: true }],
        description: "Updated",
        environments: { staging: makeEnv({ enabled: true, rules: [] }) },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
      });

      flag._apply(other);

      expect(flag.id).toBe("a");
      expect(flag.name).toBe("Updated A");
      expect(flag.default).toBe(true);
      expect(flag.values).toHaveLength(1);
      expect(flag.description).toBe("Updated");
      expect(flag.environments).toHaveProperty("staging");
      expect(flag.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(flag.updatedAt).toBe("2024-06-01T00:00:00Z");
    });
  });
});
