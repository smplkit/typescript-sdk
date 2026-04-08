/**
 * Config resource — active-record model with save() pattern.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ConfigClient } from "./client.js";

/**
 * A configuration resource managed by the smplkit platform.
 *
 * Management: mutate properties directly and call `save()` to persist.
 * POST if `id` is null (new), PUT if `id` is set (update).
 */
export class Config {
  /** UUID of the config, or `null` if unsaved. */
  id: string | null;

  /** Human-readable key (e.g. `"user-service"`). */
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
  createdAt: string | null;

  /** When the config was last updated, or null if unavailable. */
  updatedAt: string | null;

  /** @internal */
  readonly _client: ConfigClient;

  /** @internal */
  constructor(
    client: ConfigClient,
    fields: {
      id: string | null;
      key: string;
      name: string;
      description: string | null;
      parent: string | null;
      items: Record<string, unknown>;
      environments: Record<string, unknown>;
      createdAt: string | null;
      updatedAt: string | null;
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
   * Persist this config to the server.
   *
   * POST if `id` is null (new config), PUT if `id` is set (update).
   * Updates this instance in-place with the server response.
   */
  async save(): Promise<void> {
    if (this.id === null) {
      const created = await this._client._createConfig(this);
      this._apply(created);
    } else {
      const updated = await this._client._updateConfig(this);
      this._apply(updated);
    }
  }

  /**
   * Walk the parent chain and return config data objects, child-to-root.
   * @internal
   */
  async _buildChain(): Promise<
    Array<{ id: string; items: Record<string, unknown>; environments: Record<string, unknown> }>
  > {
    const chain: Array<{
      id: string;
      items: Record<string, unknown>;
      environments: Record<string, unknown>;
    }> = [{ id: this.id ?? "", items: this.items, environments: this.environments }];

    let parentId = this.parent;
    while (parentId !== null) {
      const parentConfig = await this._client._getById(parentId);
      chain.push({
        id: parentConfig.id ?? "",
        items: parentConfig.items,
        environments: parentConfig.environments,
      });
      parentId = parentConfig.parent;
    }

    return chain;
  }

  /** @internal — copy all fields from another Config instance. */
  _apply(other: Config): void {
    this.id = other.id;
    this.key = other.key;
    this.name = other.name;
    this.description = other.description;
    this.parent = other.parent;
    this.items = other.items;
    this.environments = other.environments;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `Config(id=${this.id}, key=${this.key}, name=${this.name})`;
  }
}
