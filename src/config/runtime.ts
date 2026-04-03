/**
 * ConfigRuntime — runtime-plane value resolution with WebSocket updates.
 *
 * Holds a fully resolved local cache of config values for a specific
 * environment.  All value-access methods are synchronous (local reads);
 * only {@link refresh} and {@link close} are async.
 *
 * A background WebSocket connection is maintained for real-time updates.
 * If the WebSocket fails, the runtime operates in cache-only mode and
 * reconnects automatically with exponential backoff.
 */

import { resolveChain } from "./resolve.js";
import type { ChainConfig } from "./resolve.js";
import type { ConfigChangeEvent, ConfigStats, ConnectionStatus } from "./runtime-types.js";
import type { SharedWebSocket } from "../ws.js";

/** @internal */
interface ChangeListener {
  callback: (event: ConfigChangeEvent) => void;
  key: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** @internal Options for constructing a ConfigRuntime. */
export interface ConfigRuntimeOptions {
  configKey: string;
  configId: string;
  environment: string;
  chain: ChainConfig[];
  apiKey: string;
  baseUrl: string;
  fetchChain: (() => Promise<ChainConfig[]>) | null;
  sharedWs?: SharedWebSocket | null;
}

/**
 * Runtime configuration handle for a specific environment.
 *
 * Obtained by calling {@link Config.connect}.  All value-access methods
 * are synchronous and served entirely from a local in-process cache.
 * The cache is populated eagerly on construction and kept current via
 * a background WebSocket connection.
 */
export class ConfigRuntime {
  private _cache: Record<string, unknown>;
  private _chain: ChainConfig[];
  private _fetchCount: number;
  private _lastFetchAt: string | null;
  private _closed = false;
  private _listeners: ChangeListener[] = [];

  private readonly _environment: string;
  private readonly _fetchChain: (() => Promise<ChainConfig[]>) | null;
  private _sharedWs: SharedWebSocket | null = null;

  /** @internal */
  constructor(options: ConfigRuntimeOptions) {
    this._environment = options.environment;
    this._fetchChain = options.fetchChain;
    this._chain = options.chain;
    this._cache = resolveChain(options.chain, options.environment);
    this._fetchCount = options.chain.length;
    this._lastFetchAt = new Date().toISOString();

    // Register on shared WebSocket for config_changed events
    if (options.sharedWs) {
      this._sharedWs = options.sharedWs;
      this._sharedWs.on("config_changed", this._handleConfigChanged);
      this._sharedWs.on("config_deleted", this._handleConfigDeleted);
    }
  }

  // ---- Value access (synchronous, local cache) ----

  /**
   * Return the resolved value for `key`, or `defaultValue` if absent.
   *
   * @param key - The config key to look up.
   * @param defaultValue - Returned when the key is not present (default: null).
   */
  get(key: string, defaultValue: unknown = null): unknown {
    return key in this._cache ? this._cache[key] : defaultValue;
  }

  /**
   * Return the value as a string, or `defaultValue` if absent or not a string.
   */
  getString(key: string, defaultValue: string | null = null): string | null {
    const value = this._cache[key];
    return typeof value === "string" ? value : defaultValue;
  }

  /**
   * Return the value as a number, or `defaultValue` if absent or not a number.
   */
  getInt(key: string, defaultValue: number | null = null): number | null {
    const value = this._cache[key];
    return typeof value === "number" ? value : defaultValue;
  }

  /**
   * Return the value as a boolean, or `defaultValue` if absent or not a boolean.
   */
  getBool(key: string, defaultValue: boolean | null = null): boolean | null {
    const value = this._cache[key];
    return typeof value === "boolean" ? value : defaultValue;
  }

  /**
   * Return whether `key` is present in the resolved configuration.
   */
  exists(key: string): boolean {
    return key in this._cache;
  }

  /**
   * Return a shallow copy of the full resolved configuration.
   */
  getAll(): Record<string, unknown> {
    return { ...this._cache };
  }

  // ---- Change listeners ----

  /**
   * Register a listener that fires when a config value changes.
   *
   * @param callback - Called with a {@link ConfigChangeEvent} on each change.
   * @param options.key - If provided, the listener fires only for this key.
   *   If omitted, the listener fires for all changes.
   */
  onChange(callback: (event: ConfigChangeEvent) => void, options?: { key?: string }): void {
    this._listeners.push({
      callback,
      key: options?.key ?? null,
    });
  }

  // ---- Diagnostics ----

  /**
   * Return diagnostic statistics for this runtime.
   */
  stats(): ConfigStats {
    return {
      fetchCount: this._fetchCount,
      lastFetchAt: this._lastFetchAt,
    };
  }

  /**
   * Return the current WebSocket connection status.
   */
  connectionStatus(): ConnectionStatus {
    if (this._sharedWs) {
      return this._sharedWs.connectionStatus as ConnectionStatus;
    }
    return "disconnected";
  }

  // ---- Lifecycle ----

  /**
   * Force a manual refresh of the cached configuration.
   *
   * Re-fetches the full config chain via HTTP, re-resolves values, updates
   * the local cache, and fires listeners for any detected changes.
   *
   * @throws {Error} If no `fetchChain` function was provided on construction.
   */
  async refresh(): Promise<void> {
    if (!this._fetchChain) {
      throw new Error("No fetchChain function provided; cannot refresh.");
    }

    const newChain = await this._fetchChain();
    const oldCache = this._cache;

    this._chain = newChain;
    this._cache = resolveChain(newChain, this._environment);
    this._fetchCount += newChain.length;
    this._lastFetchAt = new Date().toISOString();

    this._diffAndFire(oldCache, this._cache, "manual");
  }

  /**
   * Close the runtime connection.
   *
   * Unregisters from the shared WebSocket. Safe to call multiple times.
   */
  async close(): Promise<void> {
    this._closed = true;

    if (this._sharedWs !== null) {
      this._sharedWs.off("config_changed", this._handleConfigChanged);
      this._sharedWs.off("config_deleted", this._handleConfigDeleted);
      this._sharedWs = null;
    }
  }

  /**
   * Async dispose support for `await using` (TypeScript 5.2+).
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ---- Shared WebSocket event handlers ----

  private _handleConfigChanged = (data: Record<string, any>): void => {
    if (this._closed) return;
    const configId = data.config_id as string | undefined;
    const changes = data.changes as
      | Array<{ key: string; old_value: unknown; new_value: unknown }>
      | undefined;
    if (configId && changes) {
      this._applyChanges(configId, changes);
    } else if (this._fetchChain) {
      // Full re-fetch if the event doesn't include granular changes
      void this._fetchChain()
        .then((newChain) => {
          const oldCache = this._cache;
          this._chain = newChain;
          this._cache = resolveChain(newChain, this._environment);
          this._fetchCount += newChain.length;
          this._lastFetchAt = new Date().toISOString();
          this._diffAndFire(oldCache, this._cache, "websocket");
        })
        .catch(() => {
          // ignore fetch errors
        });
    }
  };

  private _handleConfigDeleted = (_data: Record<string, any>): void => {
    this._closed = true;
    void this.close();
  };

  private _applyChanges(
    configId: string,
    changes: Array<{ key: string; old_value: unknown; new_value: unknown }>,
  ): void {
    const chainEntry = this._chain.find((c) => c.id === configId);
    if (!chainEntry) return;

    for (const change of changes) {
      const { key, new_value } = change;

      // Get or create the environment entry
      const envEntry =
        chainEntry.environments[this._environment] !== undefined &&
        chainEntry.environments[this._environment] !== null
          ? (chainEntry.environments[this._environment] as Record<string, unknown>)
          : null;
      const envValues =
        envEntry !== null && typeof envEntry === "object"
          ? ((envEntry.values ?? {}) as Record<string, unknown>)
          : null;

      if (new_value === null || new_value === undefined) {
        // Deletion: remove from base items and env values
        delete chainEntry.items[key];
        if (envValues) delete envValues[key];
      } else if (envValues && key in envValues) {
        // Update existing env-specific override
        envValues[key] = new_value;
      } else if (key in chainEntry.items) {
        // Update existing base value
        chainEntry.items[key] = new_value;
      } else {
        // New key — put in base items
        chainEntry.items[key] = new_value;
      }
    }

    const oldCache = this._cache;
    this._cache = resolveChain(this._chain, this._environment);
    this._diffAndFire(oldCache, this._cache, "websocket");
  }

  private _diffAndFire(
    oldCache: Record<string, unknown>,
    newCache: Record<string, unknown>,
    source: "websocket" | "poll" | "manual",
  ): void {
    const allKeys = new Set([...Object.keys(oldCache), ...Object.keys(newCache)]);

    for (const key of allKeys) {
      const oldVal = key in oldCache ? oldCache[key] : null;
      const newVal = key in newCache ? newCache[key] : null;

      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        const event: ConfigChangeEvent = { key, oldValue: oldVal, newValue: newVal, source };
        this._fireListeners(event);
      }
    }
  }

  private _fireListeners(event: ConfigChangeEvent): void {
    for (const listener of this._listeners) {
      if (listener.key === null || listener.key === event.key) {
        try {
          listener.callback(event);
        } catch {
          // ignore listener errors to prevent one bad listener from stopping others
        }
      }
    }
  }
}
