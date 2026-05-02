/**
 * Tests for Context boundary validation + identity locking (rule 6 of PR #127).
 */

import { describe, expect, it } from "vitest";

import { Context } from "../../../src/index.js";

describe("Context construction validation", () => {
  it("requires type to be a string", () => {
    // @ts-expect-error — runtime validation
    expect(() => new Context(123, "abc")).toThrow(TypeError);
  });

  it("requires key to be a string and points at the boundary", () => {
    // @ts-expect-error — runtime validation
    expect(() => new Context("user", 42)).toThrow(/stringify it at the SDK boundary/);
  });

  it("accepts string type and key", () => {
    const ctx = new Context("user", "user-123", { plan: "enterprise" });
    expect(ctx.type).toBe("user");
    expect(ctx.key).toBe("user-123");
    expect(ctx.attributes.plan).toBe("enterprise");
  });

  it("computes composite id", () => {
    const ctx = new Context("user", "user-123");
    expect(ctx.id).toBe("user:user-123");
  });
});

describe("Context dotted-attribute trap (rule 6)", () => {
  it("blocks setting unknown attributes via dotted assignment", () => {
    const ctx = new Context("user", "user-1");
    expect(() => {
      // @ts-expect-error — runtime validation
      ctx.plan = "enterprise";
    }).toThrow(/Cannot set unknown attribute/);
  });

  it("allows ctx.attributes[key] = value", () => {
    const ctx = new Context("user", "user-1");
    ctx.attributes["plan"] = "enterprise";
    expect(ctx.attributes.plan).toBe("enterprise");
  });
});

describe("Context identity locking after persistence (rule 6)", () => {
  it("locks type once createdAt is set", () => {
    const ctx = new Context("user", "user-1", undefined, { createdAt: "2024-01-01T00:00:00Z" });
    expect(() => {
      ctx.type = "account";
    }).toThrow(/identity is fixed after save/);
  });

  it("locks key once createdAt is set", () => {
    const ctx = new Context("user", "user-1", undefined, { createdAt: "2024-01-01T00:00:00Z" });
    expect(() => {
      ctx.key = "user-2";
    }).toThrow(/identity is fixed after save/);
  });

  it("allows reassigning identity fields when not yet persisted", () => {
    const ctx = new Context("user", "user-1");
    ctx.type = "account";
    ctx.key = "acme";
    expect(ctx.id).toBe("account:acme");
  });
});
