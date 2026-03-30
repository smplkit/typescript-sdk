import { describe, expect, it } from "vitest";
import { deepMerge, resolveChain } from "../../../src/config/resolve.js";
import type { ChainConfig } from "../../../src/config/resolve.js";

describe("deepMerge", () => {
  it("should merge flat objects", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("should recursively merge nested objects", () => {
    const base = { db: { host: "localhost", port: 5432 } };
    const override = { db: { host: "prod.db", ssl: true } };
    expect(deepMerge(base, override)).toEqual({
      db: { host: "prod.db", port: 5432, ssl: true },
    });
  });

  it("should replace arrays wholesale (not merge them)", () => {
    const base = { tags: ["a", "b"] };
    const override = { tags: ["c"] };
    expect(deepMerge(base, override)).toEqual({ tags: ["c"] });
  });

  it("should replace non-object values wholesale", () => {
    const base = { x: "string", y: 42 };
    const override = { x: 99, y: null };
    expect(deepMerge(base, override)).toEqual({ x: 99, y: null });
  });

  it("should handle override replacing an object with a scalar", () => {
    const base = { db: { host: "localhost" } };
    const override = { db: "connection_string" };
    expect(deepMerge(base, override)).toEqual({ db: "connection_string" });
  });

  it("should handle override replacing a scalar with an object", () => {
    const base = { db: "connection_string" };
    const override = { db: { host: "localhost" } };
    expect(deepMerge(base, override)).toEqual({ db: { host: "localhost" } });
  });

  it("should handle empty base", () => {
    expect(deepMerge({}, { a: 1 })).toEqual({ a: 1 });
  });

  it("should handle empty override", () => {
    expect(deepMerge({ a: 1 }, {})).toEqual({ a: 1 });
  });

  it("should handle both empty", () => {
    expect(deepMerge({}, {})).toEqual({});
  });

  it("should not merge null override values recursively", () => {
    const base = { db: { host: "localhost" } };
    const override = { db: null };
    expect(deepMerge(base, override)).toEqual({ db: null });
  });

  it("should not merge arrays as objects", () => {
    const base = { items: [1, 2] };
    const override = { items: { 0: "a" } };
    // base has array, override has object — override wins (not a merge scenario since base is array)
    expect(deepMerge(base, override)).toEqual({ items: { 0: "a" } });
  });

  it("should deeply merge multiple levels", () => {
    const base = { a: { b: { c: 1, d: 2 }, e: 3 } };
    const override = { a: { b: { c: 10, f: 4 } } };
    expect(deepMerge(base, override)).toEqual({
      a: { b: { c: 10, d: 2, f: 4 }, e: 3 },
    });
  });
});

describe("resolveChain", () => {
  it("should return empty object for empty chain", () => {
    expect(resolveChain([], "production")).toEqual({});
  });

  it("should resolve single config with base items only", () => {
    const chain: ChainConfig[] = [{ id: "a", items: { x: 1, y: 2 }, environments: {} }];
    expect(resolveChain(chain, "production")).toEqual({ x: 1, y: 2 });
  });

  it("should apply environment overrides on top of base items", () => {
    const chain: ChainConfig[] = [
      {
        id: "a",
        items: { x: 1, y: 2 },
        environments: {
          production: { values: { y: 20, z: 30 } },
        },
      },
    ];
    expect(resolveChain(chain, "production")).toEqual({ x: 1, y: 20, z: 30 });
  });

  it("should ignore other environments", () => {
    const chain: ChainConfig[] = [
      {
        id: "a",
        items: { x: 1 },
        environments: {
          production: { values: { x: 10 } },
          staging: { values: { x: 99 } },
        },
      },
    ];
    expect(resolveChain(chain, "production")).toEqual({ x: 10 });
  });

  it("should resolve child-to-root chain (child overrides parent)", () => {
    // Chain is child-to-root: [child, parent]
    const chain: ChainConfig[] = [
      { id: "child", items: { x: 10, child_only: true }, environments: {} },
      { id: "parent", items: { x: 1, parent_only: true }, environments: {} },
    ];
    const result = resolveChain(chain, "production");
    expect(result).toEqual({ x: 10, parent_only: true, child_only: true });
  });

  it("should resolve three-level chain", () => {
    // [grandchild, child, root]
    const chain: ChainConfig[] = [
      { id: "gc", items: { level: "grandchild" }, environments: {} },
      { id: "c", items: { level: "child", mid: true }, environments: {} },
      { id: "r", items: { level: "root", base: true, mid: false }, environments: {} },
    ];
    const result = resolveChain(chain, "any");
    expect(result).toEqual({ level: "grandchild", mid: true, base: true });
  });

  it("should deep-merge nested objects across chain levels", () => {
    const chain: ChainConfig[] = [
      { id: "child", items: { db: { port: 3306 } }, environments: {} },
      { id: "parent", items: { db: { host: "localhost", port: 5432 } }, environments: {} },
    ];
    const result = resolveChain(chain, "production");
    expect(result).toEqual({ db: { host: "localhost", port: 3306 } });
  });

  it("should apply env overrides at each level then merge across chain", () => {
    const chain: ChainConfig[] = [
      {
        id: "child",
        items: { retries: 3 },
        environments: { prod: { values: { retries: 5 } } },
      },
      {
        id: "parent",
        items: { timeout: 30, retries: 1 },
        environments: { prod: { values: { timeout: 60 } } },
      },
    ];
    const result = resolveChain(chain, "prod");
    expect(result).toEqual({ timeout: 60, retries: 5 });
  });

  it("should handle missing environment gracefully", () => {
    const chain: ChainConfig[] = [
      {
        id: "a",
        items: { x: 1 },
        environments: { staging: { values: { x: 10 } } },
      },
    ];
    // 'production' not in environments — should use base items only
    expect(resolveChain(chain, "production")).toEqual({ x: 1 });
  });

  it("should handle null environment entry", () => {
    const chain: ChainConfig[] = [
      {
        id: "a",
        items: { x: 1 },
        environments: { production: null },
      },
    ];
    expect(resolveChain(chain, "production")).toEqual({ x: 1 });
  });

  it("should handle environment entry that is an array (not object)", () => {
    const chain: ChainConfig[] = [
      {
        id: "a",
        items: { x: 1 },
        environments: { production: [1, 2, 3] },
      },
    ];
    expect(resolveChain(chain, "production")).toEqual({ x: 1 });
  });

  it("should handle environment entry with no values sub-key", () => {
    const chain: ChainConfig[] = [
      {
        id: "a",
        items: { x: 1 },
        environments: { production: { other: "stuff" } },
      },
    ];
    expect(resolveChain(chain, "production")).toEqual({ x: 1 });
  });

  it("should handle null items in chain config", () => {
    const chain: ChainConfig[] = [
      {
        id: "a",
        items: null as unknown as Record<string, unknown>,
        environments: null as unknown as Record<string, unknown>,
      },
    ];
    expect(resolveChain(chain, "production")).toEqual({});
  });
});
