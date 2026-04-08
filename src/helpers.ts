/**
 * Shared helper utilities used across SDK modules.
 */

/**
 * Convert a slug-style key to a human-readable display name.
 *
 * @example
 * ```typescript
 * keyToDisplayName("checkout-v2")    // "Checkout V2"
 * keyToDisplayName("payment_service") // "Payment Service"
 * ```
 */
export function keyToDisplayName(key: string): string {
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
