/**
 * Unified Flag hierarchy — management model + runtime handle.
 *
 * A single {@link Flag} class replaces the old separate Flag + FlagHandle
 * classes. Typed subclasses ({@link BooleanFlag}, {@link StringFlag},
 * {@link NumberFlag}, {@link JsonFlag}) override `get()` for type safety.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { FlagsClient } from "./client.js";
import type { Context } from "./types.js";

/**
 * A flag resource that doubles as a runtime handle.
 *
 * Management: call `save()` to persist (POST if new, PUT if existing).
 * Runtime: call `get()` for local JSON Logic evaluation.
 */
export class Flag {
  /** UUID of the flag, or `null` if unsaved. */
  id: string | null;
  /** Unique key within the account. */
  key: string;
  /** Human-readable display name. */
  name: string;
  /** Value type: BOOLEAN, STRING, NUMERIC, or JSON. */
  type: string;
  /** Flag-level default value. */
  default: unknown;
  /** Closed set of possible values. */
  values: Array<{ name: string; value: unknown }>;
  /** Optional description. */
  description: string | null;
  /** Per-environment configuration. */
  environments: Record<string, any>;
  /** When the flag was created. */
  createdAt: string | null;
  /** When the flag was last updated. */
  updatedAt: string | null;

  /** @internal */
  readonly _client: FlagsClient;

  /** @internal */
  constructor(
    client: FlagsClient,
    fields: {
      id: string | null;
      key: string;
      name: string;
      type: string;
      default: unknown;
      values: Array<{ name: string; value: unknown }>;
      description: string | null;
      environments: Record<string, any>;
      createdAt: string | null;
      updatedAt: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.key = fields.key;
    this.name = fields.name;
    this.type = fields.type;
    this.default = fields.default;
    this.values = fields.values;
    this.description = fields.description;
    this.environments = fields.environments;
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /**
   * Persist this flag to the server.
   *
   * POST if `id` is null (new flag), PUT if `id` is set (update).
   * Updates this instance in-place with the server response.
   */
  async save(): Promise<void> {
    if (this.id === null) {
      const created = await this._client._createFlag(this);
      this._apply(created);
    } else {
      const updated = await this._client._updateFlag(this);
      this._apply(updated);
    }
  }

  /**
   * Add a rule to a specific environment (sync local mutation).
   *
   * The built rule must include an `environment` key (set via
   * `Rule(...).environment("env_key")`). No HTTP call is made.
   *
   * @returns `this` for chaining.
   */
  addRule(builtRule: Record<string, any>): Flag {
    const envKey = builtRule.environment as string | undefined;
    if (!envKey) {
      throw new Error(
        "Built rule must include 'environment' key. " +
          'Use new Rule(...).environment("env_key").when(...).serve(...).build()',
      );
    }

    const envs = { ...this.environments };
    const envData = { ...(envs[envKey] ?? { enabled: true, rules: [] }) };
    const rules = [...(envData.rules ?? [])];

    // Strip the environment key from the rule — it's metadata
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { environment: _env, ...ruleCopy } = builtRule;
    rules.push(ruleCopy);
    envData.rules = rules;
    envs[envKey] = envData;

    this.environments = envs;
    return this;
  }

  /** Enable or disable a flag in a specific environment (sync local mutation). */
  setEnvironmentEnabled(envKey: string, enabled: boolean): void {
    const envs = { ...this.environments };
    const envData = { ...(envs[envKey] ?? { enabled: false, rules: [] }) };
    envData.enabled = enabled;
    envs[envKey] = envData;
    this.environments = envs;
  }

  /** Set the default value for a specific environment (sync local mutation). */
  setEnvironmentDefault(envKey: string, defaultValue: unknown): void {
    const envs = { ...this.environments };
    const envData = { ...(envs[envKey] ?? { enabled: false, rules: [] }) };
    envData.default = defaultValue;
    envs[envKey] = envData;
    this.environments = envs;
  }

  /** Clear all rules for a specific environment (sync local mutation). */
  clearRules(envKey: string): void {
    const envs = { ...this.environments };
    const envData = envs[envKey];
    if (envData) {
      envs[envKey] = { ...envData, rules: [] };
      this.environments = envs;
    }
  }

  /**
   * Evaluate the flag locally (sync, no HTTP).
   *
   * Requires `initialize()` to have been called.
   */
  get(options?: { context?: Context[] }): unknown {
    return this._client._evaluateHandle(this.key, this.default, options?.context ?? null);
  }

  /** @internal — copy all fields from another Flag instance. */
  _apply(other: Flag): void {
    this.id = other.id;
    this.key = other.key;
    this.name = other.name;
    this.type = other.type;
    this.default = other.default;
    this.values = other.values;
    this.description = other.description;
    this.environments = other.environments;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `Flag(key=${this.key}, type=${this.type}, default=${this.default})`;
  }
}

/** Typed flag that returns `boolean` from `get()`. */
export class BooleanFlag extends Flag {
  get(options?: { context?: Context[] }): boolean {
    const value = this._client._evaluateHandle(this.key, this.default, options?.context ?? null);
    if (typeof value === "boolean") {
      return value;
    }
    return this.default as boolean;
  }
}

/** Typed flag that returns `string` from `get()`. */
export class StringFlag extends Flag {
  get(options?: { context?: Context[] }): string {
    const value = this._client._evaluateHandle(this.key, this.default, options?.context ?? null);
    if (typeof value === "string") {
      return value;
    }
    return this.default as string;
  }
}

/** Typed flag that returns `number` from `get()`. */
export class NumberFlag extends Flag {
  get(options?: { context?: Context[] }): number {
    const value = this._client._evaluateHandle(this.key, this.default, options?.context ?? null);
    if (typeof value === "number") {
      return value;
    }
    return this.default as number;
  }
}

/** Typed flag that returns `Record<string, any>` from `get()`. */
export class JsonFlag extends Flag {
  get(options?: { context?: Context[] }): Record<string, any> {
    const value = this._client._evaluateHandle(this.key, this.default, options?.context ?? null);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, any>;
    }
    return this.default as Record<string, any>;
  }
}
