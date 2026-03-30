/**
 * Deep-merge resolution algorithm for config inheritance chains.
 *
 * Mirrors the Python SDK's `_resolver.py` (ADR-024 §2.5–2.6).
 */

/** A single entry in a config inheritance chain (child-to-root ordering). */
export interface ChainConfig {
  /** Config UUID. */
  id: string;
  /** Base key-value pairs (unwrapped from typed item definitions). */
  items: Record<string, unknown>;
  /**
   * Per-environment overrides.
   * Each entry is `{ values: { key: value, ... } }` — values are already
   * unwrapped from the server's `{ value: raw }` wrapper by the client layer.
   */
  environments: Record<string, unknown>;
}

/**
 * Recursively merge two dicts, with `override` taking precedence.
 *
 * Nested dicts are merged recursively. Non-dict values (strings, numbers,
 * booleans, arrays, null) are replaced wholesale.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolve the full configuration for an environment given a config chain.
 *
 * Walks from root (last element) to child (first element), accumulating
 * values via deep merge so that child configs override parent configs.
 *
 * For each config in the chain, base `values` are merged with
 * environment-specific values (env wins), then that result is merged
 * on top of the accumulated parent result (child wins over parent).
 *
 * @param chain - Ordered list of config data from child (index 0) to root ancestor (last).
 * @param environment - The environment key to resolve for.
 */
export function resolveChain(chain: ChainConfig[], environment: string): Record<string, unknown> {
  let accumulated: Record<string, unknown> = {};

  // Walk from root to child (reverse order — chain is child-to-root)
  for (let i = chain.length - 1; i >= 0; i--) {
    const config = chain[i];
    const baseValues: Record<string, unknown> = config.items ?? {};

    // Environments are stored as { env_name: { values: { key: val } } }
    const envEntry = (config.environments ?? {})[environment];
    const envValues: Record<string, unknown> =
      envEntry !== null &&
      envEntry !== undefined &&
      typeof envEntry === "object" &&
      !Array.isArray(envEntry)
        ? (((envEntry as Record<string, unknown>).values ?? {}) as Record<string, unknown>)
        : {};

    // Merge environment overrides on top of base values (env wins)
    const configResolved = deepMerge(baseValues, envValues);

    // Merge this config's resolved values on top of accumulated parent values (child wins)
    accumulated = deepMerge(accumulated, configResolved);
  }

  return accumulated;
}
