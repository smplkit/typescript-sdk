/**
 * Shared types for the management namespace.
 */

/** Whether an environment participates in the canonical ordering.
 *
 * STANDARD environments are the customer's deploy targets (production,
 * staging, development, etc.) and appear in the environment_order list.
 * AD_HOC environments are transient targets (preview branches,
 * developer sandboxes) that are excluded from the standard ordering.
 */
export enum EnvironmentClassification {
  STANDARD = "STANDARD",
  AD_HOC = "AD_HOC",
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * A color, expressed as a CSS hex string.
 *
 * Frozen — construct a fresh `Color` to change a value.
 *
 * @example
 * ```typescript
 * new Color("#ef4444")            // 6-digit hex
 * new Color("#fff")               // 3-digit shorthand
 * new Color("#ef4444aa")          // 8-digit with alpha
 * Color.rgb(239, 68, 68)          // RGB components
 * ```
 */
export class Color {
  /** The normalized lowercase hex string. */
  readonly hex: string;

  constructor(hex: string) {
    if (typeof hex !== "string") {
      const got = hex === null ? "null" : typeof hex;
      throw new TypeError(`Color hex must be a string, got ${got}: ${JSON.stringify(hex)}`);
    }
    if (!HEX_RE.test(hex)) {
      throw new Error(
        `Invalid color ${JSON.stringify(hex)}: must be a CSS hex string like '#RGB', '#RRGGBB', or '#RRGGBBAA'`,
      );
    }
    this.hex = hex.toLowerCase();
    Object.freeze(this);
  }

  /** Construct a `Color` from 0–255 RGB components. */
  static rgb(r: number, g: number, b: number): Color {
    for (const [name, val] of [
      ["r", r],
      ["g", g],
      ["b", b],
    ] as const) {
      if (typeof val !== "number" || !Number.isInteger(val)) {
        const got = typeof val;
        throw new TypeError(
          `Color.rgb ${name} must be an integer, got ${got}: ${JSON.stringify(val)}`,
        );
      }
      if (val < 0 || val > 255) {
        throw new Error(`Color.rgb ${name} must be in range 0–255, got ${JSON.stringify(val)}`);
      }
    }
    const toHex = (n: number): string => n.toString(16).padStart(2, "0");
    return new Color(`#${toHex(r)}${toHex(g)}${toHex(b)}`);
  }

  toString(): string {
    return this.hex;
  }

  /** Equality by hex value. */
  equals(other: unknown): boolean {
    return other instanceof Color && other.hex === this.hex;
  }
}

/**
 * Coerce a `Color | string | null` value into a `Color | null`.
 *
 * Strings are validated via `new Color(...)`. Anything else raises `TypeError`.
 *
 * @internal
 */
export function coerceColor(value: Color | string | null | undefined): Color | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Color) return value;
  if (typeof value === "string") return new Color(value);
  throw new TypeError(`Environment color must be a Color, string, or null; got ${typeof value}`);
}
