/**
 * ConfigClient — management and runtime for Smpl Config.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components, operations } from "../generated/config.d.ts";
import {
  SmplConflictError,
  SmplNotFoundError,
  SmplValidationError,
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  throwForStatus,
} from "../errors.js";
import { resolveChain } from "./resolve.js";
import { Config } from "./types.js";
import { LiveConfigProxy } from "./proxy.js";
import type { MetricsReporter } from "../_metrics.js";
import { keyToDisplayName } from "../helpers.js";
import { debug } from "../_debug.js";

/** Describes a single config value change detected on refresh. */
export interface ConfigChangeEvent {
  /** The config id that changed. */
  configId: string;
  /** The item key within the config that changed. */
  itemKey: string;
  /** The previous value (null if the key was absent). */
  oldValue: unknown;
  /** The updated value (null if the key was removed). */
  newValue: unknown;
  /** How the change was delivered. */
  source: "websocket" | "manual";
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

/** @internal */
function resourceToConfig(resource: ConfigResource, client: ConfigClient): Config {
  const attrs = resource.attributes;
  return new Config(client, {
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

/** @internal */
async function checkError(response: Response, _context: string): Promise<never> {
  const body = await response.text().catch(() => "");
  throwForStatus(response.status, body);
}

/** @internal */
function wrapFetchError(err: unknown): never {
  if (
    err instanceof SmplNotFoundError ||
    err instanceof SmplConflictError ||
    err instanceof SmplValidationError ||
    err instanceof SmplError
  ) {
    throw err;
  }
  if (err instanceof TypeError) {
    throw new SmplConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * Wrap plain values into typed item format for the API.
 * `{key: rawValue}` -> `{key: {value: rawValue}}`
 * @internal
 */
function wrapItemValues(
  values: Record<string, unknown> | null | undefined,
): Record<string, { value: unknown }> | null {
  if (!values) return null;
  const result: Record<string, { value: unknown }> = {};
  for (const [key, val] of Object.entries(values)) {
    result[key] = { value: val };
  }
  return result;
}

/**
 * Wrap plain environment values into the API wire format.
 * SDK format:  `{ env: { values: { key: raw } } }`
 * Wire format: `{ env: { values: { key: { value: raw } } } }`
 * @internal
 */
function wrapEnvironments(
  environments: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!environments) return null;
  const result: Record<string, unknown> = {};
  for (const [envName, envEntry] of Object.entries(environments)) {
    if (envEntry && typeof envEntry === "object" && !Array.isArray(envEntry)) {
      const entry = envEntry as Record<string, unknown>;
      if (entry.values && typeof entry.values === "object" && !Array.isArray(entry.values)) {
        const wrapped: Record<string, { value: unknown }> = {};
        for (const [key, val] of Object.entries(entry.values as Record<string, unknown>)) {
          wrapped[key] = { value: val };
        }
        result[envName] = { ...entry, values: wrapped };
      } else {
        result[envName] = envEntry;
      }
    } else {
      result[envName] = envEntry;
    }
  }
  return result;
}

/**
 * Build a JSON:API request body for create/update operations.
 * @internal
 */
function buildRequestBody(options: {
  id?: string | null;
  name: string;
  description?: string | null;
  parent?: string | null;
  items?: Record<string, unknown> | null;
  environments?: Record<string, unknown> | null;
}): operations["create_config"]["requestBody"]["content"]["application/vnd.api+json"] {
  const attrs: components["schemas"]["Config"] = {
    name: options.name,
  };
  if (options.description !== undefined) attrs.description = options.description;
  if (options.parent !== undefined) attrs.parent = options.parent;
  if (options.items !== undefined)
    attrs.items = wrapItemValues(options.items) as typeof attrs.items;
  if (options.environments !== undefined)
    attrs.environments = wrapEnvironments(options.environments) as typeof attrs.environments;

  return {
    data: {
      id: options.id ?? null,
      type: "config",
      attributes: attrs,
    },
  };
}

/**
 * Management API for smplkit Config — CRUD operations on Config models.
 *
 * Access via `SmplClient.config.management`.
 */
export class ConfigManagement {
  constructor(private readonly _client: ConfigClient) {}

  /** Create an unsaved config. Call `.save()` to persist. */
  new(id: string, options?: { name?: string; description?: string; parent?: string }): Config {
    return this._client._mgNew(id, options);
  }

  /** Fetch a config by id. */
  async get(id: string): Promise<Config> {
    return this._client._getById(id);
  }

  /** List all configs. */
  async list(): Promise<Config[]> {
    return this._client._mgList();
  }

  /** Delete a config by id. */
  async delete(id: string): Promise<void> {
    return this._client._mgDelete(id);
  }
}

/**
 * Client for the smplkit Config API.
 *
 * Obtained via `SmplClient.config`.
 */
export class ConfigClient {
  /** @internal */
  readonly _apiKey: string;

  /** @internal */
  readonly _baseUrl: string = BASE_URL;

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

  /** Management API — CRUD operations on Config models. */
  readonly management: ConfigManagement;

  private _configCache: Record<string, Record<string, unknown>> = {};
  private _initialized = false;
  private _listeners: ChangeListener[] = [];

  /** @internal */
  constructor(apiKey: string, timeout?: number) {
    this._apiKey = apiKey;
    const ms = timeout ?? 30_000;
    this._http = createClient<import("../generated/config.d.ts").paths>({
      baseUrl: BASE_URL,
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
    this.management = new ConfigManagement(this);
  }

  // ------------------------------------------------------------------
  // Management: internal implementations (delegated from ConfigManagement)
  // ------------------------------------------------------------------

  /** @internal */
  _mgNew(id: string, options?: { name?: string; description?: string; parent?: string }): Config {
    return new Config(this, {
      id,
      name: options?.name ?? keyToDisplayName(id),
      description: options?.description ?? null,
      parent: options?.parent ?? null,
      items: {},
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @internal */
  async _mgList(): Promise<Config[]> {
    let data: components["schemas"]["ConfigListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs", {});
      if (!result.response.ok) await checkError(result.response, "Failed to list configs");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToConfig(r, this));
  }

  /** @internal */
  async _mgDelete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/configs/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, `Failed to delete config '${id}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  // ------------------------------------------------------------------
  // Management: internal save methods (called by Config.save())
  // ------------------------------------------------------------------

  /** @internal — POST a new config. */
  async _createConfig(config: Config): Promise<Config> {
    const body = buildRequestBody({
      id: config.id,
      name: config.name,
      description: config.description,
      parent: config.parent,
      items: config.items,
      environments: config.environments,
    });

    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/configs", { body });
      if (!result.response.ok) await checkError(result.response, "Failed to create config");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError("Failed to create config");
    return resourceToConfig(data.data, this);
  }

  /** @internal — PUT a config update. */
  async _updateConfig(config: Config): Promise<Config> {
    const body = buildRequestBody({
      id: config.id,
      name: config.name,
      description: config.description,
      parent: config.parent,
      items: config.items,
      environments: config.environments,
    });

    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/configs/{id}", {
        params: { path: { id: config.id! } },
        body,
      });
      if (!result.response.ok)
        await checkError(result.response, `Failed to update config ${config.id}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError(`Failed to update config ${config.id}`);
    return resourceToConfig(data.data, this);
  }

  /** @internal — fetch a config by id. */
  async _getById(id: string): Promise<Config> {
    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok)
        await checkError(result.response, `Config with id '${id}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplNotFoundError(`Config with id '${id}' not found`);
    return resourceToConfig(data.data, this);
  }

  // ------------------------------------------------------------------
  // Runtime: resolve and subscribe
  // ------------------------------------------------------------------

  /**
   * Get a config's resolved values for the current environment.
   *
   * Returns the resolved key-value pairs for the given config.
   * Optionally pass a model class to map the resolved values.
   */
  async get<T = Record<string, unknown>>(id: string, model?: new (data: any) => T): Promise<T> {
    await this._ensureInitialized();
    const values = this._configCache[id];
    if (values === undefined) {
      throw new SmplNotFoundError(`Config with id '${id}' not found in cache`);
    }
    const metrics = this._parent?._metrics;
    if (metrics) {
      metrics.record("config.resolutions", 1, "resolutions", { config: id });
    }
    if (model) {
      return new model(values);
    }
    return values as T;
  }

  /**
   * Subscribe to a config's values. Returns a proxy whose properties
   * always reflect the latest resolved values.
   *
   * Optionally pass a model class to map the resolved values.
   */
  async subscribe<T = Record<string, unknown>>(
    id: string,
    model?: new (data: any) => T,
  ): Promise<LiveConfigProxy<T>> {
    await this._ensureInitialized();
    if (!(id in this._configCache)) {
      throw new SmplNotFoundError(`Config with id '${id}' not found in cache`);
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
      throw new SmplError("Config not initialized. Call get() or subscribe() first.");
    }
    const environment = this._parent?._environment;
    if (!environment) {
      throw new SmplError("No environment set.");
    }
    const configs = await this.management.list();
    const newCache: Record<string, Record<string, unknown>> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      newCache[cfg.id!] = resolveChain(chain, environment);
    }
    const oldCache = this._configCache;
    this._configCache = newCache;
    this._diffAndFire(oldCache, newCache, "manual");
  }

  // ------------------------------------------------------------------
  // Runtime: lazy initialization
  // ------------------------------------------------------------------

  /** @internal */
  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    const environment = this._parent?._environment;
    if (!environment) {
      throw new SmplError("No environment set. Ensure SmplClient is configured.");
    }
    const configs = await this.management.list();
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
      ws.on("config_deleted", this._handleConfigChanged);
    }
  }

  /** @internal — called by SmplClient for backward compat. */
  async _connectInternal(environment: string): Promise<void> {
    if (this._initialized) return;
    const configs = await this.management.list();
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
    debug("websocket", `config event received: ${JSON.stringify(data)}`);
    void this.refresh().catch(() => {
      // ignore refresh errors from WebSocket events
    });
  };

  // ------------------------------------------------------------------
  // Internal: change detection
  // ------------------------------------------------------------------

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
          const event: ConfigChangeEvent = {
            configId: cfgKey,
            itemKey: iKey,
            oldValue: oldVal,
            newValue: newVal,
            source,
          };
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
