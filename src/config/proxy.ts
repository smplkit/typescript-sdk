/**
 * LiveConfigProxy — live, dict-like, read-only configuration access.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConfigChangeEvent, ConfigClient } from "./client.js";

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

    const ownMethods = new Set(["keys", "values", "items", "get", "onChange", "_currentValues"]);

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
          const instance = new target._model(values) as any;
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
