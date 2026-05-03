/**
 * Logger and LogGroup active-record models for the Logging SDK.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { LogLevel, LoggerEnvironment, convertLoggerEnvironments } from "./types.js";

/** @internal */
export interface LoggerModelClient {
  _saveLogger?: (logger: Logger) => Promise<Logger>;
  _deleteLogger?: (id: string) => Promise<void>;
}

/** @internal */
export interface LogGroupModelClient {
  _saveGroup?: (group: LogGroup) => Promise<LogGroup>;
  _deleteGroup?: (id: string) => Promise<void>;
}

/**
 * A logger resource managed by the smplkit platform.
 *
 * Mutate via {@link setLevel} / {@link clearLevel} /
 * {@link clearAllEnvironmentLevels} (with `environment` option for per-env
 * overrides), then call {@link save} to persist.
 */
export class Logger {
  /** Unique identifier (dot-separated hierarchy, e.g. `"sqlalchemy.engine"`). */
  id: string | null;
  /** Human-readable display name. */
  name: string;
  /** Base log level, or null if inherited. */
  level: LogLevel | null;
  /** Id of the parent log group, or null. */
  group: string | null;
  /** Whether this logger is managed by the platform. */
  managed: boolean | null;
  /** Observed sources (services that report this logger). */
  sources: Array<Record<string, any>>;
  /** When the logger was created. */
  createdAt: string | null;
  /** When the logger was last updated. */
  updatedAt: string | null;

  /** @internal */
  protected _environments: Record<string, LoggerEnvironment>;

  /** @internal */
  readonly _client: LoggerModelClient | null;

  /** @internal */
  constructor(
    client: LoggerModelClient | null,
    fields: {
      id: string | null;
      name: string;
      level?: LogLevel | null;
      group?: string | null;
      managed?: boolean | null;
      sources?: Array<Record<string, any>>;
      environments?: Record<string, unknown> | null;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.level = fields.level ?? null;
    this.group = fields.group ?? null;
    this.managed = fields.managed ?? null;
    this.sources = fields.sources ?? [];
    this._environments = convertLoggerEnvironments(fields.environments);
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
  }

  /**
   * Read-only view of per-environment level overrides.
   *
   * Mutate via {@link setLevel} / {@link clearLevel} /
   * {@link clearAllEnvironmentLevels} (with `environment` option).
   */
  get environments(): Record<string, LoggerEnvironment> {
    return { ...this._environments };
  }

  /** @internal — direct typed environments dict for serialization. */
  get _environmentsDirect(): Record<string, LoggerEnvironment> {
    return this._environments;
  }

  /** Persist this logger to the server (create or update). */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Logger was constructed without a client; cannot save");
    }
    if (!this._client._saveLogger) {
      throw new Error(
        "Logger models obtained from the runtime LoggingClient cannot be saved. " +
          "Use mgmt.loggers.new(...) (or client.manage.loggers.*) to author loggers.",
      );
    }
    const saved = await this._client._saveLogger(this);
    this._apply(saved);
  }

  /** Delete this logger from the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("Logger was constructed without a client or id; cannot delete");
    }
    if (!this._client._deleteLogger) {
      throw new Error(
        "Logger models obtained from the runtime LoggingClient cannot be deleted. " +
          "Use client.manage.loggers.delete(id) instead.",
      );
    }
    await this._client._deleteLogger(this.id);
  }

  /**
   * Set the log level.
   *
   * With `environment` undefined (the default), sets the base log level
   * used when no environment-specific override applies. With `environment`,
   * sets the per-environment override.
   */
  setLevel(level: LogLevel, options: { environment?: string } = {}): void {
    if (options.environment === undefined) {
      this.level = level;
    } else {
      this._environments[options.environment] = new LoggerEnvironment({ level });
    }
  }

  /**
   * Remove a log level.
   *
   * With `environment` undefined (the default), removes the base log level
   * (the logger then inherits from its group / dot-notation ancestor /
   * system default). With `environment`, removes only that env's override.
   */
  clearLevel(options: { environment?: string } = {}): void {
    if (options.environment === undefined) {
      this.level = null;
    } else {
      delete this._environments[options.environment];
    }
  }

  /** Remove all per-environment level overrides. */
  clearAllEnvironmentLevels(): void {
    this._environments = {};
  }

  /** @internal */
  _apply(other: Logger): void {
    this.id = other.id;
    this.name = other.name;
    this.level = other.level;
    this.group = other.group;
    this.managed = other.managed;
    this.sources = other.sources;
    this._environments = { ...other._environments };
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
 * Mutate via {@link setLevel} / {@link clearLevel} /
 * {@link clearAllEnvironmentLevels} (with `environment` option), then
 * call {@link save} to persist.
 */
export class LogGroup {
  id: string | null;
  name: string;
  level: LogLevel | null;
  group: string | null;
  createdAt: string | null;
  updatedAt: string | null;

  /** @internal */
  protected _environments: Record<string, LoggerEnvironment>;

  /** @internal */
  readonly _client: LogGroupModelClient | null;

  /** @internal */
  constructor(
    client: LogGroupModelClient | null,
    fields: {
      id: string | null;
      name: string;
      level?: LogLevel | null;
      group?: string | null;
      environments?: Record<string, unknown> | null;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
  ) {
    this._client = client;
    this.id = fields.id;
    this.name = fields.name;
    this.level = fields.level ?? null;
    this.group = fields.group ?? null;
    this._environments = convertLoggerEnvironments(fields.environments);
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
  }

  /** Read-only view of per-environment level overrides. */
  get environments(): Record<string, LoggerEnvironment> {
    return { ...this._environments };
  }

  /** @internal */
  get _environmentsDirect(): Record<string, LoggerEnvironment> {
    return this._environments;
  }

  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("LogGroup was constructed without a client; cannot save");
    }
    if (!this._client._saveGroup) {
      throw new Error(
        "LogGroup models obtained from the runtime LoggingClient cannot be saved. " +
          "Use mgmt.logGroups.new(...) (or client.manage.logGroups.*) to author groups.",
      );
    }
    const saved = await this._client._saveGroup(this);
    this._apply(saved);
  }

  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("LogGroup was constructed without a client or id; cannot delete");
    }
    if (!this._client._deleteGroup) {
      throw new Error(
        "LogGroup models obtained from the runtime LoggingClient cannot be deleted. " +
          "Use client.manage.logGroups.delete(id) instead.",
      );
    }
    await this._client._deleteGroup(this.id);
  }

  setLevel(level: LogLevel, options: { environment?: string } = {}): void {
    if (options.environment === undefined) {
      this.level = level;
    } else {
      this._environments[options.environment] = new LoggerEnvironment({ level });
    }
  }

  clearLevel(options: { environment?: string } = {}): void {
    if (options.environment === undefined) {
      this.level = null;
    } else {
      delete this._environments[options.environment];
    }
  }

  clearAllEnvironmentLevels(): void {
    this._environments = {};
  }

  /** @internal */
  _apply(other: LogGroup): void {
    this.id = other.id;
    this.name = other.name;
    this.level = other.level;
    this.group = other.group;
    this._environments = { ...other._environments };
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `LogGroup(id=${this.id}, level=${this.level})`;
  }
}
