/**
 * Level resolution algorithm: pick a logger's effective level from its own
 * override, its group, its dot-notation ancestors, and the system default.
 *
 * Pure functions — no I/O, no SDK state — kept separate so the chain can
 * be tested exhaustively without spinning up a runtime client.
 */

import { debug, isDebugEnabled } from "../_debug.js";

const FALLBACK_LEVEL = "INFO";

/** @internal Shape of a cached logger entry used by {@link resolveLevel}. */
export interface LoggerCacheEntry {
  level: string | null;
  group: string | null;
  managed?: boolean | null;
  environments: Record<string, { level?: string | null } | null> | null;
}

/** @internal Shape of a cached log group entry used by {@link resolveLevel}. */
export interface GroupCacheEntry {
  level: string | null;
  group: string | null;
  environments: Record<string, { level?: string | null } | null> | null;
}

/**
 * Resolve the effective log level for a logger in an environment.
 *
 * Resolution chain (first non-null wins):
 *
 * 1. Logger's own `environments[env].level`
 * 2. Logger's own `level`
 * 3. Group chain (recursive: group's env level → group's level → parent group…)
 * 4. Dot-notation ancestry (walk `com.acme.payments` → `com.acme` → `com`,
 *    applying steps 1-3 at each)
 * 5. System fallback: `"INFO"`
 *
 * @param loggerId    The normalized logger id (slug).
 * @param environment The current environment name.
 * @param loggers     Cache of all loggers keyed by id.
 * @param groups      Cache of all log groups keyed by id.
 */
export function resolveLevel(
  loggerId: string,
  environment: string,
  loggers: Record<string, LoggerCacheEntry>,
  groups: Record<string, GroupCacheEntry>,
): string {
  const direct = _resolveForEntry(loggerId, environment, loggers, groups);
  if (direct !== null) {
    if (isDebugEnabled()) {
      const source = _findResolutionSource(loggerId, environment, loggers, groups);
      debug("resolution", `${loggerId} -> ${direct} (source: ${source})`);
    }
    return direct;
  }

  // Dot-notation ancestry: walk up the hierarchy
  const parts = loggerId.split(".");
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestorId = parts.slice(0, i).join(".");
    const result = _resolveForEntry(ancestorId, environment, loggers, groups);
    if (result !== null) {
      debug("resolution", `${loggerId} -> ${result} (source: ancestor "${ancestorId}")`);
      return result;
    }
  }

  debug("resolution", `${loggerId} -> ${FALLBACK_LEVEL} (source: system default)`);
  return FALLBACK_LEVEL;
}

/** @internal Try to resolve a level for a single entry (logger or ancestor). */
function _resolveForEntry(
  loggerId: string,
  environment: string,
  loggers: Record<string, LoggerCacheEntry>,
  groups: Record<string, GroupCacheEntry>,
): string | null {
  const entry = loggers[loggerId];
  if (entry === undefined) return null;

  // Step 1: env override on the entry itself
  const envLevel = _envLevel(entry.environments, environment);
  if (envLevel !== null) return envLevel;

  // Step 2: base level on the entry itself
  if (entry.level !== null && entry.level !== undefined) return entry.level;

  // Step 3: group chain
  return _resolveGroupChain(entry.group, environment, groups);
}

/**
 * @internal Return a human-readable string describing which step produced
 * the level. Only invoked when debug is enabled.
 */
export function _findResolutionSource(
  loggerId: string,
  environment: string,
  loggers: Record<string, LoggerCacheEntry>,
  groups: Record<string, GroupCacheEntry>,
): string {
  const entry = loggers[loggerId];
  if (entry === undefined) return "not found";

  const envLevel = _envLevel(entry.environments, environment);
  if (envLevel !== null) return `env override "${environment}"`;

  if (entry.level !== null && entry.level !== undefined) return "base level";

  const groupResult = _resolveGroupChain(entry.group, environment, groups);
  if (groupResult !== null) return `group "${entry.group}"`;

  return "unknown";
}

/** @internal Walk the group chain looking for a level. Protects against cycles. */
function _resolveGroupChain(
  groupId: string | null | undefined,
  environment: string,
  groups: Record<string, GroupCacheEntry>,
): string | null {
  const visited = new Set<string>();
  let currentId: string | null | undefined = groupId;
  while (currentId !== null && currentId !== undefined && !visited.has(currentId)) {
    visited.add(currentId);
    const group = groups[currentId];
    if (group === undefined) break;
    const envLevel = _envLevel(group.environments, environment);
    if (envLevel !== null) return envLevel;
    if (group.level !== null && group.level !== undefined) return group.level;
    currentId = group.group;
  }
  return null;
}

/** @internal Extract the environment-specific level from an entry, if present. */
function _envLevel(
  envs: Record<string, { level?: string | null } | null> | null | undefined,
  environment: string,
): string | null {
  if (!envs || typeof envs !== "object") return null;
  const envData = envs[environment];
  if (!envData || typeof envData !== "object") return null;
  const level = envData.level;
  if (level === null || level === undefined) return null;
  return level;
}
