/**
 * ConfigClient — runtime client for Smpl Config (live values, change listeners).
 * Management/CRUD lives on `mgmt.config.*`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/config.d.ts";
import { SmplNotFoundError, SmplError, SmplTimeoutError } from "../errors.js";
import { resolveChain } from "./resolve.js";
import { Config } from "./types.js";
import { LiveConfigProxy } from "./proxy.js";
import type { MetricsReporter } from "../_metrics.js";
import { debug } from "../_debug.js";
import type { SmplManagementClient } from "../management/client.js";

/**
 * Describes a single config value change detected on refresh. Frozen —
 * fields are set at construction and cannot be mutated afterward.
 */
export class ConfigChangeEvent {
  /** The config id that changed. */
  readonly configId: string;
  /** The item key within the config that changed. */
  readonly itemKey: string;
  /** The previous value (null if the key was absent). */
  readonly oldValue: unknown;
  /** The updated value (null if the key was removed). */
  readonly newValue: unknown;
  /** How the change was delivered. */
  readonly source: "websocket" | "manual";

  constructor(fields: {
    configId: string;
    itemKey: string;
    oldValue: unknown;
    newValue: unknown;
    source: "websocket" | "manual";
  }) {
    this.configId = fields.configId;
    this.itemKey = fields.itemKey;
    this.oldValue = fields.oldValue;
    this.newValue = fields.newValue;
    this.source = fields.source;
    Object.freeze(this);
  }
}

/** @internal */
interface ChangeListener {
  callback: (event: ConfigChangeEvent) => void;
  configId: string | null;
  itemKey: string | null;
}

const BASE_URL = "https://config.smplkit.com";

type ConfigResource = components["schemas"]["ConfigResource"];

/**
 * Extract raw values from typed items: `{key: {value, type?, description?}}` -> `{key: rawValue}`.
 * @internal
 */
function extractItemValues(
  items: Record<string, { value: unknown }> | null | undefined,
): Record<string, unknown> {
  if (!items) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(items)) {
    result[key] = item && typeof item === "object" && "value" in item ? item.value : item;
  }
  return result;
}

/**
 * Extract raw values from environment overrides.
 * Wire format: `{ env: { values: { key: { value: raw } } } }`
 * SDK format:  `{ env: { values: { key: raw } } }`
 * @internal
 */
function extractEnvironments(
  environments:
    | Record<string, { values?: Record<string, { value: unknown }> | null }>
    | null
    | undefined,
): Record<string, unknown> {
  if (!environments) return {};
  const result: Record<string, unknown> = {};
  for (const [envName, envEntry] of Object.entries(environments)) {
    if (envEntry && typeof envEntry === "object" && envEntry.values) {
      const unwrapped: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(envEntry.values)) {
        unwrapped[key] = item && typeof item === "object" && "value" in item ? item.value : item;
      }
      result[envName] = { values: unwrapped };
    } else {
      result[envName] = envEntry;
    }
  }
  return result;
}

/**
 * @internal Construct a typed Config from a wire resource. The runtime
 * uses these only to resolve values for the local cache; they do not
 * support `.save()` or `.delete()` (use `mgmt.config.*` instead).
 */
function resourceToConfig(resource: ConfigResource): Config {
  const attrs = resource.attributes;
  return new Config(null, {
    id: resource.id ?? null,
    name: attrs.name,
    description: attrs.description ?? null,
    parent: attrs.parent ?? null,
    items: extractItemValues(attrs.items as Record<string, { value: unknown }> | null | undefined),
    environments: extractEnvironments(
      attrs.environments as
        | Record<string, { values?: Record<string, { value: unknown }> | null }>
        | null
        | undefined,
    ),
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

/**
 * Runtime client for the smplkit Config service.
 *
 * Obtained via `SmplClient.config`. Provides live config values, change
 * listeners, and lazy initialization. Management/CRUD lives on
 * `SmplClient.manage.config` (or use a standalone {@link SmplManagementClient}).
 */
export class ConfigClient {
  /** @internal */
  readonly _apiKey: string;

  /** @internal */
  readonly _baseUrl: string;

  /** @internal */
  private readonly _http: ReturnType<typeof createClient<import("../generated/config.d.ts").paths>>;

  /** @internal — returns the shared WebSocket for real-time updates. */
  _getSharedWs?: () => import("../ws.js").SharedWebSocket;

  /** @internal — set by SmplClient after construction. */
  _parent: {
    readonly _environment: string;
    readonly _service: string | null;
    readonly _metrics: MetricsReporter | null;
  } | null = null;

  /** @internal — resolves the management config sub-client used by lazy-init/refresh. */
  _resolveManagement?: () => SmplManagementClient;

  private _configCache: Record<string, Record<string, unknown>> = {};
  private _initialized = false;
  private _listeners: ChangeListener[] = [];

  /** @internal */
  constructor(apiKey: string, timeout?: number, baseUrl?: string) {
    this._apiKey = apiKey;
    const resolvedBaseUrl = baseUrl ?? BASE_URL;
    this._baseUrl = resolvedBaseUrl;
    const ms = timeout ?? 30_000;
    this._http = createClient<import("../generated/config.d.ts").paths>({
      baseUrl: resolvedBaseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      fetch: async (request: Request): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
          return await fetch(new Request(request, { signal: controller.signal }));
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw new SmplTimeoutError(`Request timed out after ${ms}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }

  // ------------------------------------------------------------------
  // Runtime: resolve and subscribe
  // ------------------------------------------------------------------

  /**
   * Return a live, dict-like view of the resolved values for *id*.
   *
   * Without `model`, returns a {@link LiveConfigProxy} that behaves like a
   * `Record<string, unknown>` (`proxy["key"]`, iteration, `proxy.items()`,
   * `Object.keys(proxy)`) and updates automatically as the server pushes
   * changes.
   *
   * With `model`, the return value type-checks as `model` — attribute
   * access (`cfg.database.host`) walks a model rebuilt from the current
   * values on each read, so the customer sees the model's type signature
   * in their IDE while still tracking live data.
   *
   * Mirrors Python's `client.config.get(id)` / `client.config.get(id, ModelCls)`.
   * There is no `subscribe()` — it was unified into `get()`.
   */
  async get<T = Record<string, unknown>>(
    id: string,
    model?: new (data: any) => T,
  ): Promise<LiveConfigProxy<T>> {
    await this._ensureInitialized();
    if (!(id in this._configCache)) {
      throw new SmplNotFoundError(`Config with id '${id}' not found in cache`);
    }
    const metrics = this._parent?._metrics;
    if (metrics) {
      metrics.record("config.resolutions", 1, "resolutions", { config: id });
    }
    return new LiveConfigProxy<T>(this, id, model);
  }

  // ------------------------------------------------------------------
  // Runtime: change listeners (3-level overloads)
  // ------------------------------------------------------------------

  /**
   * Register a change listener.
   *
   * - `onChange(callback)` — fires for any config change (global).
   * - `onChange(configId, callback)` — fires for changes to a specific config.
   * - `onChange(configId, itemKey, callback)` — fires for a specific item.
   */
  onChange(
    callbackOrConfigId: string | ((event: ConfigChangeEvent) => void),
    callbackOrItemKey?: string | ((event: ConfigChangeEvent) => void),
    callback?: (event: ConfigChangeEvent) => void,
  ): void {
    if (typeof callbackOrConfigId === "function") {
      // Global listener: onChange(callback)
      this._listeners.push({
        callback: callbackOrConfigId,
        configId: null,
        itemKey: null,
      });
    } else if (typeof callbackOrItemKey === "function") {
      // Config-scoped: onChange(configId, callback)
      this._listeners.push({
        callback: callbackOrItemKey,
        configId: callbackOrConfigId,
        itemKey: null,
      });
    } else if (typeof callbackOrItemKey === "string" && callback) {
      // Item-scoped: onChange(configId, itemKey, callback)
      this._listeners.push({
        callback,
        configId: callbackOrConfigId,
        itemKey: callbackOrItemKey,
      });
    }
  }

  // ------------------------------------------------------------------
  // Runtime: refresh
  // ------------------------------------------------------------------

  /**
   * Refresh all config values from the server.
   * Fires change listeners for any values that changed.
   */
  async refresh(): Promise<void> {
    if (!this._initialized) {
      throw new SmplError("Config not initialized. Call get() first.");
    }
    const environment = this._parent?._environment;
    if (!environment) {
      throw new SmplError("No environment set.");
    }
    const configs = await this._listConfigs();
    const newCache: Record<string, Record<string, unknown>> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      newCache[cfg.id!] = resolveChain(chain, environment);
    }
    const oldCache = this._configCache;
    this._configCache = newCache;
    this._diffAndFire(oldCache, newCache, "manual");
  }

  /**
   * @internal — fetch the full config list. Prefers the management plane
   * (set via `_resolveManagement`) so runtime + management share one HTTP
   * client; falls back to a direct GET when running without `SmplClient`
   * bootstrap (e.g. unit tests that construct `ConfigClient` directly).
   */
  private async _listConfigs(): Promise<Config[]> {
    if (this._resolveManagement) {
      return this._resolveManagement().config.list();
    }
    const result = await this._http.GET("/api/v1/configs", {});
    if (!result.response.ok) {
      throw new SmplError(`Failed to list configs: ${result.response.status}`);
    }
    const data = result.data;
    if (!data) return [];
    return data.data.map((r) => resourceToConfig(r));
  }

  // ------------------------------------------------------------------
  // Runtime: lazy initialization
  // ------------------------------------------------------------------

  /**
   * Eagerly initialize the config subclient — fetch all configs, resolve
   * environment-scoped values into the local cache, and subscribe to the
   * shared WebSocket for live updates. Idempotent. Called automatically
   * on first `client.config.get(...)` if not invoked manually.
   */
  async start(): Promise<void> {
    return this._ensureInitialized();
  }

  /** @internal */
  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    const environment = this._parent?._environment;
    if (!environment) {
      throw new SmplError("No environment set. Ensure SmplClient is configured.");
    }
    const configs = await this._listConfigs();
    const cache: Record<string, Record<string, unknown>> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      cache[cfg.id!] = resolveChain(chain, environment);
    }
    this._configCache = cache;
    this._initialized = true;

    // Wire WebSocket for real-time updates
    if (this._getSharedWs) {
      const ws = this._getSharedWs();
      ws.on("config_changed", this._handleConfigChanged);
      ws.on("config_deleted", this._handleConfigDeleted);
      ws.on("configs_changed", this._handleConfigsChanged);
    }
  }

  /** @internal — called by SmplClient for backward compat. */
  async _connectInternal(environment: string): Promise<void> {
    if (this._initialized) return;
    const configs = await this._listConfigs();
    const cache: Record<string, Record<string, unknown>> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      cache[cfg.id!] = resolveChain(chain, environment);
    }
    this._configCache = cache;
    this._initialized = true;
  }

  /** @internal — get resolved config from cache. Used by LiveConfigProxy. */
  _getCachedConfig(key: string): Record<string, unknown> | undefined {
    return this._configCache[key];
  }

  // ------------------------------------------------------------------
  // Internal: WebSocket handler
  // ------------------------------------------------------------------

  private _handleConfigChanged = (data: Record<string, any>): void => {
    debug("websocket", `config_changed event received: ${JSON.stringify(data)}`);
    const configKey = data.id as string | undefined;
    if (!configKey) return;
    // Scoped fetch: GET /configs/{key}
    void this._fetchSingleConfig(configKey)
      .then((newConfig) => {
        const environment = this._parent?._environment;
        if (!environment) return;
        const oldValues = this._configCache[configKey];
        let newValues: Record<string, unknown>;
        if (newConfig !== null) {
          // Build a temporary chain with just this config (for simplicity, no parent resolution)
          newValues = this._resolveConfigValues(newConfig, environment);
        } else {
          newValues = {};
        }
        const oldJson = JSON.stringify(oldValues ?? {});
        const newJson = JSON.stringify(newValues);
        if (oldJson === newJson) return; // no change
        const oldCache = { ...this._configCache };
        if (newConfig !== null) {
          this._configCache[configKey] = newValues;
        } else {
          delete this._configCache[configKey];
        }
        this._diffAndFire(oldCache, this._configCache, "websocket");
      })
      .catch((err: unknown) => {
        debug(
          "websocket",
          `config_changed handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  private _handleConfigDeleted = (data: Record<string, any>): void => {
    debug("websocket", `config_deleted event received: ${JSON.stringify(data)}`);
    const configKey = data.id as string | undefined;
    if (!configKey) return;
    // Remove from cache — no HTTP fetch
    if (configKey in this._configCache) {
      const oldCache = { ...this._configCache };
      delete this._configCache[configKey];
      this._diffAndFire(oldCache, this._configCache, "websocket");
    }
  };

  private _handleConfigsChanged = (_data: Record<string, any>): void => {
    debug("websocket", `configs_changed event received`);
    // Full list fetch, rebuild resolution, fire listeners
    void this.refresh().catch(() => {
      // ignore refresh errors from WebSocket events
    });
  };

  // ------------------------------------------------------------------
  // Internal: change detection
  // ------------------------------------------------------------------

  /** Fetch a single config by key. Returns null if not found. @internal */
  private async _fetchSingleConfig(key: string): Promise<Config | null> {
    debug("api", `GET /api/v1/configs/${key}`);
    try {
      const result = await this._http.GET("/api/v1/configs/{id}", {
        params: { path: { id: key } },
      });
      if (!result.response.ok) return null;
      if (!result.data?.data) return null;
      return resourceToConfig(result.data.data);
    } catch {
      return null;
    }
  }

  /** Resolve a config's values for an environment (no parent chain). @internal */
  private _resolveConfigValues(config: Config, environment: string): Record<string, unknown> {
    // Merge base items with environment overrides
    const base = config.items ?? {};
    const envEntry = (config.environments as Record<string, any>)?.[environment];
    if (!envEntry?.values) return { ...base };
    return { ...base, ...envEntry.values };
  }

  /** @internal */
  private _diffAndFire(
    oldCache: Record<string, Record<string, unknown>>,
    newCache: Record<string, Record<string, unknown>>,
    source: "websocket" | "manual",
  ): void {
    const allConfigKeys = new Set([...Object.keys(oldCache), ...Object.keys(newCache)]);
    for (const cfgKey of allConfigKeys) {
      const oldItems = oldCache[cfgKey] ?? {};
      const newItems = newCache[cfgKey] ?? {};
      const allItemKeys = new Set([...Object.keys(oldItems), ...Object.keys(newItems)]);
      for (const iKey of allItemKeys) {
        const oldVal = iKey in oldItems ? oldItems[iKey] : null;
        const newVal = iKey in newItems ? newItems[iKey] : null;
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          const metrics = this._parent?._metrics;
          if (metrics) {
            metrics.record("config.changes", 1, "changes", { config: cfgKey });
          }
          const event = new ConfigChangeEvent({
            configId: cfgKey,
            itemKey: iKey,
            oldValue: oldVal,
            newValue: newVal,
            source,
          });
          for (const listener of this._listeners) {
            if (listener.configId !== null && listener.configId !== cfgKey) continue;
            if (listener.itemKey !== null && listener.itemKey !== iKey) continue;
            try {
              listener.callback(event);
            } catch {
              // ignore listener errors
            }
          }
        }
      }
    }
  }
}
