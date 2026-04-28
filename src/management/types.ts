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
