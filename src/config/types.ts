/**
 * Config resource — management-plane model with runtime connect support.
 *
 * Instances are returned by {@link ConfigClient} methods and provide
 * management-plane operations (`update`, `setValues`, `setValue`) as well
 * as the {@link connect} entry point for runtime value resolution.
 */

// ConfigRuntime and ConnectOptions no longer imported here —
// connect() has been moved to SmplClient.connect().

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
  items: Record<string, unknown>;
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

  /** Base key-value pairs (unwrapped from typed item definitions). */
  items: Record<string, unknown>;

  /**
   * Per-environment overrides.
   * Stored as `{ env_name: { values: { key: value } } }` — values are
   * unwrapped from the server's `{ value: raw }` wrapper.
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
    _getSharedWs?: () => import("../ws.js").SharedWebSocket;
  };

  /** @internal */
  constructor(
    client: {
      _updateConfig(payload: ConfigUpdatePayload): Promise<Config>;
      get(options: { id: string }): Promise<Config>;
      readonly _apiKey: string;
      readonly _baseUrl: string;
      _getSharedWs?: () => import("../ws.js").SharedWebSocket;
    },
    fields: {
      id: string;
      key: string;
      name: string;
      description: string | null;
      parent: string | null;
      items: Record<string, unknown>;
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
    this.items = fields.items;
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
   * @param options.items - New base values (replaces entirely).
   * @param options.environments - New environments dict (replaces entirely).
   */
  async update(options: {
    name?: string;
    description?: string;
    items?: Record<string, unknown>;
    environments?: Record<string, unknown>;
  }): Promise<void> {
    const updated = await this._client._updateConfig({
      configId: this.id,
      name: options.name ?? this.name,
      key: this.key,
      description: options.description !== undefined ? options.description : this.description,
      parent: this.parent,
      items: options.items ?? this.items,
      environments: options.environments ?? this.environments,
    });
    this.name = updated.name;
    this.description = updated.description;
    this.items = updated.items;
    this.environments = updated.environments;
    this.updatedAt = updated.updatedAt;
  }

  /**
   * Replace base or environment-specific values.
   *
   * When `environment` is provided, replaces that environment's `values`
   * sub-dict (other environments are preserved). When omitted, replaces
   * the base `items`.
   *
   * @param values - The complete set of values to set.
   * @param environment - Target environment, or omit for base values.
   */
  async setValues(values: Record<string, unknown>, environment?: string): Promise<void> {
    let newItems: Record<string, unknown>;
    let newEnvs: Record<string, unknown>;

    if (environment === undefined) {
      newItems = values;
      newEnvs = this.environments;
    } else {
      newItems = this.items;
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
      items: newItems,
      environments: newEnvs,
    });
    this.items = updated.items;
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
      const merged = { ...this.items, [key]: value };
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
   * Walk the parent chain and return config data objects, child-to-root.
   * @internal
   */
  async _buildChain(
    _timeout?: unknown,
  ): Promise<
    Array<{ id: string; items: Record<string, unknown>; environments: Record<string, unknown> }>
  > {
    const chain: Array<{
      id: string;
      items: Record<string, unknown>;
      environments: Record<string, unknown>;
    }> = [{ id: this.id, items: this.items, environments: this.environments }];

    let parentId = this.parent;
    while (parentId !== null) {
      const parentConfig = await this._client.get({ id: parentId });
      chain.push({
        id: parentConfig.id,
        items: parentConfig.items,
        environments: parentConfig.environments,
      });
      parentId = parentConfig.parent;
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
  items?: Record<string, unknown>;
}

/** Options for fetching a single config. Exactly one of `key` or `id` must be provided. */
export interface GetConfigOptions {
  /** Fetch by human-readable key. */
  key?: string;
  /** Fetch by UUID. */
  id?: string;
}
