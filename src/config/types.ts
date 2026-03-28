/**
 * Config resource — management-plane model with runtime connect support.
 *
 * Instances are returned by {@link ConfigClient} methods and provide
 * management-plane operations (`update`, `setValues`, `setValue`) as well
 * as the {@link connect} entry point for runtime value resolution.
 */

import type { ConfigRuntime } from "./runtime.js";
import type { ConnectOptions } from "./runtime-types.js";

/**
 * Internal type used by {@link ConfigClient}.  Not part of the public API.
 * @internal
 */
export interface ConfigUpdatePayload {
  configId: string;
  name: string;
  key: string | null;
  description: string | null;
  parent: string | null;
  values: Record<string, unknown>;
  environments: Record<string, unknown>;
}

/**
 * A configuration resource fetched from the smplkit Config service.
 *
 * Instances are returned by {@link ConfigClient} methods and provide
 * management-plane operations as well as the {@link connect} entry point
 * for runtime value resolution.
 */
export class Config {
  /** UUID of the config. */
  id: string;

  /** Human-readable key (e.g. `"user_service"`). */
  key: string;

  /** Display name. */
  name: string;

  /** Optional description. */
  description: string | null;

  /** Parent config UUID, or null if this is a root config. */
  parent: string | null;

  /** Base key-value pairs. */
  values: Record<string, unknown>;

  /**
   * Per-environment overrides.
   * Stored as `{ env_name: { values: { key: value } } }` to match the
   * server's format.
   */
  environments: Record<string, unknown>;

  /** When the config was created, or null if unavailable. */
  createdAt: Date | null;

  /** When the config was last updated, or null if unavailable. */
  updatedAt: Date | null;

  /**
   * Internal reference to the parent client.
   * @internal
   */
  private readonly _client: {
    _updateConfig(payload: ConfigUpdatePayload): Promise<Config>;
    get(options: { id: string }): Promise<Config>;
    readonly _apiKey: string;
    readonly _baseUrl: string;
  };

  /** @internal */
  constructor(
    client: {
      _updateConfig(payload: ConfigUpdatePayload): Promise<Config>;
      get(options: { id: string }): Promise<Config>;
      readonly _apiKey: string;
      readonly _baseUrl: string;
    },
    fields: {
      id: string;
      key: string;
      name: string;
      description: string | null;
      parent: string | null;
      values: Record<string, unknown>;
      environments: Record<string, unknown>;
      createdAt: Date | null;
      updatedAt: Date | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.key = fields.key;
    this.name = fields.name;
    this.description = fields.description;
    this.parent = fields.parent;
    this.values = fields.values;
    this.environments = fields.environments;
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /**
   * Update this config's attributes on the server.
   *
   * Builds the request from current attribute values, overriding with any
   * provided options. Updates local attributes in place on success.
   *
   * @param options.name - New display name.
   * @param options.description - New description (pass empty string to clear).
   * @param options.values - New base values (replaces entirely).
   * @param options.environments - New environments dict (replaces entirely).
   */
  async update(options: {
    name?: string;
    description?: string;
    values?: Record<string, unknown>;
    environments?: Record<string, unknown>;
  }): Promise<void> {
    const updated = await this._client._updateConfig({
      configId: this.id,
      name: options.name ?? this.name,
      key: this.key,
      description: options.description !== undefined ? options.description : this.description,
      parent: this.parent,
      values: options.values ?? this.values,
      environments: options.environments ?? this.environments,
    });
    this.name = updated.name;
    this.description = updated.description;
    this.values = updated.values;
    this.environments = updated.environments;
    this.updatedAt = updated.updatedAt;
  }

  /**
   * Replace base or environment-specific values.
   *
   * When `environment` is provided, replaces that environment's `values`
   * sub-dict (other environments are preserved). When omitted, replaces
   * the base `values`.
   *
   * @param values - The complete set of values to set.
   * @param environment - Target environment, or omit for base values.
   */
  async setValues(values: Record<string, unknown>, environment?: string): Promise<void> {
    let newValues: Record<string, unknown>;
    let newEnvs: Record<string, unknown>;

    if (environment === undefined) {
      newValues = values;
      newEnvs = this.environments;
    } else {
      newValues = this.values;
      // Preserve any extra metadata on the environment entry (like other sub-keys),
      // but replace the `values` sub-dict entirely.
      const existingEntry =
        typeof this.environments[environment] === "object" &&
        this.environments[environment] !== null
          ? { ...(this.environments[environment] as Record<string, unknown>) }
          : {};
      existingEntry.values = values;
      newEnvs = { ...this.environments, [environment]: existingEntry };
    }

    const updated = await this._client._updateConfig({
      configId: this.id,
      name: this.name,
      key: this.key,
      description: this.description,
      parent: this.parent,
      values: newValues,
      environments: newEnvs,
    });
    this.values = updated.values;
    this.environments = updated.environments;
    this.updatedAt = updated.updatedAt;
  }

  /**
   * Set a single key within base or environment-specific values.
   *
   * Merges the key into existing values rather than replacing all values.
   *
   * @param key - The config key to set.
   * @param value - The value to assign.
   * @param environment - Target environment, or omit for base values.
   */
  async setValue(key: string, value: unknown, environment?: string): Promise<void> {
    if (environment === undefined) {
      const merged = { ...this.values, [key]: value };
      await this.setValues(merged);
    } else {
      const envEntry =
        typeof this.environments[environment] === "object" &&
        this.environments[environment] !== null
          ? (this.environments[environment] as Record<string, unknown>)
          : {};
      const existing = {
        ...(typeof envEntry.values === "object" && envEntry.values !== null
          ? (envEntry.values as Record<string, unknown>)
          : {}),
      };
      existing[key] = value;
      await this.setValues(existing, environment);
    }
  }

  /**
   * Connect to this config for runtime value resolution.
   *
   * Eagerly fetches this config and its full parent chain, resolves values
   * for the given environment via deep merge, and returns a
   * {@link ConfigRuntime} with a fully populated local cache.
   *
   * A background WebSocket connection is started for real-time updates.
   * If the WebSocket fails to connect, the runtime operates in cache-only
   * mode and reconnects automatically.
   *
   * Supports both `await` and `await using` (TypeScript 5.2+)::
   *
   * ```typescript
   * // Simple await
   * const runtime = await config.connect("production");
   * try { ... } finally { await runtime.close(); }
   *
   * // await using (auto-close)
   * await using runtime = await config.connect("production");
   * ```
   *
   * @param environment - The environment to resolve for (e.g. `"production"`).
   * @param options.timeout - Milliseconds to wait for the initial fetch.
   */
  async connect(environment: string, options?: ConnectOptions): Promise<ConfigRuntime> {
    // Lazy import to avoid loading ws at module-init time
    const { ConfigRuntime } = await import("./runtime.js");

    const timeout = options?.timeout ?? 30_000;
    const chain = await this._buildChain(timeout);

    return new ConfigRuntime({
      configKey: this.key,
      configId: this.id,
      environment,
      chain,
      apiKey: this._client._apiKey,
      baseUrl: this._client._baseUrl,
      fetchChain: () => this._buildChain(timeout),
    });
  }

  /**
   * Walk the parent chain and return config data objects, child-to-root.
   * @internal
   */
  private async _buildChain(
    _timeout: number,
  ): Promise<Array<{ id: string; values: Record<string, unknown>; environments: Record<string, unknown> }>> {
    const chain: Array<{
      id: string;
      values: Record<string, unknown>;
      environments: Record<string, unknown>;
    }> = [{ id: this.id, values: this.values, environments: this.environments }];

    let current: Config = this;
    while (current.parent !== null) {
      const parentConfig = await this._client.get({ id: current.parent });
      chain.push({
        id: parentConfig.id,
        values: parentConfig.values,
        environments: parentConfig.environments,
      });
      current = parentConfig;
    }

    return chain;
  }

  toString(): string {
    return `Config(id=${this.id}, key=${this.key}, name=${this.name})`;
  }
}

/** Options for creating a new config. */
export interface CreateConfigOptions {
  /** Display name for the config. */
  name: string;
  /** Human-readable key. Auto-generated by the server if omitted. */
  key?: string;
  /** Optional description. */
  description?: string;
  /** Parent config UUID. Defaults to the account's `common` config if omitted. */
  parent?: string;
  /** Initial base values. */
  values?: Record<string, unknown>;
}

/** Options for fetching a single config. Exactly one of `key` or `id` must be provided. */
export interface GetConfigOptions {
  /** Fetch by human-readable key. */
  key?: string;
  /** Fetch by UUID. */
  id?: string;
}
