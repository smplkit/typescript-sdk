/**
 * ConfigClient — management-plane operations for configs.
 *
 * Uses the generated OpenAPI types (`src/generated/config.d.ts`) via
 * `openapi-fetch` for all HTTP calls, keeping the client layer fully
 * type-safe without hand-coded request/response shapes.
 */

import createClient from "openapi-fetch";
import type { components, operations } from "../generated/config.d.ts";
import {
  SmplConflictError,
  SmplNotFoundError,
  SmplNotConnectedError,
  SmplValidationError,
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  throwForStatus,
} from "../errors.js";
import { resolveChain } from "./resolve.js";
import { Config } from "./types.js";
import type { ConfigUpdatePayload, CreateConfigOptions, GetConfigOptions } from "./types.js";

/** Describes a single config value change detected on refresh. */
export interface ConfigChangeEvent {
  /** The config key that changed. */
  configKey: string;
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
  configKey: string | null;
  itemKey: string | null;
}

const BASE_URL = "https://config.smplkit.com";

type ApiConfig = components["schemas"]["Config"];
type ApiConfigOutput = components["schemas"]["Config"];
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
  const attrs: ApiConfigOutput = resource.attributes;
  return new Config(client, {
    id: resource.id ?? "",
    key: attrs.key ?? "",
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
    createdAt: attrs.created_at ? new Date(attrs.created_at) : null,
    updatedAt: attrs.updated_at ? new Date(attrs.updated_at) : null,
  });
}

/**
 * Map fetch or HTTP errors to typed SDK exceptions.
 * @internal
 */
async function checkError(response: Response, _context: string): Promise<never> {
  const body = await response.text().catch(() => "");
  throwForStatus(response.status, body);
}

/**
 * Re-raise fetch-level errors (network, timeout) as typed SDK exceptions.
 * @internal
 */
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
  key?: string | null;
  description?: string | null;
  parent?: string | null;
  items?: Record<string, unknown> | null;
  environments?: Record<string, unknown> | null;
}): operations["create_config"]["requestBody"]["content"]["application/json"] {
  const attrs: ApiConfig = {
    name: options.name,
  };
  if (options.key !== undefined) attrs.key = options.key;
  if (options.description !== undefined) attrs.description = options.description;
  if (options.parent !== undefined) attrs.parent = options.parent;
  if (options.items !== undefined)
    attrs.items = wrapItemValues(options.items) as ApiConfig["items"];
  if (options.environments !== undefined)
    attrs.environments = wrapEnvironments(options.environments) as ApiConfig["environments"];

  return {
    data: {
      id: options.id ?? null,
      type: "config",
      attributes: attrs,
    },
  };
}

/**
 * Client for the smplkit Config API (management plane).
 *
 * All methods are async and return `Promise<T>`. Network and server
 * errors are mapped to typed SDK exceptions.
 *
 * Obtained via `SmplClient.config`.
 */
export class ConfigClient {
  /** @internal — used by Config instances for reconnecting and WebSocket auth. */
  readonly _apiKey: string;

  /** @internal */
  readonly _baseUrl: string = BASE_URL;

  /** @internal */
  private readonly _http: ReturnType<typeof createClient<import("../generated/config.d.ts").paths>>;

  /** @internal — returns the shared WebSocket for real-time updates. */
  _getSharedWs?: () => import("../ws.js").SharedWebSocket;

  /** @internal — set by SmplClient after construction. */
  _parent: { readonly _environment: string; readonly _service: string | null } | null = null;

  private _configCache: Record<string, Record<string, unknown>> = {};
  private _connected = false;
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
      // openapi-fetch custom fetch receives a pre-built Request object
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

  /**
   * Fetch a single config by key or UUID.
   *
   * Exactly one of `key` or `id` must be provided.
   *
   * @throws {SmplNotFoundError} If no matching config exists.
   */
  async get(options: GetConfigOptions): Promise<Config> {
    const { key, id } = options;
    if ((key === undefined) === (id === undefined)) {
      throw new Error("Exactly one of 'key' or 'id' must be provided.");
    }
    return id !== undefined ? this._getById(id) : this._getByKey(key!);
  }

  /**
   * List all configs for the account.
   */
  async list(): Promise<Config[]> {
    let data: components["schemas"]["ConfigListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs", {});
      if (result.error !== undefined) await checkError(result.response, "Failed to list configs");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToConfig(r, this));
  }

  /**
   * Create a new config.
   *
   * @throws {SmplValidationError} If the server rejects the request.
   */
  async create(options: CreateConfigOptions): Promise<Config> {
    const body = buildRequestBody({
      name: options.name,
      key: options.key,
      description: options.description,
      parent: options.parent,
      items: options.items,
    });

    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/configs", { body });
      if (result.error !== undefined) await checkError(result.response, "Failed to create config");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError("Failed to create config");
    return resourceToConfig(data.data, this);
  }

  /**
   * Delete a config by UUID.
   *
   * @throws {SmplNotFoundError} If the config does not exist.
   * @throws {SmplConflictError} If the config has child configs.
   */
  async delete(configId: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/configs/{id}", {
        params: { path: { id: configId } },
      });
      if (result.error !== undefined && result.response.status !== 204)
        await checkError(result.response, `Failed to delete config ${configId}`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * Fetch all configs, resolve values for the environment, and cache.
   * @internal — called by SmplClient.connect().
   */
  async _connectInternal(environment: string): Promise<void> {
    const configs = await this.list();
    const cache: Record<string, Record<string, unknown>> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(this._http);
      cache[cfg.key] = resolveChain(chain, environment);
    }
    this._configCache = cache;
    this._connected = true;
  }

  /**
   * Read a resolved config value (prescriptive access).
   *
   * Requires {@link SmplClient.connect} to have been called.
   *
   * @param configKey - The config key to look up.
   * @param itemKey - Optional specific item key. If omitted, returns all values.
   * @param defaultValue - Default value if the key is missing.
   *
   * @throws {SmplNotConnectedError} If connect() has not been called.
   */
  getValue(configKey: string, itemKey?: string, defaultValue?: unknown): unknown {
    if (!this._connected) {
      throw new SmplNotConnectedError("SmplClient is not connected. Call client.connect() first.");
    }
    const resolved = this._configCache[configKey];
    if (resolved === undefined) {
      return defaultValue ?? null;
    }
    if (itemKey === undefined) {
      return { ...resolved };
    }
    return itemKey in resolved ? resolved[itemKey] : (defaultValue ?? null);
  }

  /**
   * Return a config value as a string, or `defaultValue` if absent or not a string.
   *
   * @throws {SmplNotConnectedError} If connect() has not been called.
   */
  getString(configKey: string, itemKey: string, defaultValue: string | null = null): string | null {
    const value = this.getValue(configKey, itemKey);
    return typeof value === "string" ? value : defaultValue;
  }

  /**
   * Return a config value as a number, or `defaultValue` if absent or not a number.
   *
   * @throws {SmplNotConnectedError} If connect() has not been called.
   */
  getInt(configKey: string, itemKey: string, defaultValue: number | null = null): number | null {
    const value = this.getValue(configKey, itemKey);
    return typeof value === "number" ? value : defaultValue;
  }

  /**
   * Return a config value as a boolean, or `defaultValue` if absent or not a boolean.
   *
   * @throws {SmplNotConnectedError} If connect() has not been called.
   */
  getBool(configKey: string, itemKey: string, defaultValue: boolean | null = null): boolean | null {
    const value = this.getValue(configKey, itemKey);
    return typeof value === "boolean" ? value : defaultValue;
  }

  /**
   * Re-fetch all configs, re-resolve values, and update the cache.
   *
   * Fires change listeners for any values that differ from the previous cache.
   *
   * @throws {SmplNotConnectedError} If connect() has not been called.
   */
  async refresh(): Promise<void> {
    if (!this._connected) {
      throw new SmplNotConnectedError("SmplClient is not connected. Call client.connect() first.");
    }
    const environment = this._parent?._environment;
    if (!environment) {
      throw new SmplError("No environment set.");
    }
    const configs = await this.list();
    const newCache: Record<string, Record<string, unknown>> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(this._http);
      newCache[cfg.key] = resolveChain(chain, environment);
    }
    const oldCache = this._configCache;
    this._configCache = newCache;
    this._diffAndFire(oldCache, newCache, "manual");
  }

  /**
   * Register a listener that fires when a config value changes (on refresh).
   *
   * @param callback - Called with a {@link ConfigChangeEvent} on each change.
   * @param options.configKey - If provided, only fire for changes to this config.
   * @param options.itemKey - If provided, only fire for changes to this item key.
   */
  onChange(
    callback: (event: ConfigChangeEvent) => void,
    options?: { configKey?: string; itemKey?: string },
  ): void {
    this._listeners.push({
      callback,
      configKey: options?.configKey ?? null,
      itemKey: options?.itemKey ?? null,
    });
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
          const event: ConfigChangeEvent = {
            configKey: cfgKey,
            itemKey: iKey,
            oldValue: oldVal,
            newValue: newVal,
            source,
          };
          for (const listener of this._listeners) {
            if (listener.configKey !== null && listener.configKey !== cfgKey) continue;
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

  /**
   * Internal: PUT a full config update and return the updated model.
   *
   * Called by {@link Config} instance methods.
   * @internal
   */
  async _updateConfig(payload: ConfigUpdatePayload): Promise<Config> {
    const body = buildRequestBody({
      id: payload.configId,
      name: payload.name,
      key: payload.key,
      description: payload.description,
      parent: payload.parent,
      items: payload.items,
      environments: payload.environments,
    });

    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/configs/{id}", {
        params: { path: { id: payload.configId } },
        body,
      });
      if (result.error !== undefined)
        await checkError(result.response, `Failed to update config ${payload.configId}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data)
      throw new SmplValidationError(`Failed to update config ${payload.configId}`);
    return resourceToConfig(data.data, this);
  }

  // ---- Private helpers ----

  private async _getById(configId: string): Promise<Config> {
    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs/{id}", {
        params: { path: { id: configId } },
      });
      if (result.error !== undefined)
        await checkError(result.response, `Config ${configId} not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplNotFoundError(`Config ${configId} not found`);
    return resourceToConfig(data.data, this);
  }

  private async _getByKey(key: string): Promise<Config> {
    let data: components["schemas"]["ConfigListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs", {
        params: { query: { "filter[key]": key } },
      });
      if (result.error !== undefined)
        await checkError(result.response, `Config with key '${key}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data || data.data.length === 0) {
      throw new SmplNotFoundError(`Config with key '${key}' not found`);
    }
    return resourceToConfig(data.data[0], this);
  }
}
