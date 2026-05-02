/**
 * Config model + ConfigItem + ConfigEnvironment.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Type of a {@link ConfigItem} value. */
export enum ItemType {
  STRING = "STRING",
  NUMBER = "NUMBER",
  BOOLEAN = "BOOLEAN",
  JSON = "JSON",
}

/** @internal Config client surface used by the active-record `Config.save`/`delete`. */
export interface ConfigModelClient {
  _createConfig(config: Config): Promise<Config>;
  _updateConfig(config: Config): Promise<Config>;
  _deleteConfig(id: string): Promise<void>;
  _fetchConfig(id: string): Promise<Config>;
}

/** A single typed item in a {@link Config}. */
export class ConfigItem {
  readonly name: string;
  readonly value: unknown;
  readonly type: ItemType;
  readonly description: string | null;

  constructor(
    name: string,
    value: unknown,
    type: ItemType | string,
    options: { description?: string } = {},
  ) {
    this.name = name;
    this.value = value;
    this.type = typeof type === "string" ? (type as ItemType) : type;
    this.description = options.description ?? null;
    Object.freeze(this);
  }

  toString(): string {
    return `ConfigItem(name=${this.name}, type=${this.type}, value=${JSON.stringify(this.value)})`;
  }
}

/**
 * Per-environment value overrides for a {@link Config}.
 *
 * Read-only inspection container. Mutation is performed via {@link Config}'s
 * setters with `environment` option (e.g. `cfg.setString("k", "v",
 * { environment: "production" })`).
 */
export class ConfigEnvironment {
  /** @internal */
  readonly _valuesRaw: Record<string, Record<string, unknown>>;

  constructor(values?: Record<string, unknown>) {
    const raw: Record<string, Record<string, unknown>> = {};
    if (values) {
      for (const [k, v] of Object.entries(values)) {
        if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object)) {
          raw[k] = { ...(v as Record<string, unknown>) };
        } else {
          raw[k] = { value: v };
        }
      }
    }
    this._valuesRaw = raw;
    Object.freeze(this);
  }

  /** Return overrides as a plain dict `{key: rawValue}`. */
  get values(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this._valuesRaw)) {
      out[k] = v.value;
    }
    return out;
  }

  /** Return the full typed overrides `{key: {value, type, description}}` (deep copy). */
  get valuesRaw(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(this._valuesRaw)) {
      out[k] = { ...v };
    }
    return out;
  }

  toString(): string {
    return `ConfigEnvironment(values=${JSON.stringify(this.values)})`;
  }
}

/** @internal */
function convertEnvironments(
  value?: Record<string, unknown> | null,
): Record<string, ConfigEnvironment> {
  if (!value) return {};
  const out: Record<string, ConfigEnvironment> = {};
  for (const [envId, envData] of Object.entries(value)) {
    if (envData instanceof ConfigEnvironment) {
      out[envId] = envData;
    } else if (envData && typeof envData === "object" && !Array.isArray(envData)) {
      const data = envData as Record<string, unknown>;
      const rawValues =
        "values" in data
          ? (data.values as Record<string, unknown> | null)
          : (data as Record<string, unknown>);
      out[envId] = new ConfigEnvironment(rawValues ?? {});
    } else {
      out[envId] = new ConfigEnvironment();
    }
  }
  return out;
}

/** @internal Convert a typed environments dict to the wire-shaped dict the resolver expects. */
export function environmentsToWire(
  environments: Record<string, ConfigEnvironment>,
): Record<string, { values: Record<string, Record<string, unknown>> }> {
  const out: Record<string, { values: Record<string, Record<string, unknown>> }> = {};
  for (const [envId, env] of Object.entries(environments)) {
    out[envId] = { values: env._valuesRaw };
  }
  return out;
}

/**
 * A configuration resource fetched from the Smpl Config service.
 *
 * Mutate base values via `set` / `setString` / `setNumber` /
 * `setBoolean` / `setJson` / `remove` (pass `{ environment: "..." }` to
 * scope mutations to a specific environment). Call {@link save} to persist.
 */
export class Config {
  id: string | null;
  name: string;
  description: string | null;
  parent: string | null;
  createdAt: string | null;
  updatedAt: string | null;

  /** @internal */
  protected _itemsRaw: Record<string, Record<string, unknown>>;
  /** @internal */
  protected _environments: Record<string, ConfigEnvironment>;

  /** @internal */
  readonly _client: ConfigModelClient | null;

  /** @internal */
  constructor(
    client: ConfigModelClient | null,
    fields: {
      id: string | null;
      name: string;
      description?: string | null;
      parent?: string | null;
      items?: Record<string, unknown> | null;
      environments?: Record<string, unknown> | null;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.description = fields.description ?? null;
    this.parent = fields.parent ?? null;
    this._itemsRaw = {};
    if (fields.items) {
      for (const [k, v] of Object.entries(fields.items)) {
        if (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as object)) {
          this._itemsRaw[k] = { ...(v as Record<string, unknown>) };
        } else {
          this._itemsRaw[k] = { value: v };
        }
      }
    }
    this._environments = convertEnvironments(fields.environments);
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
  }

  /**
   * Read-only `{key: rawValue}` view of base items.
   *
   * Mutate via {@link set} / {@link setString} / {@link setNumber} /
   * {@link setBoolean} / {@link setJson} / {@link remove}.
   */
  get items(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this._itemsRaw)) {
      out[k] = v.value;
    }
    return out;
  }

  /** Return the full typed items `{key: {value, type, description}}` (deep copy). */
  get itemsRaw(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries(this._itemsRaw)) {
      out[k] = { ...v };
    }
    return out;
  }

  /**
   * Read-only view of per-environment overrides keyed by environment id.
   *
   * Mutate via the `environment` option on {@link set} / {@link setString} /
   * {@link setNumber} / {@link setBoolean} / {@link setJson} / {@link remove}.
   */
  get environments(): Record<string, ConfigEnvironment> {
    return { ...this._environments };
  }

  /** @internal — return the wire-shaped raw items for serialization. */
  get _itemsRawDirect(): Record<string, Record<string, unknown>> {
    return this._itemsRaw;
  }

  /** @internal — return the typed environments dict for serialization. */
  get _environmentsDirect(): Record<string, ConfigEnvironment> {
    return this._environments;
  }

  /** @internal — return the dict that `set()` / `remove()` should mutate. */
  private _itemsTarget(environment?: string): Record<string, Record<string, unknown>> {
    if (environment === undefined) return this._itemsRaw;
    let env = this._environments[environment];
    if (env === undefined) {
      env = new ConfigEnvironment();
      this._environments[environment] = env;
    }
    return env._valuesRaw;
  }

  // -------------------------------------------------------------------
  // Local mutations
  // -------------------------------------------------------------------

  /**
   * Set (or replace) an item. With `environment`, sets an override on
   * that environment.
   */
  set(item: ConfigItem, options: { environment?: string } = {}): void {
    const raw: Record<string, unknown> = { value: item.value, type: item.type };
    if (item.description !== null) raw.description = item.description;
    this._itemsTarget(options.environment)[item.name] = raw;
  }

  /** Remove an item by name. With `environment`, removes only that env's override. */
  remove(name: string, options: { environment?: string } = {}): void {
    const target = this._itemsTarget(options.environment);
    delete target[name];
  }

  /** Convenience: set a STRING item (or environment override). */
  setString(
    name: string,
    value: string,
    options: { description?: string; environment?: string } = {},
  ): void {
    this.set(new ConfigItem(name, value, ItemType.STRING, { description: options.description }), {
      environment: options.environment,
    });
  }

  /** Convenience: set a NUMBER item (or environment override). */
  setNumber(
    name: string,
    value: number,
    options: { description?: string; environment?: string } = {},
  ): void {
    this.set(new ConfigItem(name, value, ItemType.NUMBER, { description: options.description }), {
      environment: options.environment,
    });
  }

  /** Convenience: set a BOOLEAN item (or environment override). */
  setBoolean(
    name: string,
    value: boolean,
    options: { description?: string; environment?: string } = {},
  ): void {
    this.set(new ConfigItem(name, value, ItemType.BOOLEAN, { description: options.description }), {
      environment: options.environment,
    });
  }

  /** Convenience: set a JSON item (or environment override). */
  setJson(
    name: string,
    value: unknown,
    options: { description?: string; environment?: string } = {},
  ): void {
    this.set(new ConfigItem(name, value, ItemType.JSON, { description: options.description }), {
      environment: options.environment,
    });
  }

  // -------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------

  /**
   * Persist this config to the server.
   *
   * Creates a new config if unsaved, or updates the existing one.
   *
   * @throws SmplkitNotFoundError if the config no longer exists (update).
   * @throws SmplkitValidationError if the server rejects the request.
   * @throws Error if the model was constructed without a management client.
   */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Config was constructed without a client; cannot save");
    }
    if (this.createdAt === null) {
      const created = await this._client._createConfig(this);
      this._apply(created);
    } else {
      const updated = await this._client._updateConfig(this);
      this._apply(updated);
    }
  }

  /** Delete this config from the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("Config was constructed without a client or id; cannot delete");
    }
    await this._client._deleteConfig(this.id);
  }

  /** @internal */
  _apply(other: Config): void {
    this.id = other.id;
    this.name = other.name;
    this.description = other.description;
    this.parent = other.parent;
    this._itemsRaw = { ...other._itemsRaw };
    this._environments = { ...other._environments };
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  /**
   * Walk the parent chain and return config data dicts child-to-root.
   *
   * @internal
   */
  async _buildChain(configs?: Config[]): Promise<
    Array<{
      id: string | null;
      items: Record<string, Record<string, unknown>>;
      environments: Record<string, { values: Record<string, Record<string, unknown>> }>;
    }>
  > {
    const chain = [
      {
        id: this.id,
        items: this._itemsRaw,
        environments: environmentsToWire(this._environments),
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let current: Config = this;
    const byId = new Map<string, Config>();
    if (configs) {
      for (const c of configs) {
        if (c.id) byId.set(c.id, c);
      }
    }
    while (current.parent !== null) {
      let parentConfig = byId.get(current.parent);
      if (parentConfig === undefined) {
        if (this._client === null) {
          throw new Error(
            `cannot resolve parent config ${JSON.stringify(current.parent)} without a client`,
          );
        }
        parentConfig = await this._client._fetchConfig(current.parent);
      }
      chain.push({
        id: parentConfig.id,
        items: parentConfig._itemsRaw,
        environments: environmentsToWire(parentConfig._environments),
      });
      current = parentConfig;
    }
    return chain;
  }

  toString(): string {
    return `Config(id=${this.id}, name=${this.name})`;
  }
}
