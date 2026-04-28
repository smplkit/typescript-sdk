/**
 * Active-record models for client.management.* resources.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EnvironmentClassification } from "./types.js";
import type {
  EnvironmentsClient,
  ContextTypesClient,
  AccountSettingsClient,
} from "./client.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * An environment resource managed by the smplkit platform.
 *
 * Mutate fields, then call `save()` to create or update.
 */
export class Environment {
  /** Unique slug identifier (e.g. `"production"`). */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Hex color code, or null. */
  color: string | null;
  /** Whether this is a STANDARD or AD_HOC environment. */
  classification: EnvironmentClassification;
  /** When the environment was created. */
  createdAt: string | null;
  /** When the environment was last updated. */
  updatedAt: string | null;

  /** @internal */
  readonly _client: EnvironmentsClient | null;

  /** @internal */
  constructor(
    client: EnvironmentsClient | null,
    fields: {
      id: string | null;
      name: string;
      color: string | null;
      classification: EnvironmentClassification;
      createdAt: string | null;
      updatedAt: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.color = fields.color;
    this.classification = fields.classification;
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /** Persist this environment to the server (creates if new, updates if existing). */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Environment was constructed without a client; cannot save");
    }
    if (this.createdAt === null) {
      const saved = await this._client._create(this);
      this._apply(saved);
    } else {
      const saved = await this._client._update(this);
      this._apply(saved);
    }
  }

  /** @internal */
  _apply(other: Environment): void {
    this.id = other.id;
    this.name = other.name;
    this.color = other.color;
    this.classification = other.classification;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `Environment(id=${this.id}, name=${this.name}, classification=${this.classification})`;
  }
}

// ---------------------------------------------------------------------------
// ContextType
// ---------------------------------------------------------------------------

/**
 * A context-type resource managed by the smplkit platform.
 *
 * Mutate fields or use `addAttribute`/`removeAttribute`/`updateAttribute`,
 * then call `save()` to persist.
 */
export class ContextType {
  /** Unique slug identifier (e.g. `"user"`). */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Known attribute keys with metadata objects. */
  attributes: Record<string, Record<string, any>>;
  /** When the context type was created. */
  createdAt: string | null;
  /** When the context type was last updated. */
  updatedAt: string | null;

  /** @internal */
  readonly _client: ContextTypesClient | null;

  /** @internal */
  constructor(
    client: ContextTypesClient | null,
    fields: {
      id: string | null;
      name: string;
      attributes: Record<string, Record<string, any>>;
      createdAt: string | null;
      updatedAt: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.attributes = { ...fields.attributes };
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /** Add a known-attribute slot. Local; call `save()` to persist. */
  addAttribute(name: string, metadata: Record<string, any> = {}): void {
    this.attributes = { ...this.attributes, [name]: metadata };
  }

  /** Remove a known-attribute slot. Local; call `save()` to persist. */
  removeAttribute(name: string): void {
    const attrs = { ...this.attributes };
    delete attrs[name];
    this.attributes = attrs;
  }

  /** Replace a known-attribute slot's metadata. Local; call `save()` to persist. */
  updateAttribute(name: string, metadata: Record<string, any>): void {
    this.attributes = { ...this.attributes, [name]: metadata };
  }

  /** Persist this context type to the server (creates if new, updates if existing). */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("ContextType was constructed without a client; cannot save");
    }
    if (this.createdAt === null) {
      const saved = await this._client._create(this);
      this._apply(saved);
    } else {
      const saved = await this._client._update(this);
      this._apply(saved);
    }
  }

  /** @internal */
  _apply(other: ContextType): void {
    this.id = other.id;
    this.name = other.name;
    this.attributes = { ...other.attributes };
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `ContextType(id=${this.id}, name=${this.name})`;
  }
}

// ---------------------------------------------------------------------------
// ContextEntity (read/delete model — write side is via register())
// ---------------------------------------------------------------------------

/**
 * A context instance as returned by the management API.
 *
 * The write path is `client.management.contexts.register([...])`.
 * This model is what comes back from `list`/`get`.
 */
export class ContextEntity {
  /** Context type key (e.g. `"user"`). */
  type: string;
  /** Entity key (e.g. `"user-123"`). */
  key: string;
  /** Human-readable display name, or null. */
  name: string | null;
  /** Observed attributes. */
  attributes: Record<string, any>;
  /** When the context was created. */
  createdAt: string | null;
  /** When the context was last updated. */
  updatedAt: string | null;

  /** @internal */
  constructor(fields: {
    type: string;
    key: string;
    name: string | null;
    attributes: Record<string, any>;
    createdAt: string | null;
    updatedAt: string | null;
  }) {
    this.type = fields.type;
    this.key = fields.key;
    this.name = fields.name;
    this.attributes = { ...fields.attributes };
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /** Composite `"type:key"` identifier. */
  get id(): string {
    return `${this.type}:${this.key}`;
  }

  toString(): string {
    return `ContextEntity(type=${this.type}, key=${this.key})`;
  }
}

// ---------------------------------------------------------------------------
// AccountSettings
// ---------------------------------------------------------------------------

/**
 * Active-record account-settings model.
 *
 * The wire format is opaque JSON. Documented keys are exposed as typed
 * properties; unknown keys live in `raw`. Call `save()` to write back.
 */
export class AccountSettings {
  /** @internal */
  private _data: Record<string, any>;

  /** @internal */
  readonly _client: AccountSettingsClient | null;

  /** @internal */
  constructor(client: AccountSettingsClient | null, data: Record<string, any>) {
    this._client = client;
    this._data = { ...data };
  }

  /** The full settings dict. Direct mutations are reflected in `save()`. */
  get raw(): Record<string, any> {
    return this._data;
  }

  set raw(value: Record<string, any>) {
    this._data = { ...value };
  }

  /** Canonical ordering of STANDARD environments. Empty array if unset. */
  get environmentOrder(): string[] {
    const val = this._data["environment_order"];
    return Array.isArray(val) ? [...val] : [];
  }

  set environmentOrder(value: string[]) {
    this._data["environment_order"] = [...value];
  }

  /** Persist the settings to the server. */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("AccountSettings was constructed without a client; cannot save");
    }
    const saved = await this._client._save(this._data);
    this._apply(saved);
  }

  /** @internal */
  _apply(other: AccountSettings): void {
    this._data = { ...other._data };
  }

  /** @internal — expose raw data for _save(). */
  get _rawData(): Record<string, any> {
    return this._data;
  }

  toString(): string {
    return `AccountSettings(${JSON.stringify(this._data)})`;
  }
}
