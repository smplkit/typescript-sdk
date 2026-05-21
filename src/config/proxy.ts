/**
 * LiveConfigProxy — live, dict-like, read-only configuration access.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConfigChangeEvent, ConfigClient } from "./client.js";

/**
 * Convert dot-notation keys to a nested object.
 * `{"database.host": "x", "database.port": 5}` → `{database: {host: "x", port: 5}}`.
 *
 * Used when reconstructing a typed model: the resolved-cache stores keys
 * verbatim (`"database.host"`), but the model class expects nested
 * structure (`data.database.host`). Mirrors Python's `_unflatten`.
 * @internal
 */
function _unflattenDotNotation(flat: Record<string, unknown>): Record<string, unknown> {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let current = nested;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (
        current[part] === undefined ||
        typeof current[part] !== "object" ||
        current[part] === null
      ) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return nested;
}

/**
 * A live, dict-like, read-only view of resolved config values.
 *
 * Returned by {@link ConfigClient.get}. Always reflects the latest
 * server-pushed state — every read sees current values.
 *
 * Attribute access returns the current resolved value for the given item
 * key. If a *model* class was provided, the model is reconstructed from
 * the latest values on each access (so attribute access type-checks
 * against the model).
 *
 * Dict-like API: `proxy["key"]`, `key in proxy`, `Object.keys(proxy)`,
 * `proxy.values()`, `proxy.items()`, `proxy.get(key, default)`,
 * iteration via `for (const k in proxy)`.
 *
 * Read-only: `proxy.x = ...`, `delete proxy.x`, `proxy["k"] = ...` all throw.
 *
 * Note: customer config items whose names collide with proxy method names
 * (`keys`, `values`, `items`, `get`, `onChange`) are shadowed for attribute
 * access — use subscript (`proxy["values"]`) for those.
 *
 * @example
 * ```typescript
 * const cfg = await client.config.get("user-service");
 * console.log(cfg.database.host);   // resolved value
 * console.log(cfg["max_retries"]);  // subscript also works
 * for (const key of Object.keys(cfg)) console.log(key);
 *
 * cfg.onChange((event) => console.log(event));
 * cfg.onChange("max_retries", (event) => console.log("retries changed"));
 * ```
 */
export class LiveConfigProxy<T = Record<string, unknown>> {
  /** @internal */
  private readonly _client: ConfigClient;
  /** @internal */
  private readonly _key: string;
  /** @internal */
  private readonly _model?: new (data: any) => T;

  constructor(client: ConfigClient, key: string, model?: new (data: any) => T) {
    this._client = client;
    this._key = key;
    this._model = model;

    const ownMethods = new Set([
      "keys",
      "values",
      "items",
      "get",
      "onChange",
      "getBool",
      "getInt",
      "getFloat",
      "getString",
      "getJson",
      "_currentValues",
      "_registerItem",
    ]);

    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol" || prop === "constructor" || prop === "toJSON") {
          return Reflect.get(target, prop, receiver);
        }
        if (ownMethods.has(prop as string) || (prop as string).startsWith("_")) {
          return Reflect.get(target, prop, receiver);
        }
        const values = target._currentValues();
        if (target._model) {
          // Typed-model construction: unflatten dot-notation keys
          // so {"database.host": "x"} becomes {database: {host: "x"}}
          // before passing to the model constructor — the model
          // expects nested structure, not flat keys. Mirrors Python's
          // `_unflatten` step in LiveConfigProxy.
          const nested = _unflattenDotNotation(values);
          const instance = new target._model(nested) as any;
          return instance[prop];
        }
        return (values as any)[prop];
      },

      set(_target, prop, _value): boolean {
        throw new Error(
          `LiveConfigProxy is read-only; cannot set ${JSON.stringify(String(prop))}. ` +
            "Mutate config values via client.manage.config.*",
        );
      },

      deleteProperty(_target, prop): boolean {
        throw new Error(
          `LiveConfigProxy is read-only; cannot delete ${JSON.stringify(String(prop))}.`,
        );
      },

      has(target, prop) {
        if (typeof prop === "symbol") return Reflect.has(target, prop);
        const values = target._currentValues();
        return prop in values;
      },

      ownKeys(target) {
        const values = target._currentValues();
        return Object.keys(values);
      },

      getOwnPropertyDescriptor(target, prop) {
        if (typeof prop === "symbol") return Reflect.getOwnPropertyDescriptor(target, prop);
        const values = target._currentValues();
        if (prop in values) {
          return {
            configurable: true,
            enumerable: true,
            value: (values as any)[prop],
            writable: false,
          };
        }
        return undefined;
      },
    }) as LiveConfigProxy<T>;
  }

  /** @internal */
  _currentValues(): Record<string, unknown> {
    return this._client._getCachedConfig(this._key) ?? {};
  }

  /** Dict method: list of resolved item keys. */
  keys(): string[] {
    return Object.keys(this._currentValues());
  }

  /** Dict method: list of resolved item values. */
  values(): unknown[] {
    return Object.values(this._currentValues());
  }

  /** Dict method: list of `[key, value]` pairs. */
  items(): Array<[string, unknown]> {
    return Object.entries(this._currentValues());
  }

  /** Dict method: get a value by key, returning `defaultValue` if absent. */
  get<V = unknown>(key: string, defaultValue?: V): V | unknown {
    const values = this._currentValues();
    return key in values ? values[key] : defaultValue;
  }

  // ------------------------------------------------------------------
  // Typed getters (ADR-037 §2.13)
  //
  // Each registers the item (key, type, default, description) on first
  // call within the process, then returns the resolved value. When the
  // resolved value cannot be coerced to the getter's type — including
  // the "not yet set on the server" case — the in-code default is
  // returned and a structured warning is logged.
  // ------------------------------------------------------------------

  /** @internal */
  private _registerItem(itemKey: string, itemType: string, defaultValue: unknown, description?: string): void {
    this._client._observeItemDeclaration(this._key, itemKey, itemType, defaultValue, description);
  }

  /** Read a BOOLEAN item, registering the declaration on first call. */
  getBool(key: string, defaultValue: boolean, options: { description?: string } = {}): boolean {
    this._registerItem(key, "BOOLEAN", defaultValue, options.description);
    const values = this._currentValues();
    if (!(key in values)) return defaultValue;
    const value = values[key];
    if (typeof value === "boolean") return value;
    console.warn(
      `[smplkit] config ${JSON.stringify(this._key)} item ${JSON.stringify(key)}: ` +
        `expected BOOLEAN, got ${typeof value}; returning default`,
    );
    return defaultValue;
  }

  /** Read a NUMBER item as int, registering the declaration on first call. */
  getInt(key: string, defaultValue: number, options: { description?: string } = {}): number {
    this._registerItem(key, "NUMBER", defaultValue, options.description);
    const values = this._currentValues();
    if (!(key in values)) return defaultValue;
    const value = values[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    console.warn(
      `[smplkit] config ${JSON.stringify(this._key)} item ${JSON.stringify(key)}: ` +
        `expected NUMBER (int), got ${typeof value}; returning default`,
    );
    return defaultValue;
  }

  /** Read a NUMBER item as float, registering the declaration on first call. */
  getFloat(key: string, defaultValue: number, options: { description?: string } = {}): number {
    this._registerItem(key, "NUMBER", defaultValue, options.description);
    const values = this._currentValues();
    if (!(key in values)) return defaultValue;
    const value = values[key];
    if (typeof value === "number") return value;
    console.warn(
      `[smplkit] config ${JSON.stringify(this._key)} item ${JSON.stringify(key)}: ` +
        `expected NUMBER (float), got ${typeof value}; returning default`,
    );
    return defaultValue;
  }

  /** Read a STRING item, registering the declaration on first call. */
  getString(key: string, defaultValue: string, options: { description?: string } = {}): string {
    this._registerItem(key, "STRING", defaultValue, options.description);
    const values = this._currentValues();
    if (!(key in values)) return defaultValue;
    const value = values[key];
    if (typeof value === "string") return value;
    console.warn(
      `[smplkit] config ${JSON.stringify(this._key)} item ${JSON.stringify(key)}: ` +
        `expected STRING, got ${typeof value}; returning default`,
    );
    return defaultValue;
  }

  /** Read a JSON item, registering the declaration on first call. */
  getJson<V = unknown>(key: string, defaultValue: V, options: { description?: string } = {}): V {
    this._registerItem(key, "JSON", defaultValue, options.description);
    const values = this._currentValues();
    if (!(key in values)) return defaultValue;
    return values[key] as V;
  }

  /**
   * Register a change listener scoped to this config.
   *
   * Three forms:
   * - `proxy.onChange(callback)` — fires on any change to this config.
   * - `proxy.onChange("itemKey", callback)` — fires only when `itemKey` changes.
   *
   * Equivalent to `client.config.onChange(this._key, ...)`; offered as
   * sugar so callers who already have a live proxy can register listeners
   * without re-stating the config id.
   */
  onChange(callback: (event: ConfigChangeEvent) => void): void;
  onChange(itemKey: string, callback: (event: ConfigChangeEvent) => void): void;
  onChange(
    callbackOrItemKey: string | ((event: ConfigChangeEvent) => void),
    callback?: (event: ConfigChangeEvent) => void,
  ): void {
    if (typeof callbackOrItemKey === "function") {
      this._client.onChange(this._key, callbackOrItemKey);
    } else if (callback !== undefined) {
      this._client.onChange(this._key, callbackOrItemKey, callback);
    } else {
      throw new TypeError("proxy.onChange(itemKey) requires a callback as the second argument");
    }
  }
}
