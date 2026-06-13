/**
 * Per-request evaluation context — the AsyncLocalStorage-backed store, the
 * restorable {@link ContextScope}, and the `Symbol.dispose` polyfill.
 *
 * This file is isolated in its own worker, so the `enterWith` mutations here
 * cannot leak into other test files; within the file each mutating test
 * restores so the "no active context" assertions hold regardless of order.
 */

import { describe, expect, it } from "vitest";
import {
  ContextScope,
  ensureDisposeSymbol,
  getRequestContext,
  setContext,
} from "../../src/context.js";
import { Context } from "../../src/flags/types.js";

const keys = (cs: Context[]): string[] => cs.map((c) => c.key);

describe("ensureDisposeSymbol", () => {
  it("returns the existing dispose symbol when one is already present", () => {
    const existing = Symbol("Symbol.dispose");
    expect(ensureDisposeSymbol({ dispose: existing })).toBe(existing);
  });

  it("defines a dispose symbol when missing, then returns it idempotently", () => {
    const target: { dispose?: symbol } = {};
    const created = ensureDisposeSymbol(target);
    expect(typeof created).toBe("symbol");
    expect(target.dispose).toBe(created);
    // Already defined now — the same symbol comes back without redefining.
    expect(ensureDisposeSymbol(target)).toBe(created);
  });

  it("installs the real Symbol.dispose so `using` works across Node 18+", () => {
    expect(typeof Symbol.dispose).toBe("symbol");
  });
});

describe("getRequestContext / setContext", () => {
  it("returns an empty list when no context is active", () => {
    expect(getRequestContext()).toEqual([]);
  });

  it("setContext returns a ContextScope and makes the context current", () => {
    const scope = setContext([new Context("user", "u-1")]);
    try {
      expect(scope).toBeInstanceOf(ContextScope);
      expect(keys(getRequestContext())).toEqual(["u-1"]);
    } finally {
      scope.restore();
    }
    expect(getRequestContext()).toEqual([]);
  });

  it("setContext defensively copies its input", () => {
    const input = [new Context("user", "c")];
    const scope = setContext(input);
    try {
      input.push(new Context("user", "d"));
      expect(keys(getRequestContext())).toEqual(["c"]);
    } finally {
      scope.restore();
    }
  });
});

describe("ContextScope", () => {
  it("restore() reverts to the previously active context (nested)", () => {
    const scopeA = setContext([new Context("user", "a")]);
    expect(keys(getRequestContext())).toEqual(["a"]);

    const scopeB = setContext([new Context("user", "b")]);
    expect(keys(getRequestContext())).toEqual(["b"]);

    scopeB.restore();
    expect(keys(getRequestContext())).toEqual(["a"]);

    scopeA.restore();
    expect(getRequestContext()).toEqual([]);
  });

  it("restore() is idempotent", () => {
    const scope = setContext([new Context("user", "x")]);
    scope.restore();
    expect(getRequestContext()).toEqual([]);
    // Second call hits the already-restored guard and is a no-op.
    scope.restore();
    expect(getRequestContext()).toEqual([]);
  });

  it("[Symbol.dispose]() restores like restore() (enables `using`)", () => {
    const scope = setContext([new Context("user", "z")]);
    expect(keys(getRequestContext())).toEqual(["z"]);
    scope[Symbol.dispose]();
    expect(getRequestContext()).toEqual([]);
  });
});
