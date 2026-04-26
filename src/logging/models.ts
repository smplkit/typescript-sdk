/**
 * Logger and LogGroup active-record models for the Logging SDK.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LoggingClient } from "./client.js";
import { LogLevel } from "./types.js";

/**
 * A logger resource managed by the smplkit platform.
 *
 * Mutate properties or use convenience methods, then call `save()` to persist.
 */
export class Logger {
  /** Unique identifier (dot-separated hierarchy, e.g. `"sqlalchemy.engine"`). */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Base log level, or null if inherited. */
  level: string | null;
  /** Id of the parent log group, or null. */
  group: string | null;
  /** Whether this logger is managed by the platform. */
  managed: boolean;
  /** Observed sources (services that report this logger). */
  sources: Array<Record<string, any>>;
  /** Per-environment level overrides. */
  environments: Record<string, any>;
  /** When the logger was created. */
  createdAt: string | null;
  /** When the logger was last updated. */
  updatedAt: string | null;

  /** @internal */
  readonly _client: LoggingClient;

  /** @internal */
  constructor(
    client: LoggingClient,
    fields: {
      id: string | null;
      name: string;
      level: string | null;
      group: string | null;
      managed: boolean;
      sources: Array<Record<string, any>>;
      environments: Record<string, any>;
      createdAt: string | null;
      updatedAt: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.level = fields.level;
    this.group = fields.group;
    this.managed = fields.managed;
    this.sources = fields.sources;
    this.environments = fields.environments;
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /**
   * Persist this logger to the server.
   *
   * Creates if new, updates if existing.
   */
  async save(): Promise<void> {
    const saved = await this._client._saveLogger(this);
    this._apply(saved);
  }

  /** Set the base log level. Call `save()` to persist. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Clear the base log level. Call `save()` to persist. */
  clearLevel(): void {
    this.level = null;
  }

  /** Set an environment-specific log level. Call `save()` to persist. */
  setEnvironmentLevel(env: string, level: LogLevel): void {
    const envs = { ...this.environments };
    envs[env] = { ...(envs[env] ?? {}), level: level };
    this.environments = envs;
  }

  /** Clear an environment-specific log level. Call `save()` to persist. */
  clearEnvironmentLevel(env: string): void {
    const envs = { ...this.environments };
    if (envs[env]) {
      const entry = { ...envs[env] };
      delete entry.level;
      envs[env] = entry;
      this.environments = envs;
    }
  }

  /** Clear all environment-specific log levels. Call `save()` to persist. */
  clearAllEnvironmentLevels(): void {
    this.environments = {};
  }

  /** @internal — copy all fields from another Logger instance. */
  _apply(other: Logger): void {
    this.id = other.id;
    this.name = other.name;
    this.level = other.level;
    this.group = other.group;
    this.managed = other.managed;
    this.sources = other.sources;
    this.environments = other.environments;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `Logger(id=${this.id}, level=${this.level})`;
  }
}

/**
 * A log group resource for organizing loggers.
 *
 * Management: mutate properties and call `save()` to persist.
 */
export class LogGroup {
  /** Unique identifier (slug), or `null` if unsaved. */
  id: string | null;
  /** Human-readable key (slug), or `null` if not set. */
  key: string | null;
  /** Human-readable display name. */
  name: string;
  /** Base log level, or null if inherited. */
  level: string | null;
  /** Id of the parent log group, or null. */
  group: string | null;
  /** Per-environment level overrides. */
  environments: Record<string, any>;
  /** When the log group was created. */
  createdAt: string | null;
  /** When the log group was last updated. */
  updatedAt: string | null;

  /** @internal */
  readonly _client: LoggingClient;

  /** @internal */
  constructor(
    client: LoggingClient,
    fields: {
      id: string | null;
      key: string | null;
      name: string;
      level: string | null;
      group: string | null;
      environments: Record<string, any>;
      createdAt: string | null;
      updatedAt: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.key = fields.key;
    this.name = fields.name;
    this.level = fields.level;
    this.group = fields.group;
    this.environments = fields.environments;
    this.createdAt = fields.createdAt;
    this.updatedAt = fields.updatedAt;
  }

  /**
   * Persist this log group to the server.
   *
   * Creates if new, updates if existing.
   */
  async save(): Promise<void> {
    const saved = await this._client._saveLogGroup(this);
    this._apply(saved);
  }

  /** Set the base log level. Call `save()` to persist. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Clear the base log level. Call `save()` to persist. */
  clearLevel(): void {
    this.level = null;
  }

  /** Set an environment-specific log level. Call `save()` to persist. */
  setEnvironmentLevel(env: string, level: LogLevel): void {
    const envs = { ...this.environments };
    envs[env] = { ...(envs[env] ?? {}), level: level };
    this.environments = envs;
  }

  /** Clear an environment-specific log level. Call `save()` to persist. */
  clearEnvironmentLevel(env: string): void {
    const envs = { ...this.environments };
    if (envs[env]) {
      const entry = { ...envs[env] };
      delete entry.level;
      envs[env] = entry;
      this.environments = envs;
    }
  }

  /** Clear all environment-specific log levels. Call `save()` to persist. */
  clearAllEnvironmentLevels(): void {
    this.environments = {};
  }

  /** @internal — copy all fields from another LogGroup instance. */
  _apply(other: LogGroup): void {
    this.id = other.id;
    this.key = other.key;
    this.name = other.name;
    this.level = other.level;
    this.group = other.group;
    this.environments = other.environments;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `LogGroup(id=${this.id}, level=${this.level})`;
  }
}
