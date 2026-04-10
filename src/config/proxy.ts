/**
 * LiveConfigProxy — live configuration access.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConfigClient } from "./client.js";

/**
 * A live proxy whose properties always reflect the latest config values.
 *
 * @example
 * ```typescript
 * const proxy = await client.config.subscribe("user-service");
 * console.log(proxy.timeout);  // current value
 * // ... later, after a config change ...
 * console.log(proxy.timeout);  // updated value
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

    return new Proxy(this, {
      get(target, prop, receiver) {
        // Allow access to built-in properties and the class's own methods
        if (typeof prop === "symbol" || prop === "constructor" || prop === "toJSON") {
          return Reflect.get(target, prop, receiver);
        }

        // Delegate property access to the live cache
        const values = target._currentValues();
        if (target._model) {
          const instance = new target._model(values) as any;
          return instance[prop];
        }
        return (values as any)[prop];
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
}
