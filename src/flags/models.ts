/**
 * Flag, FlagValue, FlagRule, FlagEnvironment — flag model + frozen wrappers.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { FlagsClient } from "./client.js";
import type { Context } from "./types.js";

/** @internal Flag client surface needed by the model (covers both runtime + management). */
export interface FlagModelClient {
  _createFlag(flag: Flag): Promise<Flag>;
  _updateFlag(flag: Flag): Promise<Flag>;
  _deleteFlag(id: string): Promise<void>;
  _evaluateHandle(id: string, defaultValue: unknown, context: Context[] | null): unknown;
}

/**
 * A constrained value entry on a {@link Flag}.
 *
 * Lives in {@link Flag.values}. Frozen — author values via
 * {@link Flag.addValue} / {@link Flag.removeValue} / {@link Flag.clearValues}.
 */
export class FlagValue {
  readonly name: string;
  readonly value: unknown;

  constructor(fields: { name: string; value: unknown }) {
    this.name = fields.name;
    this.value = fields.value;
    Object.freeze(this);
  }
}

/**
 * A single targeting rule on a {@link Flag}.
 *
 * Lives in {@link FlagEnvironment.rules}. Frozen — author rules via the
 * {@link Rule} fluent builder and pass through {@link Flag.addRule}.
 */
export class FlagRule {
  /** JSON Logic predicate. Empty object means "always match". */
  readonly logic: Readonly<Record<string, unknown>>;
  /** Value to serve when `logic` evaluates truthy. */
  readonly value: unknown;
  /** Human-readable label (optional). */
  readonly description: string | null;

  constructor(fields: {
    logic: Record<string, unknown>;
    value: unknown;
    description?: string | null;
  }) {
    this.logic = Object.freeze({ ...fields.logic });
    this.value = fields.value;
    this.description = fields.description ?? null;
    Object.freeze(this);
  }
}

/**
 * Per-environment configuration on a {@link Flag}.
 *
 * Lives at `flag.environments[envName]`. Frozen — mutate via
 * {@link Flag.addRule} / {@link Flag.enableRules} / {@link Flag.disableRules} /
 * {@link Flag.setDefault} / {@link Flag.clearRules} (with `environment` option).
 */
export class FlagEnvironment {
  /** Whether the flag is active in this environment. */
  readonly enabled: boolean;
  /** Environment-specific default override (`null` means no override). */
  readonly default: unknown;
  /** Targeting rules to evaluate, in order. Frozen tuple. */
  readonly rules: ReadonlyArray<FlagRule>;

  constructor(fields?: { enabled?: boolean; default?: unknown; rules?: ReadonlyArray<FlagRule> }) {
    this.enabled = fields?.enabled ?? true;
    this.default = fields?.default ?? null;
    this.rules = Object.freeze(fields?.rules ? [...fields.rules] : []);
    Object.freeze(this);
  }

  /** Return a new `FlagEnvironment` with the given fields replaced. @internal */
  _replace(fields: {
    enabled?: boolean;
    default?: unknown;
    rules?: ReadonlyArray<FlagRule>;
  }): FlagEnvironment {
    return new FlagEnvironment({
      enabled: fields.enabled ?? this.enabled,
      default: "default" in fields ? fields.default : this.default,
      rules: fields.rules ?? this.rules,
    });
  }
}

/**
 * A flag resource.
 *
 * Provides management operations (save, addRule, environment settings)
 * and runtime evaluation via {@link Flag.get}.
 *
 * Use typed variants ({@link BooleanFlag}, {@link StringFlag},
 * {@link NumberFlag}, {@link JsonFlag}) for type-safe `get()` returns.
 */
export class Flag {
  id: string | null;
  name: string;
  type: string;
  default: unknown;
  description: string | null;
  createdAt: string | null;
  updatedAt: string | null;

  /** @internal */
  protected _values: FlagValue[] | null;
  /** @internal */
  protected _environments: Record<string, FlagEnvironment>;

  /** @internal */
  readonly _client: FlagModelClient | null;

  /** @internal */
  constructor(
    client: FlagModelClient | null,
    fields: {
      id: string | null;
      name: string;
      type: string;
      default: unknown;
      values: FlagValue[] | null;
      description: string | null;
      environments: Record<string, FlagEnvironment>;
      createdAt: string | null;
      updatedAt: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.type = fields.type;
    this.default = fields.default;
    this._values = fields.values === null ? null : [...fields.values];
    this.description = fields.description;
    this._environments = { ...fields.environments };
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /**
   * Read-only view of constrained values.
   *
   * `null` means unconstrained. Mutate via {@link addValue} /
   * {@link removeValue} / {@link clearValues}.
   */
  get values(): FlagValue[] | null {
    return this._values === null ? null : [...this._values];
  }

  /**
   * Read-only view of per-environment configuration.
   *
   * Mutate via {@link addRule} / {@link enableRules} / {@link disableRules} /
   * {@link setDefault} (with `environment` option) / {@link clearRules}.
   */
  get environments(): Record<string, FlagEnvironment> {
    return { ...this._environments };
  }

  // -------------------------------------------------------------------
  // Management: save / delete
  // -------------------------------------------------------------------

  /**
   * Persist this flag to the server.
   *
   * Creates a new flag if unsaved, or updates the existing one.
   */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Flag was constructed without a client; cannot save");
    }
    if (this.createdAt === null) {
      const created = await this._client._createFlag(this);
      this._apply(created);
    } else {
      const updated = await this._client._updateFlag(this);
      this._apply(updated);
    }
  }

  /** Delete this flag from the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("Flag was constructed without a client or id; cannot delete");
    }
    await this._client._deleteFlag(this.id);
  }

  // -------------------------------------------------------------------
  // Management: local mutations
  // -------------------------------------------------------------------

  /**
   * Append a rule to a specific environment.
   *
   * The *builtRule* dict must include an `environment` key. Call
   * {@link save} to persist. Returns `this` for chaining.
   */
  addRule(builtRule: Record<string, any>): this {
    const envKey = builtRule.environment as string | undefined;
    if (!envKey) {
      throw new Error(
        "Built rule must include 'environment' key. " +
          "Use new Rule(..., { environment: '...' }).when(...).serve(...)",
      );
    }
    const flagRule = new FlagRule({
      logic: { ...(builtRule.logic ?? {}) },
      value: builtRule.value,
      description: builtRule.description ?? null,
    });
    const existing = this._environments[envKey] ?? new FlagEnvironment();
    this._environments[envKey] = existing._replace({ rules: [...existing.rules, flagRule] });
    return this;
  }

  /**
   * Enable rule evaluation. Call {@link save} to persist.
   *
   * With `environment` set scopes to that single environment; without,
   * enables rules in every environment configured on this flag.
   */
  enableRules(options: { environment?: string } = {}): void {
    const env = options.environment;
    if (env === undefined) {
      for (const key of Object.keys(this._environments)) {
        this._environments[key] = this._environments[key]._replace({ enabled: true });
      }
    } else {
      const existing = this._environments[env] ?? new FlagEnvironment();
      this._environments[env] = existing._replace({ enabled: true });
    }
  }

  /**
   * Disable rule evaluation (kill switch). Call {@link save} to persist.
   *
   * With `environment` set scopes to that single environment; without,
   * disables rules in every environment configured on this flag. When
   * disabled, {@link Flag.get} skips rules and returns the env-specific
   * default (or the flag's base default).
   */
  disableRules(options: { environment?: string } = {}): void {
    const env = options.environment;
    if (env === undefined) {
      for (const key of Object.keys(this._environments)) {
        this._environments[key] = this._environments[key]._replace({ enabled: false });
      }
    } else {
      const existing = this._environments[env] ?? new FlagEnvironment();
      this._environments[env] = existing._replace({ enabled: false });
    }
  }

  /**
   * Set the flag's default served value.
   *
   * With `environment` undefined (the default), updates the flag-level
   * default used when no environment-specific override applies. With
   * `environment` set, sets the per-environment default served when no
   * rule matches.
   *
   * Call {@link save} to persist.
   */
  setDefault(value: unknown, options: { environment?: string } = {}): void {
    const env = options.environment;
    if (env === undefined) {
      this.default = value;
    } else {
      const existing = this._environments[env] ?? new FlagEnvironment();
      this._environments[env] = existing._replace({ default: value });
    }
  }

  /**
   * Clear the per-environment default override on `environment`.
   *
   * After clearing, the environment falls back to the flag's base default
   * when no rule matches. Call {@link save} to persist.
   */
  clearDefault(options: { environment: string }): void {
    const env = options.environment;
    if (env in this._environments) {
      this._environments[env] = this._environments[env]._replace({ default: null });
    }
  }

  /**
   * Remove rules. Call {@link save} to persist.
   *
   * With `environment` set scopes to that single environment; without,
   * removes rules from every environment configured on this flag.
   */
  clearRules(options: { environment?: string } = {}): void {
    const env = options.environment;
    if (env === undefined) {
      for (const key of Object.keys(this._environments)) {
        this._environments[key] = this._environments[key]._replace({ rules: [] });
      }
    } else {
      const existing = this._environments[env] ?? new FlagEnvironment();
      this._environments[env] = existing._replace({ rules: [] });
    }
  }

  /** Append a constrained value. Returns `this` for chaining. */
  addValue(name: string, value: unknown): this {
    if (this._values === null) {
      this._values = [];
    }
    this._values.push(new FlagValue({ name, value }));
    return this;
  }

  /** Remove the first values entry whose `value` field matches. Returns `this`. */
  removeValue(value: unknown): this {
    if (this._values === null) return this;
    this._values = this._values.filter((v) => v.value !== value);
    return this;
  }

  /** Set values to `null` (unconstrained). Call {@link save} to persist. */
  clearValues(): void {
    this._values = null;
  }

  // -------------------------------------------------------------------
  // Runtime: evaluation
  // -------------------------------------------------------------------

  /** Evaluate this flag and return its current value. */
  get(options?: { context?: Context[] }): unknown {
    if (this._client === null) {
      throw new Error("Flag was constructed without a client; cannot evaluate");
    }
    if (this.id === null) {
      throw new Error("Flag has no id; save() it first or use a managed handle");
    }
    return this._client._evaluateHandle(this.id, this.default, options?.context ?? null);
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  /** @internal */
  _apply(other: Flag): void {
    this.id = other.id;
    this.name = other.name;
    this.type = other.type;
    this.default = other.default;
    this._values = other._values === null ? null : [...other._values];
    this.description = other.description;
    this._environments = { ...other._environments };
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  /** @internal — raw access for serialization. */
  _envsRaw(): Record<string, FlagEnvironment> {
    return this._environments;
  }

  toString(): string {
    return `Flag(id=${this.id}, type=${this.type}, default=${JSON.stringify(this.default)})`;
  }
}

/** Typed flag that returns `boolean` from {@link Flag.get}. */
export class BooleanFlag extends Flag {
  override get(options?: { context?: Context[] }): boolean {
    const value = super.get(options);
    return typeof value === "boolean" ? value : (this.default as boolean);
  }
}

/** Typed flag that returns `string` from {@link Flag.get}. */
export class StringFlag extends Flag {
  override get(options?: { context?: Context[] }): string {
    const value = super.get(options);
    return typeof value === "string" ? value : (this.default as string);
  }
}

/** Typed flag that returns `number` from {@link Flag.get}. */
export class NumberFlag extends Flag {
  override get(options?: { context?: Context[] }): number {
    const value = super.get(options);
    return typeof value === "number" && !Number.isNaN(value) ? value : (this.default as number);
  }
}

/** Typed flag that returns `Record<string, unknown>` from {@link Flag.get}. */
export class JsonFlag extends Flag {
  override get(options?: { context?: Context[] }): Record<string, unknown> {
    const value = super.get(options);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return this.default as Record<string, unknown>;
  }
}

// Backwards-friendly: FlagsClient type imported to break circular imports
// while letting consumers import FlagModelClient from this file.
export type { FlagsClient };
