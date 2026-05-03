import { describe, expect, it, vi } from "vitest";
import { Context, Rule, Op } from "../../../src/flags/types.js";

describe("Context", () => {
  it("should construct with type, key, and attributes", () => {
    const ctx = new Context("user", "user-123", { plan: "enterprise" });
    expect(ctx.type).toBe("user");
    expect(ctx.key).toBe("user-123");
    expect(ctx.attributes).toEqual({ plan: "enterprise" });
    expect(ctx.name).toBeNull();
  });

  it("should support the name option", () => {
    const ctx = new Context("user", "user-123", { plan: "free" }, { name: "Alice" });
    expect(ctx.name).toBe("Alice");
    expect(ctx.attributes).toEqual({ plan: "free" });
  });

  it("should default to empty attributes when none provided", () => {
    const ctx = new Context("device", "d-1");
    expect(ctx.attributes).toEqual({});
  });

  it("should not mutate the original attributes object", () => {
    const original = { plan: "enterprise" };
    const ctx = new Context("user", "u-1", original);
    ctx.attributes.extra = "injected";
    expect(original).not.toHaveProperty("extra");
  });

  it("should have a readable toString", () => {
    const ctx = new Context("user", "u-1");
    expect(ctx.toString()).toContain("user");
    expect(ctx.toString()).toContain("u-1");
  });

  describe("save()", () => {
    it("should call _saveContext and apply the result", async () => {
      const ctx = new Context("user", "u-1", { plan: "free" });
      const saved = new Context(
        "user",
        "u-1",
        { plan: "enterprise" },
        {
          name: "Alice",
          createdAt: "2026-04-01T10:00:00Z",
          updatedAt: "2026-04-01T10:00:00Z",
        },
      );
      const fakeClient = { _saveContext: vi.fn().mockResolvedValue(saved) };
      // @ts-expect-error — internal access for test setup
      ctx._client = fakeClient;

      await ctx.save();

      expect(fakeClient._saveContext).toHaveBeenCalledWith(ctx);
      expect(ctx.attributes).toEqual({ plan: "enterprise" });
      expect(ctx.name).toBe("Alice");
      expect(ctx.createdAt).toBe("2026-04-01T10:00:00Z");
    });

    it("should throw when client is null", async () => {
      const ctx = new Context("user", "u-1", {});
      await expect(ctx.save()).rejects.toThrow("cannot save");
    });
  });

  describe("delete()", () => {
    it("should call client.delete with composite id when client is set", async () => {
      const ctx = new Context("user", "u-1", {});
      const fakeClient = { delete: vi.fn().mockResolvedValue(undefined) };
      // @ts-expect-error — internal access for test setup
      ctx._client = fakeClient;
      await ctx.delete();
      expect(fakeClient.delete).toHaveBeenCalledWith("user:u-1");
    });

    it("should throw when client is null", async () => {
      const ctx = new Context("user", "u-1", {});
      await expect(ctx.delete()).rejects.toThrow("cannot delete");
    });
  });

  describe("_apply()", () => {
    it("should copy fields from another Context (post-save)", () => {
      // Original is unsaved (createdAt: null). _apply copies in the saved state.
      const ctx = new Context("user", "u-1", { plan: "free" });
      const saved = new Context(
        "user",
        "u-1",
        { plan: "enterprise" },
        {
          name: "Alice",
          createdAt: "2026-04-01T10:00:00Z",
          updatedAt: "2026-04-01T10:00:00Z",
        },
      );

      // @ts-expect-error — internal method for test
      ctx._apply(saved);

      expect(ctx.type).toBe("user");
      expect(ctx.key).toBe("u-1");
      expect(ctx.name).toBe("Alice");
      expect(ctx.attributes).toEqual({ plan: "enterprise" });
      expect(ctx.createdAt).toBe("2026-04-01T10:00:00Z");
      expect(ctx.updatedAt).toBe("2026-04-01T10:00:00Z");
    });
  });
});

describe("Rule", () => {
  it("should build a rule with a single when condition", () => {
    const rule = new Rule("Enable for enterprise", { environment: "staging" })
      .when("user.plan", Op.EQ, "enterprise")
      .serve(true);

    expect(rule).toEqual({
      description: "Enable for enterprise",
      logic: { "==": [{ var: "user.plan" }, "enterprise"] },
      value: true,
      environment: "staging",
    });
  });

  it("should AND multiple when conditions", () => {
    const rule = new Rule("Enterprise in US", { environment: "staging" })
      .when("user.plan", Op.EQ, "enterprise")
      .when("account.region", Op.EQ, "us")
      .serve(true);

    expect(rule.logic).toEqual({
      and: [
        { "==": [{ var: "user.plan" }, "enterprise"] },
        { "==": [{ var: "account.region" }, "us"] },
      ],
    });
  });

  it("should support all operators", () => {
    const ops = ["==", "!=", ">", "<", ">=", "<=", "in"];
    for (const op of ops) {
      const rule = new Rule("test", { environment: "staging" }).when("x", op, 1).serve(true);
      expect(rule.logic).toHaveProperty(op);
    }
  });

  it("should handle contains operator (reversed in)", () => {
    const rule = new Rule("Contains check", { environment: "staging" })
      .when("user.tags", "contains", "beta")
      .serve(true);

    expect(rule.logic).toEqual({ in: ["beta", { var: "user.tags" }] });
  });

  it("should include environment when set", () => {
    const rule = new Rule("Env rule", { environment: "production" })
      .when("user.plan", Op.EQ, "enterprise")
      .serve("blue");

    expect(rule.environment).toBe("production");
  });

  it("should require environment in the constructor", () => {
    // @ts-expect-error -- intentional missing environment to verify runtime check
    expect(() => new Rule("No env")).toThrow();
  });

  it("should return empty logic when no conditions", () => {
    const rule = new Rule("No conditions", { environment: "staging" }).serve(42);
    expect(rule.logic).toEqual({});
  });

  it("should support numeric values", () => {
    const rule = new Rule("Numeric", { environment: "staging" }).when("count", Op.GT, 100).serve(5);
    expect(rule.value).toBe(5);
    expect(rule.logic).toEqual({ ">": [{ var: "count" }, 100] });
  });

  it("should support JSON values", () => {
    const val = { mode: "dark", accent: "#fff" };
    const rule = new Rule("JSON", { environment: "staging" })
      .when("user.plan", Op.EQ, "premium")
      .serve(val);
    expect(rule.value).toEqual(val);
  });

  it("should accept a single JSON Logic expression as escape hatch", () => {
    const expr = {
      or: [
        { "==": [{ var: "user.plan" }, "enterprise"] },
        { "==": [{ var: "account.region" }, "us"] },
      ],
    };
    const rule = new Rule("Custom JSON Logic", { environment: "staging" }).when(expr).serve(true);
    expect(rule.logic).toEqual(expr);
  });

  it("should throw TypeError for invalid argument count (zero args)", () => {
    const r = new Rule("bad", { environment: "staging" });
    // @ts-expect-error — intentional misuse to verify runtime check
    expect(() => r.when()).toThrow(TypeError);
    // @ts-expect-error — intentional misuse to verify runtime check
    expect(() => r.when()).toThrow(/either \(var, op, value\) or a single JSON Logic dict/);
  });

  it("should throw TypeError for invalid argument count (two args)", () => {
    const r = new Rule("bad", { environment: "staging" });
    // @ts-expect-error — intentional misuse to verify runtime check
    expect(() => r.when("x", "==")).toThrow(TypeError);
  });
});
