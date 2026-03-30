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

import WebSocket from "ws";
import { resolveChain } from "./resolve.js";
import type { ChainConfig } from "./resolve.js";
import type { ConfigChangeEvent, ConfigStats, ConnectionStatus } from "./runtime-types.js";

/** @internal */
interface ChangeListener {
  callback: (event: ConfigChangeEvent) => void;
  key: string | null;
}

/** @internal */
interface WsConfigChangedMessage {
  type: "config_changed";
  config_id: string;
  changes: Array<{
    key: string;
    old_value: unknown;
    new_value: unknown;
  }>;
}

/** @internal */
interface WsConfigDeletedMessage {
  type: "config_deleted";
  config_id: string;
}

type WsMessage =
  | { type: "subscribed"; config_id: string; environment: string }
  | { type: "error"; message: string }
  | WsConfigChangedMessage
  | WsConfigDeletedMessage;

/** @internal */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

/** @internal Options for constructing a ConfigRuntime. */
export interface ConfigRuntimeOptions {
  configKey: string;
  configId: string;
  environment: string;
  chain: ChainConfig[];
  apiKey: string;
  baseUrl: string;
  fetchChain: (() => Promise<ChainConfig[]>) | null;
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
  private _wsStatus: ConnectionStatus = "disconnected";
  private _ws: InstanceType<typeof WebSocket> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _backoffIndex = 0;
  private _listeners: ChangeListener[] = [];

  private readonly _configId: string;
  private readonly _environment: string;
  private readonly _apiKey: string;
  private readonly _baseUrl: string;
  private readonly _fetchChain: (() => Promise<ChainConfig[]>) | null;

  /** @internal */
  constructor(options: ConfigRuntimeOptions) {
    this._configId = options.configId;
    this._environment = options.environment;
    this._apiKey = options.apiKey;
    this._baseUrl = options.baseUrl;
    this._fetchChain = options.fetchChain;
    this._chain = options.chain;
    this._cache = resolveChain(options.chain, options.environment);
    this._fetchCount = options.chain.length;
    this._lastFetchAt = new Date().toISOString();

    // Start WebSocket in background — non-blocking
    this._connectWebSocket();
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
    return this._wsStatus;
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
   * Shuts down the WebSocket and cancels any pending reconnect timer.
   * Safe to call multiple times.
   */
  async close(): Promise<void> {
    this._closed = true;
    this._wsStatus = "disconnected";

    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws !== null) {
      this._ws.close();
      this._ws = null;
    }
  }

  /**
   * Async dispose support for `await using` (TypeScript 5.2+).
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ---- WebSocket internals ----

  private _buildWsUrl(): string {
    let url = this._baseUrl;
    if (url.startsWith("https://")) {
      url = "wss://" + url.slice("https://".length);
    } else if (url.startsWith("http://")) {
      url = "ws://" + url.slice("http://".length);
    } else {
      url = "wss://" + url;
    }
    url = url.replace(/\/$/, "");
    return `${url}/api/ws/v1/configs?api_key=${this._apiKey}`;
  }

  private _connectWebSocket(): void {
    if (this._closed) return;

    this._wsStatus = "connecting";
    const wsUrl = this._buildWsUrl();

    try {
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.on("open", () => {
        if (this._closed) {
          ws.close();
          return;
        }
        this._backoffIndex = 0;
        this._wsStatus = "connected";
        ws.send(
          JSON.stringify({
            type: "subscribe",
            config_id: this._configId,
            environment: this._environment,
          }),
        );
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(String(data)) as WsMessage;
          this._handleMessage(msg);
        } catch {
          // ignore unparseable messages
        }
      });

      ws.on("close", () => {
        if (!this._closed) {
          this._wsStatus = "disconnected";
          this._scheduleReconnect();
        }
      });

      ws.on("error", () => {
        // 'close' will fire after 'error'; reconnect is handled there
      });
    } catch {
      if (!this._closed) {
        this._scheduleReconnect();
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this._closed) return;

    const delay = BACKOFF_MS[Math.min(this._backoffIndex, BACKOFF_MS.length - 1)];
    this._backoffIndex++;
    this._wsStatus = "connecting";

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      // On reconnect, resync the cache to pick up changes missed while offline
      if (this._fetchChain) {
        this._fetchChain()
          .then((newChain) => {
            const oldCache = this._cache;
            this._chain = newChain;
            this._cache = resolveChain(newChain, this._environment);
            this._fetchCount += newChain.length;
            this._lastFetchAt = new Date().toISOString();
            this._diffAndFire(oldCache, this._cache, "manual");
          })
          .catch(() => {
            // ignore fetch errors during reconnect
          })
          .finally(() => {
            this._connectWebSocket();
          });
      } else {
        this._connectWebSocket();
      }
    }, delay);
  }

  private _handleMessage(msg: WsMessage): void {
    if (msg.type === "config_changed") {
      this._applyChanges(msg.config_id, msg.changes);
    } else if (msg.type === "config_deleted") {
      this._closed = true;
      void this.close();
    }
  }

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
