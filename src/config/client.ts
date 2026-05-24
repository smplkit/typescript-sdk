/**
 * ConfigClient — runtime client for Smpl Config.
 *
 * Two ways to read config values:
 *
 * - {@link ConfigClient.bind} — declarative, schema-first. Pass an object
 *   literal (or class instance) with the in-code defaults; the SDK
 *   registers the schema and values, then mutates the *same* object in
 *   place when the server pushes updates. Reads are plain property
 *   access on a real object — no proxy indirection.
 * - {@link ConfigClient.get} — lookup. With one argument returns a
 *   {@link LiveConfigProxy} (dict-like view). With two arguments returns
 *   a single value (raises on missing). With three arguments returns the
 *   value or the supplied default and auto-registers the key for
 *   code-first console observability.
 *
 * Management/CRUD lives on `mgmt.config.*`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/config.d.ts";
import { SmplkitNotFoundError, SmplkitError, SmplkitTimeoutError } from "../errors.js";
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

/** Sentinel that distinguishes "default not supplied" from "default is undefined"
 *  in the three-arg {@link ConfigClient.get} form. @internal */
const MISSING: unique symbol = Symbol("smplkit.config.get.MISSING");

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
 * Extract environment overrides from the wire shape.
 *
 * Per ADR-024 §2.4 the wire shape is now flat — `{env: {key: raw}}` —
 * so this is a defensive shallow copy of the input.
 * @internal
 */
function extractEnvironments(
  environments: Record<string, Record<string, unknown>> | null | undefined,
): Record<string, Record<string, unknown>> {
  if (!environments) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [envName, envEntry] of Object.entries(environments)) {
    if (envEntry && typeof envEntry === "object" && !Array.isArray(envEntry)) {
      result[envName] = { ...envEntry };
    } else {
      result[envName] = {};
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
      attrs.environments as Record<string, Record<string, unknown>> | null | undefined,
    ),
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

/**
 * Map a runtime value (bind value or get default) to a Config item type.
 *
 * Used to infer the type that lands in the discovery payload. `boolean` is
 * checked before `number` because `typeof true === "boolean"` already
 * disambiguates them — we follow the same ordering as the Python SDK for
 * symmetry.
 * @internal
 */
function valueToItemType(value: unknown): string {
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "string") return "STRING";
  return "STRING";
}

/**
 * Plain "object literal" predicate — a record whose prototype is either
 * `Object.prototype` or `null`. Distinguishes the dict-bind path (plain
 * objects) from the class-instance-bind path (anything else). For class
 * instances, every property is treated as an explicit override; nested
 * recursion only descends into plain sub-objects so we don't accidentally
 * dot-flatten random class-instance attributes.
 * @internal
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk a bound object and yield `[key, type, value]` triples flattened to
 * dot-notation. Nested plain objects are descended into; class instances
 * and arrays are treated as opaque leaves so users don't accidentally
 * unpack a complex object's internals into config keys.
 * @internal
 */
function iterObjectItems(
  obj: Record<string, unknown>,
  prefix: string = "",
): Array<[string, string, unknown]> {
  const out: Array<[string, string, unknown]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = `${prefix}${key}`;
    if (isPlainObject(value)) {
      out.push(...iterObjectItems(value, `${flatKey}.`));
      continue;
    }
    out.push([flatKey, valueToItemType(value), value]);
  }
  return out;
}

/**
 * Apply a server-pushed value to a bound target in place.
 *
 * Walks the dotted key path to the leaf's parent, then assigns the value
 * via property assignment (works for both plain objects and class
 * instances; both are reference types in JS). Bails silently if any
 * intermediate is missing or non-object.
 * @internal
 */
function applyChangeToTarget(target: object, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split(".");
  let current: any = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current === null || typeof current !== "object" || !(part in current)) return;
    current = current[part];
  }
  if (current === null || typeof current !== "object") return;
  current[parts[parts.length - 1]] = value;
}

/**
 * Runtime client for the smplkit Config service.
 *
 * Obtained via `SmplClient.config`. Provides {@link bind} (the declarative
 * path), {@link get} (lookup), change listeners, and lazy initialization.
 * Management/CRUD lives on `SmplClient.manage.config` (or use a standalone
 * {@link SmplManagementClient}).
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
  /** Raw Config objects keyed by id, kept around so a single-config
   * change (WS event) can refetch one config and rebuild the resolved
   * cache for everyone (including descendants that inherit from it)
   * without a full re-list. Mirrors Python's `_raw_config_cache`. */
  private _configStore: Record<string, Config> = {};
  /** Cache of LiveConfigProxy instances by config id — ensures repeat
   * `get(id)` calls return the same handle. */
  private _proxies: Record<string, LiveConfigProxy> = {};
  /** Bound targets (plain objects or class instances) keyed by config
   * id. WebSocket dispatch mutates these in place when values change. */
  private _bindings: Map<string, object> = new Map();
  private _initialized = false;
  private _listeners: ChangeListener[] = [];

  /** @internal */
  constructor(
    apiKey: string,
    timeout?: number,
    baseUrl?: string,
    extraHeaders?: Record<string, string>,
  ) {
    this._apiKey = apiKey;
    const resolvedBaseUrl = baseUrl ?? BASE_URL;
    this._baseUrl = resolvedBaseUrl;
    const ms = timeout ?? 30_000;
    this._http = createClient<import("../generated/config.d.ts").paths>({
      baseUrl: resolvedBaseUrl,
      headers: {
        ...(extraHeaders ?? {}),
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
            throw new SmplkitTimeoutError(`Request timed out after ${ms}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    });
  }

  // ------------------------------------------------------------------
  // Public API: bind, get
  // ------------------------------------------------------------------

  /**
   * Bind an object to a config id; return the same object back, live.
   *
   * Declarative, code-first API. The object's keys are the schema; its
   * values are the in-code defaults. On first boot:
   *
   * 1. Every leaf (recursively, through nested plain objects) is
   *    registered with the server as a config item, with its value as
   *    the in-code default and a type inferred from `typeof value`.
   * 2. After the SDK's cache is populated, any server-side overrides for
   *    this config are applied to the bound object in place.
   *
   * On every WebSocket-delivered change thereafter the bound object is
   * mutated in place — readers of `obj.foo` and `obj["foo"]` always see
   * the current resolved value. The returned object is the same one you
   * passed in (referential identity preserved).
   *
   * Idempotent. Repeated calls with the same id return the originally-
   * bound object; the new `config` argument is ignored.
   *
   * **Plain object literals vs. class instances.** Plain object literals
   * (e.g., `{ a: 1, b: { c: 2 } }`) are the recommended input shape —
   * their keys are the explicit override set, and omitted keys inherit
   * from `parent`. Class instances are also accepted, but every
   * enumerable property is registered as an explicit override (there is
   * no JS equivalent of Python's `model_fields_set`); to get omit-to-
   * inherit semantics, use a plain object literal.
   *
   * @param id - The config id to register under.
   * @param config - A plain object literal (recommended) or class
   *   instance carrying the in-code defaults.
   * @param options - Optional `parent`: another object previously
   *   returned from a {@link bind} call. Activates parent-chain
   *   inheritance for keys the caller omitted.
   * @returns The same `config` object, registered and live.
   * @throws TypeError if `config` is not an object.
   * @throws Error if `parent` was not previously bound via {@link bind}.
   */
  async bind<T extends object>(
    id: string,
    config: T,
    options: { parent?: object | null } = {},
  ): Promise<T> {
    if (config === null || typeof config !== "object") {
      throw new TypeError(`bind() requires an object; got ${typeof config}`);
    }

    const existing = this._bindings.get(id);
    if (existing !== undefined) {
      return existing as T;
    }

    let parentId: string | null = null;
    if (options.parent !== undefined && options.parent !== null) {
      parentId = this._configIdFor(options.parent);
      if (parentId === null) {
        throw new Error(
          "bind(): parent must be an object previously returned from client.config.bind(). " +
            "Bind the parent first.",
        );
      }
    }

    // Derive a console display name from the class (for class instances)
    // or leave null (plain object literals have no class to introspect).
    const ctor = (config as any).constructor;
    const className =
      typeof ctor === "function" && ctor !== Object && typeof ctor.name === "string" && ctor.name
        ? (ctor.name as string)
        : null;

    this._observeConfigDeclaration(id, parentId, className, null);

    for (const [itemKey, itemType, value] of iterObjectItems(config as Record<string, unknown>)) {
      this._observeItemDeclaration(id, itemKey, itemType, value, undefined);
    }

    // Register the binding BEFORE _ensureInitialized so WS dispatch (which
    // can fire during the initial fetch) finds it.
    this._bindings.set(id, config);

    await this._ensureInitialized();
    this._syncTargetFromCache(config, id);
    return config;
  }

  /**
   * Read a config (full) or a single value within a config.
   *
   * Three forms dispatched by argument count:
   *
   * - `get(id)` — returns a {@link LiveConfigProxy}, a live dict-like
   *   view. Throws {@link SmplkitNotFoundError} if the config is missing.
   *   No registration.
   * - `get(id, key)` — returns the resolved value of `key` within `id`.
   *   Throws {@link SmplkitNotFoundError} if either the config or the key
   *   is missing. No registration.
   * - `get(id, key, defaultValue)` — returns the resolved value, falling
   *   back to `defaultValue` if either is missing. Never throws. Also
   *   **registers** the config (if new) and the key (with `defaultValue`
   *   as its default value) for code-first console observability.
   *
   * For typed access via a Pydantic-style declarative API, use
   * {@link bind} instead.
   */
  async get(id: string): Promise<LiveConfigProxy>;
  async get(id: string, key: string): Promise<unknown>;
  async get<V>(id: string, key: string, defaultValue: V): Promise<V | unknown>;
  async get(id: string, key?: string, defaultValue: unknown = MISSING): Promise<unknown> {
    await this._ensureInitialized();

    if (key === undefined) {
      // Form 1: full config.
      if (!(id in this._configCache)) {
        throw new SmplkitNotFoundError(`Config with id '${id}' not found in cache`);
      }
      const metrics = this._parent?._metrics;
      if (metrics) {
        metrics.record("config.resolutions", 1, "resolutions", { config: id });
      }
      return this._cachedProxy(id);
    }

    // Forms 2 and 3: single-value lookup.
    const hasDefault = defaultValue !== MISSING;
    if (hasDefault) {
      // Register the config + key so the reference shows up in the
      // console even when no schema was declared via bind(). The buffer
      // is idempotent at the (configId, itemKey) level.
      this._observeConfigDeclaration(id, null, null, null);
      this._observeItemDeclaration(id, key, valueToItemType(defaultValue), defaultValue, undefined);
    }

    if (!(id in this._configCache)) {
      if (hasDefault) return defaultValue;
      throw new SmplkitNotFoundError(`Config with id '${id}' not found in cache`);
    }
    const values = this._configCache[id];
    if (!(key in values)) {
      if (hasDefault) return defaultValue;
      throw new SmplkitNotFoundError(`Config item '${key}' not found in config '${id}'`);
    }
    return values[key];
  }

  // ------------------------------------------------------------------
  // Internal: binding helpers
  // ------------------------------------------------------------------

  /** @internal — return the config_id this object was bound under, or null. */
  private _configIdFor(target: object): string | null {
    for (const [cid, bound] of this._bindings) {
      if (bound === target) return cid;
    }
    return null;
  }

  /** @internal — apply current cached values to a freshly-bound target. */
  private _syncTargetFromCache(target: object, configId: string): void {
    const cache = this._configCache[configId];
    if (!cache) return;
    for (const [dottedKey, value] of Object.entries(cache)) {
      applyChangeToTarget(target, dottedKey, value);
    }
  }

  /** @internal — return (and cache) the canonical proxy for a config id. */
  _cachedProxy(id: string): LiveConfigProxy {
    let proxy = this._proxies[id];
    if (!proxy) {
      proxy = new LiveConfigProxy(this, id);
      this._proxies[id] = proxy;
    }
    return proxy;
  }

  /** @internal — queue a config declaration with the management buffer. */
  _observeConfigDeclaration(
    configId: string,
    parent: string | null,
    name: string | null,
    description: string | null,
  ): void {
    const manage = this._resolveManagement?.();
    if (!manage) return;
    manage.config.registerConfig(configId, {
      service: this._parent?._service ?? null,
      environment: this._parent?._environment ?? "",
      parent,
      name,
      description,
    });
  }

  /** @internal — queue a config item declaration with the management buffer. */
  _observeItemDeclaration(
    configId: string,
    itemKey: string,
    itemType: string,
    defaultValue: unknown,
    description?: string,
  ): void {
    const manage = this._resolveManagement?.();
    if (!manage) return;
    manage.config.registerConfigItem(
      configId,
      itemKey,
      itemType,
      defaultValue,
      description ?? null,
    );
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
      this._listeners.push({
        callback: callbackOrConfigId,
        configId: null,
        itemKey: null,
      });
    } else if (typeof callbackOrItemKey === "function") {
      this._listeners.push({
        callback: callbackOrItemKey,
        configId: callbackOrConfigId,
        itemKey: null,
      });
    } else if (typeof callbackOrItemKey === "string" && callback) {
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
      throw new SmplkitError("Config not initialized. Call get() or bind() first.");
    }
    const environment = this._parent?._environment;
    if (!environment) {
      throw new SmplkitError("No environment set.");
    }
    const configs = await this._listConfigs();
    const newCache: Record<string, Record<string, unknown>> = {};
    const newStore: Record<string, Config> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      newCache[cfg.id!] = resolveChain(chain, environment);
      newStore[cfg.id!] = cfg;
    }
    const oldCache = this._configCache;
    this._configCache = newCache;
    this._configStore = newStore;
    this._diffAndFire(oldCache, newCache, "manual");
  }

  /**
   * @internal — fetch the full config list. Prefers the management plane
   * (set via `_resolveManagement`) so runtime + management share one HTTP
   * client; falls back to a direct GET when running without `SmplClient`
   * bootstrap (e.g. unit tests that construct `ConfigClient` directly).
   */
  private async _listConfigs(): Promise<Config[]> {
    const PAGE_SIZE = 1000;
    const all: Config[] = [];
    let page = 1;
    let lastPageWasFull = true;
    while (lastPageWasFull) {
      let rows: Config[];
      if (this._resolveManagement) {
        rows = await this._resolveManagement().config.list({
          pageNumber: page,
          pageSize: PAGE_SIZE,
        });
      } else {
        const result = await this._http.GET("/api/v1/configs", {
          params: {
            query: {
              "page[number]": page,
              "page[size]": PAGE_SIZE,
            } as unknown as Record<string, never>,
          },
        });
        if (!result.response.ok) {
          throw new SmplkitError(`Failed to list configs: ${result.response.status}`);
        }
        const data = result.data;
        rows = data ? data.data.map((r) => resourceToConfig(r)) : [];
      }
      all.push(...rows);
      lastPageWasFull = rows.length === PAGE_SIZE;
      page++;
    }
    return all;
  }

  // ------------------------------------------------------------------
  // Runtime: lazy initialization
  // ------------------------------------------------------------------

  /**
   * Eagerly initialize the config subclient — fetch all configs, resolve
   * environment-scoped values into the local cache, and subscribe to the
   * shared WebSocket for live updates. Idempotent. Called automatically
   * on first `client.config.get(...)` / `client.config.bind(...)` if not
   * invoked manually.
   */
  async start(): Promise<void> {
    return this._ensureInitialized();
  }

  /** @internal */
  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    const environment = this._parent?._environment;
    if (!environment) {
      throw new SmplkitError("No environment set. Ensure SmplClient is configured.");
    }

    // Per ADR-037 §2.14: flush any buffered discovery declarations BEFORE
    // the initial fetch so newly-discovered configs appear in the cache.
    const manage = this._resolveManagement?.();
    if (manage) {
      try {
        await manage.config.flush();
      } catch (err) {
        debug(
          "config",
          `pre-start discovery flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const configs = await this._listConfigs();
    const cache: Record<string, Record<string, unknown>> = {};
    const store: Record<string, Config> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      cache[cfg.id!] = resolveChain(chain, environment);
      store[cfg.id!] = cfg;
    }
    this._configCache = cache;
    this._configStore = store;
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
    const store: Record<string, Config> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      cache[cfg.id!] = resolveChain(chain, environment);
      store[cfg.id!] = cfg;
    }
    this._configCache = cache;
    this._configStore = store;
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
    const environment = this._parent?._environment;
    if (!environment) return;
    void this._fetchSingleConfig(configKey)
      .then((newConfig) => {
        const newStore = { ...this._configStore };
        if (newConfig === null) {
          delete newStore[configKey];
        } else {
          newStore[configKey] = newConfig;
        }
        const allConfigs = Object.values(newStore);
        return Promise.all(
          allConfigs.map(async (cfg) => {
            const chain = await cfg._buildChain(allConfigs);
            return [cfg.id!, resolveChain(chain, environment)] as const;
          }),
        ).then((entries) => ({ entries, newStore }));
      })
      .then(({ entries, newStore }) => {
        const newCache: Record<string, Record<string, unknown>> = {};
        for (const [id, values] of entries) newCache[id] = values;
        const oldCache = this._configCache;
        this._configCache = newCache;
        this._configStore = newStore;
        this._diffAndFire(oldCache, newCache, "websocket");
      })
      .catch((err: unknown) => {
        debug(
          "websocket",
          `config_changed handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

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

  private _handleConfigDeleted = (data: Record<string, any>): void => {
    debug("websocket", `config_deleted event received: ${JSON.stringify(data)}`);
    const configKey = data.id as string | undefined;
    if (!configKey) return;
    if (configKey in this._configCache) {
      const oldCache = { ...this._configCache };
      delete this._configCache[configKey];
      this._diffAndFire(oldCache, this._configCache, "websocket");
    }
  };

  private _handleConfigsChanged = (_data: Record<string, any>): void => {
    debug("websocket", `configs_changed event received`);
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
      const target = this._bindings.get(cfgKey);
      for (const iKey of allItemKeys) {
        const oldVal = iKey in oldItems ? oldItems[iKey] : null;
        const newVal = iKey in newItems ? newItems[iKey] : null;
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          // Apply to bound target first so listeners reading the object
          // see the new value.
          if (target !== undefined) {
            applyChangeToTarget(target, iKey, newVal);
          }
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
