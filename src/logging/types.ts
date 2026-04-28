/**
 * Public types for the Logging SDK.
 */

/** Log level values matching the smplkit platform. */
export enum LogLevel {
  TRACE = "TRACE",
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  FATAL = "FATAL",
  SILENT = "SILENT",
}

/** Describes a logger configuration change. */
export interface LoggerChangeEvent {
  /** The logger id that changed. */
  id: string;
  /** The new effective log level, or null if removed. */
  level: LogLevel | null;
  /** How the change was delivered. */
  source: string;
  /** True when the logger or group was deleted. */
  deleted?: true;
}

/**
 * Describes a logger to register via `client.logging.management.registerSources()`.
 *
 * Unlike auto-discovery (which reads the current process's logging framework),
 * `registerSources` accepts explicit `service` and `environment` overrides —
 * useful for sample-data seeding, cross-tenant migration, and test fixtures.
 */
export class LoggerSource {
  /** Logger name (e.g. `"sqlalchemy.engine"`). */
  readonly name: string;
  /** Service name this source belongs to. */
  readonly service: string;
  /** Environment name this source belongs to. */
  readonly environment: string;
  /** Effective log level for this source. */
  readonly resolvedLevel: LogLevel;
  /** Explicit (configured) log level, if different from `resolvedLevel`. */
  readonly level: LogLevel | null;

  constructor(
    name: string,
    options: {
      service: string;
      environment: string;
      resolved_level: LogLevel;
      level?: LogLevel | null;
    },
  ) {
    this.name = name;
    this.service = options.service;
    this.environment = options.environment;
    this.resolvedLevel = options.resolved_level;
    this.level = options.level ?? null;
  }
}
