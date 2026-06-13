/**
 * Flag model: save/delete guards + delegation, and the synchronous local
 * mutations (addRule / enableRules / setDefault / values, etc.) that stage
 * changes before `save()`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, expect, it, vi } from "vitest";
import { Flag, FlagRule, FlagEnvironment } from "../../../src/flags/models.js";

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

function makeFlag(overrides?: Partial<ConstructorParameters<typeof Flag>[1]>): Flag {
  return new Flag(null, {
    id: "my-flag",
    name: "My Flag",
    type: "BOOLEAN",
    default: false,
    values: [{ name: "True", value: true } as any, { name: "False", value: false } as any],
    description: "test",
    environments: {},
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Save / delete: guards + delegation
// ---------------------------------------------------------------------------

describe("Flag.save() / Flag.delete()", () => {
  it("save() throws when the client is null", async () => {
    const flag = makeFlag({ createdAt: null });
    await expect(flag.save()).rejects.toThrow(/cannot save/);
  });

  it("delete() throws when the client is null", async () => {
    const flag = makeFlag();
    await expect(flag.delete()).rejects.toThrow(/cannot delete/);
  });

  it("delete() throws when the id is null", async () => {
    const client = { delete: vi.fn() } as any;
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
    await expect(flag.delete()).rejects.toThrow(/cannot delete/);
  });

  it("save() (create flow) delegates to _createFlag when createdAt is null", async () => {
    const created = makeFlag({ id: "my-flag", name: "Created", createdAt: "2024-06-01T00:00:00Z" });
    const client = {
      _createFlag: vi.fn().mockResolvedValue(created),
      _updateFlag: vi.fn(),
    } as any;
    const flag = new Flag(client, {
      id: "my-flag",
      name: "Draft",
      type: "BOOLEAN",
      default: false,
      values: null,
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });

    await flag.save();

    expect(client._createFlag).toHaveBeenCalledWith(flag);
    expect(client._updateFlag).not.toHaveBeenCalled();
    expect(flag.name).toBe("Created");
    expect(flag.createdAt).toBe("2024-06-01T00:00:00Z");
  });

  it("save() (update flow) delegates to _updateFlag when createdAt is set", async () => {
    const updated = makeFlag({ name: "Updated", default: true });
    const client = {
      _createFlag: vi.fn(),
      _updateFlag: vi.fn().mockResolvedValue(updated),
    } as any;
    const flag = makeFlag({ createdAt: "2024-01-01T00:00:00Z" });
    (flag as any)._client = client;

    await flag.save();

    expect(client._updateFlag).toHaveBeenCalledWith(flag);
    expect(client._createFlag).not.toHaveBeenCalled();
    expect(flag.name).toBe("Updated");
    expect(flag.default).toBe(true);
  });

  it("delete() delegates to client.delete with the id", async () => {
    const client = { delete: vi.fn().mockResolvedValue(undefined) } as any;
    const flag = makeFlag();
    (flag as any)._client = client;
    await flag.delete();
    expect(client.delete).toHaveBeenCalledWith("my-flag");
  });
});

// ---------------------------------------------------------------------------
// Local mutations (synchronous, no client interaction)
// ---------------------------------------------------------------------------

describe("Flag local mutations", () => {
  describe("addRule", () => {
    it("is synchronous and returns this for chaining", () => {
      const flag = makeFlag();
      const result = flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: { "==": [{ var: "user.plan" }, "enterprise"] },
        value: true,
      });
      expect(result).toBe(flag);
    });

    it("mutates the environment locally", () => {
      const flag = makeFlag();
      flag.addRule({
        environment: "staging",
        description: "rule 1",
        logic: { "==": [{ var: "user.plan" }, "enterprise"] },
        value: true,
      });
      expect(flag.environments.staging.rules).toHaveLength(1);
      expect(flag.environments.staging.rules[0].description).toBe("rule 1");
    });

    it("appends to existing rules", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ rules: [{ description: "existing", logic: {}, value: true }] }),
        },
      });
      flag.addRule({
        environment: "staging",
        description: "rule 2",
        logic: { "==": [{ var: "user.plan" }, "free"] },
        value: false,
      });
      expect(flag.environments.staging.rules).toHaveLength(2);
      expect(flag.environments.staging.rules[1].description).toBe("rule 2");
    });

    it("strips the environment key off the stored rule", () => {
      const flag = makeFlag();
      flag.addRule({ environment: "staging", description: "r", logic: {}, value: true });
      expect(flag.environments.staging.rules[0]).not.toHaveProperty("environment");
    });

    it("throws when the built rule has no environment key", () => {
      const flag = makeFlag();
      expect(() => flag.addRule({ description: "no env", logic: {}, value: true })).toThrow(
        "Built rule must include 'environment' key",
      );
    });

    it("creates the environment (enabled) when it does not exist", () => {
      const flag = makeFlag();
      flag.addRule({ environment: "production", description: "r", logic: {}, value: true });
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("supports chaining multiple addRule calls", () => {
      const flag = makeFlag();
      flag
        .addRule({ environment: "staging", description: "r1", logic: {}, value: true })
        .addRule({ environment: "staging", description: "r2", logic: {}, value: true });
      expect(flag.environments.staging.rules).toHaveLength(2);
    });
  });

  describe("enableRules / disableRules", () => {
    it("enables a single environment", () => {
      const flag = makeFlag();
      flag.enableRules({ environment: "staging" });
      expect(flag.environments.staging.enabled).toBe(true);
    });

    it("enables every configured environment when none is given", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ enabled: false }),
          production: makeEnv({ enabled: false }),
        },
      });
      flag.enableRules();
      expect(flag.environments.staging.enabled).toBe(true);
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("disables a single environment", () => {
      const flag = makeFlag({ environments: { staging: makeEnv({ enabled: true }) } });
      flag.disableRules({ environment: "staging" });
      expect(flag.environments.staging.enabled).toBe(false);
    });

    it("disables every configured environment when none is given", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ enabled: true }),
          production: makeEnv({ enabled: true }),
        },
      });
      flag.disableRules();
      expect(flag.environments.staging.enabled).toBe(false);
      expect(flag.environments.production.enabled).toBe(false);
    });

    it("creates the environment if it does not exist (disable path)", () => {
      const flag = makeFlag();
      flag.disableRules({ environment: "production" });
      expect(flag.environments.production.enabled).toBe(false);
    });

    it("creates the environment if it does not exist (enable path)", () => {
      const flag = makeFlag();
      flag.enableRules({ environment: "production" });
      expect(flag.environments.production.enabled).toBe(true);
    });

    it("preserves existing rules when toggling", () => {
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

  describe("setDefault", () => {
    it("sets the environment-level default", () => {
      const flag = makeFlag();
      flag.setDefault(true, { environment: "staging" });
      expect(flag.environments.staging.default).toBe(true);
    });

    it("sets the flag-level default when no environment is given", () => {
      const flag = makeFlag({ default: false });
      flag.setDefault(true);
      expect(flag.default).toBe(true);
    });

    it("creates the environment if it does not exist", () => {
      const flag = makeFlag();
      flag.setDefault("blue", { environment: "production" });
      expect(flag.environments.production.default).toBe("blue");
    });

    it("updates an existing environment default", () => {
      const flag = makeFlag({
        environments: { staging: makeEnv({ default: "red" }) },
      });
      flag.setDefault("green", { environment: "staging" });
      expect(flag.environments.staging.default).toBe("green");
    });
  });

  describe("clearDefault", () => {
    it("clears the per-environment default", () => {
      const flag = makeFlag({ environments: { staging: makeEnv({ default: "red" }) } });
      flag.clearDefault({ environment: "staging" });
      expect(flag.environments.staging.default).toBeNull();
    });

    it("is a no-op for a non-existent environment", () => {
      const flag = makeFlag();
      flag.clearDefault({ environment: "no-such-env" });
      expect(flag.environments).not.toHaveProperty("no-such-env");
    });
  });

  describe("clearRules", () => {
    it("clears rules across all environments when none is given", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ rules: [{ description: "s1", logic: {}, value: true }] }),
          production: makeEnv({ rules: [{ description: "p1", logic: {}, value: false }] }),
        },
      });
      flag.clearRules();
      expect(flag.environments.staging.rules).toEqual([]);
      expect(flag.environments.production.rules).toEqual([]);
    });

    it("clears rules for a single environment", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({
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

    it("preserves the enabled state", () => {
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

    it("creates an empty environment for a missing env", () => {
      const flag = makeFlag();
      flag.clearRules({ environment: "nonexistent" });
      expect(flag.environments.nonexistent.rules).toEqual([]);
    });

    it("does not affect other environments", () => {
      const flag = makeFlag({
        environments: {
          staging: makeEnv({ rules: [{ description: "s1", logic: {}, value: true }] }),
          production: makeEnv({ rules: [{ description: "p1", logic: {}, value: false }] }),
        },
      });
      flag.clearRules({ environment: "staging" });
      expect(flag.environments.staging.rules).toEqual([]);
      expect(flag.environments.production.rules).toHaveLength(1);
    });
  });

  describe("addValue / removeValue / clearValues", () => {
    it("addValue appends a new FlagValue (from null)", () => {
      const flag = makeFlag({ values: null });
      flag.addValue("On", true);
      flag.addValue("Off", false);
      expect(flag.values).toHaveLength(2);
      expect(flag.values?.[0]).toMatchObject({ name: "On", value: true });
    });

    it("removeValue drops the matching entry", () => {
      const flag = makeFlag();
      flag.removeValue(true);
      expect(flag.values).toHaveLength(1);
      expect(flag.values?.[0].value).toBe(false);
    });

    it("removeValue removes only the first match, leaving later duplicates intact", () => {
      const flag = makeFlag({
        values: [
          { name: "First", value: true } as any,
          { name: "Middle", value: false } as any,
          { name: "Second", value: true } as any,
        ],
      });
      flag.removeValue(true);
      // Only the first `true` (named "First") is dropped; the later one survives.
      expect(flag.values).toHaveLength(2);
      expect(flag.values?.map((v) => v.name)).toEqual(["Middle", "Second"]);
    });

    it("removeValue is a no-op when no entry matches", () => {
      const flag = makeFlag();
      expect(flag.removeValue("absent")).toBe(flag);
      expect(flag.values).toHaveLength(2);
    });

    it("removeValue is a no-op when values is null", () => {
      const flag = makeFlag({ values: null });
      expect(flag.removeValue(true)).toBe(flag);
      expect(flag.values).toBeNull();
    });

    it("clearValues sets values to null", () => {
      const flag = makeFlag();
      flag.clearValues();
      expect(flag.values).toBeNull();
    });
  });

  describe("values / environments getters return defensive copies", () => {
    it("values getter copies the array", () => {
      const flag = makeFlag();
      const a = flag.values;
      const b = flag.values;
      expect(a).not.toBe(b);
    });

    it("environments getter copies the record", () => {
      const flag = makeFlag({ environments: { staging: makeEnv({}) } });
      const a = flag.environments;
      const b = flag.environments;
      expect(a).not.toBe(b);
    });
  });

  describe("toString / _apply / _envsRaw", () => {
    it("toString is readable", () => {
      const flag = makeFlag();
      expect(flag.toString()).toBe("Flag(id=my-flag, type=BOOLEAN, default=false)");
    });

    it("_envsRaw exposes the underlying environments map", () => {
      const env = makeEnv({});
      const flag = makeFlag({ environments: { staging: env } });
      expect(flag._envsRaw().staging).toBe(env);
    });

    it("_apply copies every field from another Flag", () => {
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
        values: [{ name: "T", value: true } as any],
        description: "Updated",
        environments: { staging: makeEnv({}) },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-06-01T00:00:00Z",
      });

      flag._apply(other);

      expect(flag.name).toBe("Updated A");
      expect(flag.default).toBe(true);
      expect(flag.values).toHaveLength(1);
      expect(flag.description).toBe("Updated");
      expect(flag.environments).toHaveProperty("staging");
      expect(flag.createdAt).toBe("2024-01-01T00:00:00Z");
      expect(flag.updatedAt).toBe("2024-06-01T00:00:00Z");
    });

    it("_apply handles a null values source", () => {
      const flag = makeFlag();
      const other = makeFlag({ values: null });
      flag._apply(other);
      expect(flag.values).toBeNull();
    });
  });
});
