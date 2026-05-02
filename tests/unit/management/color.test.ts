/**
 * Tests for the Color value type (rule 6 of PR #127).
 *
 * Validates:
 *   - Frozen / immutable.
 *   - Hex format validation (3, 6, 8 hex digits, with leading #).
 *   - Color.rgb(r, g, b) accepts 0–255 integers, rejects everything else.
 *   - Equality on hex.
 */

import { describe, expect, it } from "vitest";

import { Color } from "../../../src/index.js";
import { coerceColor } from "../../../src/management/types.js";

describe("Color", () => {
  describe("constructor", () => {
    it("accepts 6-digit hex", () => {
      const c = new Color("#ef4444");
      expect(c.hex).toBe("#ef4444");
    });

    it("accepts 3-digit hex shorthand", () => {
      const c = new Color("#fff");
      expect(c.hex).toBe("#fff");
    });

    it("accepts 8-digit hex with alpha", () => {
      const c = new Color("#ef4444aa");
      expect(c.hex).toBe("#ef4444aa");
    });

    it("normalizes to lowercase", () => {
      const c = new Color("#EF4444");
      expect(c.hex).toBe("#ef4444");
    });

    it("rejects non-string input", () => {
      // @ts-expect-error — runtime validation
      expect(() => new Color(0xef4444)).toThrow(TypeError);
    });

    it("rejects null input with a 'got null' message", () => {
      // @ts-expect-error — runtime validation
      expect(() => new Color(null)).toThrow(/got null/);
    });

    it("rejects malformed hex", () => {
      expect(() => new Color("ef4444")).toThrow(/CSS hex string/);
      expect(() => new Color("#zzz")).toThrow(/CSS hex string/);
      expect(() => new Color("#ef44")).toThrow(/CSS hex string/);
    });

    it("freezes the instance — mutation does not take effect", () => {
      const c = new Color("#ef4444");
      expect(() => {
        // @ts-expect-error — readonly enforced
        c.hex = "#ffffff";
      }).toThrow();
      expect(c.hex).toBe("#ef4444");
    });
  });

  describe("Color.rgb", () => {
    it("constructs from 0–255 integers", () => {
      const c = Color.rgb(239, 68, 68);
      expect(c.hex).toBe("#ef4444");
    });

    it("rejects non-integer (float) components", () => {
      expect(() => Color.rgb(1.5 as number, 0, 0)).toThrow(TypeError);
    });

    it("rejects out-of-range components", () => {
      expect(() => Color.rgb(-1, 0, 0)).toThrow(/0–255/);
      expect(() => Color.rgb(256, 0, 0)).toThrow(/0–255/);
    });

    it("rejects non-number components", () => {
      // @ts-expect-error — runtime validation
      expect(() => Color.rgb("0", 0, 0)).toThrow(TypeError);
    });
  });

  describe("equality", () => {
    it("treats same hex as equal regardless of case", () => {
      const a = new Color("#ef4444");
      const b = new Color("#EF4444");
      expect(a.equals(b)).toBe(true);
    });

    it("treats different hex as not equal", () => {
      expect(new Color("#000").equals(new Color("#fff"))).toBe(false);
    });

    it("does not equal a plain string", () => {
      expect(new Color("#000").equals("#000")).toBe(false);
    });
  });

  describe("toString", () => {
    it("returns the hex string", () => {
      const c = new Color("#ef4444");
      expect(c.toString()).toBe("#ef4444");
    });

    it("returns a normalized lowercase hex", () => {
      const c = new Color("#FFFFFF");
      expect(c.toString()).toBe("#ffffff");
    });
  });
});

describe("coerceColor", () => {
  it("returns null for null input", () => {
    expect(coerceColor(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(coerceColor(undefined)).toBeNull();
  });

  it("returns the same Color when given a Color instance", () => {
    const c = new Color("#ef4444");
    expect(coerceColor(c)).toBe(c);
  });

  it("constructs a Color from a hex string", () => {
    const c = coerceColor("#ef4444");
    expect(c).toBeInstanceOf(Color);
    expect(c?.hex).toBe("#ef4444");
  });

  it("throws TypeError for non-Color, non-string input", () => {
    // @ts-expect-error — runtime validation
    expect(() => coerceColor(0xef4444)).toThrow(TypeError);
    // @ts-expect-error — runtime validation
    expect(() => coerceColor({})).toThrow(TypeError);
    // @ts-expect-error — runtime validation
    expect(() => coerceColor(true)).toThrow(TypeError);
  });
});
