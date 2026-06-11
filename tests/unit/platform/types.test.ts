import { describe, it, expect } from "vitest";
import { Color, EnvironmentClassification, coerceColor } from "../../../src/platform/types.js";

describe("EnvironmentClassification", () => {
  it("exposes STANDARD and AD_HOC string values", () => {
    expect(EnvironmentClassification.STANDARD).toBe("STANDARD");
    expect(EnvironmentClassification.AD_HOC).toBe("AD_HOC");
  });
});

describe("Color", () => {
  describe("constructor", () => {
    it("accepts a 6-digit hex string", () => {
      expect(new Color("#ef4444").hex).toBe("#ef4444");
    });

    it("accepts a 3-digit shorthand hex string", () => {
      expect(new Color("#fff").hex).toBe("#fff");
    });

    it("accepts an 8-digit hex string with alpha", () => {
      expect(new Color("#ef4444aa").hex).toBe("#ef4444aa");
    });

    it("normalizes hex to lowercase", () => {
      expect(new Color("#EF4444").hex).toBe("#ef4444");
    });

    it("is frozen after construction", () => {
      expect(Object.isFrozen(new Color("#fff"))).toBe(true);
    });

    it("throws a TypeError for non-string input", () => {
      // @ts-expect-error — exercising the runtime guard
      expect(() => new Color(123)).toThrow(TypeError);
      // @ts-expect-error — exercising the runtime guard
      expect(() => new Color(123)).toThrow(/must be a string, got number/);
    });

    it("reports null specifically in the TypeError message", () => {
      // @ts-expect-error — exercising the runtime guard
      expect(() => new Color(null)).toThrow(/got null/);
    });

    it("throws for a malformed hex string", () => {
      expect(() => new Color("not-a-hex")).toThrow(/Invalid color/);
    });

    it("throws for a hex string of an unsupported length", () => {
      expect(() => new Color("#abcde")).toThrow(/Invalid color/);
    });
  });

  describe("rgb()", () => {
    it("builds a Color from RGB components", () => {
      expect(Color.rgb(239, 68, 68).hex).toBe("#ef4444");
    });

    it("zero-pads single-digit hex components", () => {
      expect(Color.rgb(0, 0, 0).hex).toBe("#000000");
    });

    it("throws a TypeError for a non-integer component", () => {
      expect(() => Color.rgb(1.5, 0, 0)).toThrow(TypeError);
      expect(() => Color.rgb(1.5, 0, 0)).toThrow(/r must be an integer/);
    });

    it("throws a TypeError for a non-number component", () => {
      // @ts-expect-error — exercising the runtime guard
      expect(() => Color.rgb("0", 0, 0)).toThrow(TypeError);
    });

    it("throws a RangeError-style error when a component is below 0", () => {
      expect(() => Color.rgb(-1, 0, 0)).toThrow(/r must be in range/);
    });

    it("throws when a component is above 255", () => {
      expect(() => Color.rgb(0, 256, 0)).toThrow(/g must be in range/);
    });

    it("validates the blue component too", () => {
      expect(() => Color.rgb(0, 0, 999)).toThrow(/b must be in range/);
    });
  });

  describe("toString()", () => {
    it("returns the hex string", () => {
      expect(new Color("#ef4444").toString()).toBe("#ef4444");
    });
  });

  describe("equals()", () => {
    it("is true for two Colors with the same hex", () => {
      expect(new Color("#FFF").equals(new Color("#fff"))).toBe(true);
    });

    it("is false for Colors with different hex", () => {
      expect(new Color("#fff").equals(new Color("#000"))).toBe(false);
    });

    it("is false for non-Color values", () => {
      expect(new Color("#fff").equals("#fff")).toBe(false);
      expect(new Color("#fff").equals(null)).toBe(false);
    });
  });
});

describe("coerceColor()", () => {
  it("returns null for null", () => {
    expect(coerceColor(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(coerceColor(undefined)).toBeNull();
  });

  it("returns the same Color instance unchanged", () => {
    const color = new Color("#abcdef");
    expect(coerceColor(color)).toBe(color);
  });

  it("coerces a hex string to a Color", () => {
    const color = coerceColor("#123456");
    expect(color).toBeInstanceOf(Color);
    expect(color?.hex).toBe("#123456");
  });

  it("throws a TypeError for an unsupported type", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(() => coerceColor(42)).toThrow(TypeError);
    // @ts-expect-error — exercising the runtime guard
    expect(() => coerceColor(42)).toThrow(/got number/);
  });
});
