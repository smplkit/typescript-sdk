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

/**
 * Describes a logger configuration change. Frozen — fields cannot be
 * mutated after construction so a listener cannot affect later listeners.
 *
 * The `level` field is a TypeScript-SDK-only convenience for callers that
 * want to act on the new effective level without re-fetching the logger.
 */
export class LoggerChangeEvent {
  readonly id: string;
  readonly source: string;
  readonly level?: LogLevel | null;
  readonly deleted?: true;

  constructor(fields: { id: string; source: string; level?: LogLevel | null; deleted?: true }) {
    this.id = fields.id;
    this.source = fields.source;
    if (fields.level !== undefined) this.level = fields.level;
    if (fields.deleted) this.deleted = fields.deleted;
    Object.freeze(this);
  }
}

/**
 * Describes a logger to register via `mgmt.loggers.register([source, ...])`.
 *
 * Unlike runtime auto-discovery (which reads the current process's logging
 * framework), `mgmt.loggers.register` accepts explicit `service` and
 * `environment` overrides — useful for sample-data seeding, cross-tenant
 * migration, and test fixtures.
 *
 * Frozen.
 */
export class LoggerSource {
  /** Logger name (e.g. `"sqlalchemy.engine"`). */
  readonly name: string;
  /** Service name this source belongs to. */
  readonly service: string | null;
  /** Environment name this source belongs to. */
  readonly environment: string | null;
  /** Effective log level for this source. */
  readonly resolvedLevel: LogLevel;
  /** Explicit (configured) log level, if different from `resolvedLevel`. */
  readonly level: LogLevel | null;

  constructor(
    name: string,
    options: {
      service?: string | null;
      environment?: string | null;
      resolvedLevel: LogLevel;
      level?: LogLevel | null;
    },
  ) {
    this.name = name;
    this.service = options.service ?? null;
    this.environment = options.environment ?? null;
    this.resolvedLevel = options.resolvedLevel;
    this.level = options.level ?? null;
    Object.freeze(this);
  }
}

/**
 * Per-environment configuration on a logger or log group.
 *
 * Frozen — mutate via `logger.setLevel(level, { environment: "..." })`
 * or remove with `logger.clearLevel({ environment: "..." })`.
 */
export class LoggerEnvironment {
  /** Per-environment level override (`null` means no override). */
  readonly level: LogLevel | null;

  constructor(fields: { level?: LogLevel | null } = {}) {
    this.level = fields.level ?? null;
    Object.freeze(this);
  }
}

/** @internal Convert a wire dict to a `LoggerEnvironment` map. */
export function convertLoggerEnvironments(
  value?: Record<string, unknown> | null,
): Record<string, LoggerEnvironment> {
  if (!value) return {};
  const out: Record<string, LoggerEnvironment> = {};
  for (const [envId, envData] of Object.entries(value)) {
    if (envData instanceof LoggerEnvironment) {
      out[envId] = envData;
    } else if (envData && typeof envData === "object") {
      const data = envData as Record<string, unknown>;
      const levelStr = data.level;
      if (typeof levelStr === "string" && Object.values(LogLevel).includes(levelStr as LogLevel)) {
        out[envId] = new LoggerEnvironment({ level: levelStr as LogLevel });
      } else {
        out[envId] = new LoggerEnvironment();
      }
    } else {
      out[envId] = new LoggerEnvironment();
    }
  }
  return out;
}

/** @internal Convert typed environments back to the wire dict. */
export function loggerEnvironmentsToWire(
  environments: Record<string, LoggerEnvironment>,
): Record<string, { level: LogLevel }> {
  const out: Record<string, { level: LogLevel }> = {};
  for (const [envId, env] of Object.entries(environments)) {
    if (env.level !== null) {
      out[envId] = { level: env.level };
    }
  }
  return out;
}
