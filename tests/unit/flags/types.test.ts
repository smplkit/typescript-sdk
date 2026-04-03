import { describe, expect, it } from "vitest";
import { Context, Rule } from "../../../src/flags/types.js";

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
});

describe("Rule", () => {
  it("should build a rule with a single when condition", () => {
    const rule = new Rule("Enable for enterprise")
      .when("user.plan", "==", "enterprise")
      .serve(true)
      .build();

    expect(rule).toEqual({
      description: "Enable for enterprise",
      logic: { "==": [{ var: "user.plan" }, "enterprise"] },
      value: true,
    });
  });

  it("should AND multiple when conditions", () => {
    const rule = new Rule("Enterprise in US")
      .when("user.plan", "==", "enterprise")
      .when("account.region", "==", "us")
      .serve(true)
      .build();

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
      const rule = new Rule("test").when("x", op, 1).serve(true).build();
      expect(rule.logic).toHaveProperty(op);
    }
  });

  it("should handle contains operator (reversed in)", () => {
    const rule = new Rule("Contains check")
      .when("user.tags", "contains", "beta")
      .serve(true)
      .build();

    expect(rule.logic).toEqual({ in: ["beta", { var: "user.tags" }] });
  });

  it("should include environment when set", () => {
    const rule = new Rule("Env rule")
      .environment("production")
      .when("user.plan", "==", "enterprise")
      .serve("blue")
      .build();

    expect(rule.environment).toBe("production");
  });

  it("should not include environment when not set", () => {
    const rule = new Rule("No env").when("x", "==", 1).serve(true).build();
    expect(rule).not.toHaveProperty("environment");
  });

  it("should return empty logic when no conditions", () => {
    const rule = new Rule("No conditions").serve(42).build();
    expect(rule.logic).toEqual({});
  });

  it("should support numeric values", () => {
    const rule = new Rule("Numeric").when("count", ">", 100).serve(5).build();
    expect(rule.value).toBe(5);
    expect(rule.logic).toEqual({ ">": [{ var: "count" }, 100] });
  });

  it("should support JSON values", () => {
    const val = { mode: "dark", accent: "#fff" };
    const rule = new Rule("JSON").when("user.plan", "==", "premium").serve(val).build();
    expect(rule.value).toEqual(val);
  });
});
