/**
 * Internal debug logging for the smplkit SDK.
 *
 * Controlled by the {@link https://docs.smplkit.com/debugging SMPLKIT_DEBUG}
 * environment variable.  When enabled (`SMPLKIT_DEBUG=1`, `true`, or `yes`,
 * case-insensitive), the SDK emits timestamped diagnostic lines to stderr
 * covering every meaningful internal operation.
 *
 * Debug output goes directly to `process.stderr.write()` — never through
 * `console.error()` or any logging library — to avoid interfering with the
 * managed logging framework the SDK controls.  If SDK debug output went
 * through the same framework, the SDK could intercept its own output, causing
 * infinite recursion, race conditions, or debug lines being silently suppressed
 * by a framework-level filter the SDK itself is managing.
 */

/**
 * Parse a raw SMPLKIT_DEBUG env value into a boolean.
 * Exported so unit tests can exercise the parser without reloading the module.
 * @internal
 */
export function _parseDebugEnv(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Cached at module load time — re-reading the env on every call is unnecessary. */
let _DEBUG_ENABLED: boolean = _parseDebugEnv(process.env.SMPLKIT_DEBUG ?? "");

/** Return `true` if SMPLKIT_DEBUG is enabled. */
export function isDebugEnabled(): boolean {
  return _DEBUG_ENABLED;
}

/**
 * Enable debug logging programmatically.
 *
 * Called by the SDK client when `debug: true` is resolved from constructor
 * options or the `~/.smplkit` configuration file.
 * @internal
 */
export function enableDebug(): void {
  _DEBUG_ENABLED = true;
}

/**
 * Emit a debug line to stderr if SMPLKIT_DEBUG is enabled.
 *
 * Format:
 * ```
 * [smplkit:{subsystem}] {ISO-8601 timestamp} {message}\n
 * ```
 *
 * This is a no-op when SMPLKIT_DEBUG is not set (zero overhead in production).
 */
export function debug(subsystem: string, message: string): void {
  if (!_DEBUG_ENABLED) return;
  const ts = new Date().toISOString();
  process.stderr.write(`[smplkit:${subsystem}] ${ts} ${message}\n`);
}
