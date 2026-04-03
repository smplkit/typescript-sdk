/**
 * Flag and ContextType resource models returned by the management API.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { FlagsClient } from "./client.js";

/**
 * A flag resource returned by {@link FlagsClient} management methods.
 *
 * Provides `update()` for partial updates and `addRule()` for
 * conveniently appending a rule to an environment.
 */
export class Flag {
  /** UUID of the flag. */
  id: string;
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
  private readonly _client: FlagsClient;

  /** @internal */
  constructor(
    client: FlagsClient,
    fields: {
      id: string;
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
   * Update this flag's attributes on the server.
   *
   * Only provided fields are changed; others retain their current values.
   */
  async update(options: {
    environments?: Record<string, any>;
    values?: Array<{ name: string; value: unknown }>;
    default?: unknown;
    description?: string;
    name?: string;
  }): Promise<void> {
    const updated = await this._client._updateFlag({
      flag: this,
      environments: options.environments,
      values: options.values,
      default: options.default,
      description: options.description,
      name: options.name,
    });
    this._apply(updated);
  }

  /**
   * Add a rule to a specific environment.
   *
   * The built rule must include an `environment` key (set via
   * `Rule(...).environment("env_key")`).  Re-fetches current state
   * first to avoid stale data.
   */
  async addRule(builtRule: Record<string, any>): Promise<void> {
    const envKey = builtRule.environment as string | undefined;
    if (!envKey) {
      throw new Error(
        "Built rule must include 'environment' key. " +
          'Use new Rule(...).environment("env_key").when(...).serve(...).build()',
      );
    }

    // Re-fetch current state to avoid staleness
    const current = await this._client.get(this.id);
    this._apply(current);

    const envs = { ...this.environments };
    const envData = { ...(envs[envKey] ?? { enabled: true, rules: [] }) };
    const rules = [...(envData.rules ?? [])];

    // Strip the environment key from the rule — it's metadata, not part of the rule
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { environment: _env, ...ruleCopy } = builtRule;
    rules.push(ruleCopy);
    envData.rules = rules;
    envs[envKey] = envData;

    const updated = await this._client._updateFlag({
      flag: this,
      environments: envs,
    });
    this._apply(updated);
  }

  /** @internal */
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

/** A context type resource returned by management API methods. */
export class ContextType {
  /** UUID. */
  id: string;
  /** Unique key within the account. */
  key: string;
  /** Human-readable display name. */
  name: string;
  /** Known attributes. */
  attributes: Record<string, any>;

  constructor(fields: { id: string; key: string; name: string; attributes: Record<string, any> }) {
    this.id = fields.id;
    this.key = fields.key;
    this.name = fields.name;
    this.attributes = fields.attributes;
  }

  toString(): string {
    return `ContextType(key=${this.key}, name=${this.name})`;
  }
}
