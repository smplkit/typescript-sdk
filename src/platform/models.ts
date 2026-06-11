/**
 * Active-record models for `client.platform.*` resources.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Color, EnvironmentClassification, coerceColor } from "./types.js";

/** @internal */
export interface EnvironmentModelClient {
  _create(env: Environment): Promise<Environment>;
  _update(env: Environment): Promise<Environment>;
  delete(id: string): Promise<void>;
}

/** @internal */
export interface ContextTypeModelClient {
  _create(ct: ContextType): Promise<ContextType>;
  _update(ct: ContextType): Promise<ContextType>;
  delete(id: string): Promise<void>;
}

/** @internal */
export interface ServiceModelClient {
  _create(svc: Service): Promise<Service>;
  _update(svc: Service): Promise<Service>;
  delete(id: string): Promise<void>;
}

/**
 * Environment resource. Mutate fields, then `await save()`.
 */
export class Environment {
  /** Unique slug identifier (e.g. `"production"`). */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Whether this is a STANDARD or AD_HOC environment. */
  classification: EnvironmentClassification;
  /** When the environment was created. */
  createdAt: string | null;
  /** When the environment was last updated. */
  updatedAt: string | null;

  /** @internal */
  private _color: Color | null;

  /** @internal */
  readonly _client: EnvironmentModelClient | null;

  /** @internal */
  constructor(
    client: EnvironmentModelClient | null,
    fields: {
      id: string | null;
      name: string;
      color?: Color | string | null;
      classification: EnvironmentClassification;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this._color = coerceColor(fields.color ?? null);
    this.classification = fields.classification;
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
  }

  /** The environment color, or `null`. Accepts `Color | string | null` on assignment. */
  get color(): Color | null {
    return this._color;
  }

  set color(value: Color | string | null) {
    this._color = coerceColor(value);
  }

  /** Create or update this environment on the server. */
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

  /** Delete this environment from the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("Environment was constructed without a client or id; cannot delete");
    }
    await this._client.delete(this.id);
  }

  /** @internal */
  _apply(other: Environment): void {
    this.id = other.id;
    this.name = other.name;
    this._color = other._color;
    this.classification = other.classification;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `Environment(id=${this.id}, name=${this.name}, classification=${this.classification})`;
  }
}

/**
 * Service resource — a backend application or microservice in the customer's
 * stack. Mutate fields, then `await save()`.
 */
export class Service {
  /** Unique slug identifier (e.g. `"user_service"`). */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** When the service was created. */
  createdAt: string | null;
  /** When the service was last updated. */
  updatedAt: string | null;

  /** @internal */
  readonly _client: ServiceModelClient | null;

  /** @internal */
  constructor(
    client: ServiceModelClient | null,
    fields: {
      id: string | null;
      name: string;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
  }

  /** Create or update this service on the server. */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Service was constructed without a client; cannot save");
    }
    if (this.createdAt === null) {
      const saved = await this._client._create(this);
      this._apply(saved);
    } else {
      const saved = await this._client._update(this);
      this._apply(saved);
    }
  }

  /** Delete this service from the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("Service was constructed without a client or id; cannot delete");
    }
    await this._client.delete(this.id);
  }

  /** @internal */
  _apply(other: Service): void {
    this.id = other.id;
    this.name = other.name;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `Service(id=${this.id}, name=${this.name})`;
  }
}

/**
 * A context-type resource managed by the smplkit platform.
 *
 * Mutate fields or use {@link addAttribute} / {@link removeAttribute} /
 * {@link updateAttribute}, then `await save()` to persist.
 */
export class ContextType {
  /** Unique slug identifier (e.g. `"user"`). */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Known attribute keys with metadata objects. */
  attributes: Record<string, Record<string, any>>;
  createdAt: string | null;
  updatedAt: string | null;

  /** @internal */
  readonly _client: ContextTypeModelClient | null;

  /** @internal */
  constructor(
    client: ContextTypeModelClient | null,
    fields: {
      id: string | null;
      name: string;
      attributes?: Record<string, Record<string, any>>;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.attributes = { ...(fields.attributes ?? {}) };
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
  }

  /** Add a known-attribute slot. Local; call {@link save} to persist. */
  addAttribute(name: string, metadata: Record<string, any> = {}): void {
    this.attributes = { ...this.attributes, [name]: metadata };
  }

  /** Remove a known-attribute slot. Local; call {@link save} to persist. */
  removeAttribute(name: string): void {
    const attrs = { ...this.attributes };
    delete attrs[name];
    this.attributes = attrs;
  }

  /** Replace a known-attribute slot's metadata. Local; call {@link save} to persist. */
  updateAttribute(name: string, metadata: Record<string, any>): void {
    this.attributes = { ...this.attributes, [name]: metadata };
  }

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

  /** Delete this context type from the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("ContextType was constructed without a client or id; cannot delete");
    }
    await this._client.delete(this.id);
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
