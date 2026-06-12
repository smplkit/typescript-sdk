/**
 * Public types for the Logging SDK.
 */

/**
 * Severity level of a logger.
 *
 * Ordered from most-verbose (`TRACE`) to least-verbose (`SILENT`).
 */
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
 * Fired once per managed logger whose effective level the SDK just applied.
 *
 * Fields:
 * - `id`: the affected logger's normalized id.
 * - `level`: the newly-applied effective smplkit level string (e.g.
 *   `"INFO"`, `"DEBUG"`) — the same value the resolution algorithm returns
 *   and that the SDK passes to each registered adapter's `applyLevel()`.
 * - `source`: short string identifying the trigger — typically `"websocket"`
 *   or `"manual"` (a {@link LoggingClient.refresh} call).
 */
export class LoggerChangeEvent {
  readonly id: string;
  readonly source: string;
  readonly level: LogLevel;

  constructor(fields: { id: string; source: string; level: LogLevel }) {
    this.id = fields.id;
    this.source = fields.source;
    this.level = fields.level;
    Object.freeze(this);
  }
}

/**
 * Describes a logger to register via `client.logging.loggers.register`.
 *
 * Used both for buffered runtime discovery (called by {@link SmplClient} as
 * adapters discover loggers) and for explicit registration from setup scripts
 * that already know the `(service, environment)` they belong to.
 *
 * @param name - Logger name (e.g. `"sqlalchemy.engine"`). Normalized to
 *   lowercase with slashes and colons replaced by dots before sending to the
 *   API.
 * @param resolvedLevel - Effective log level for this source.
 * @param level - Explicit (configured) log level, if different from
 *   `resolvedLevel`. Pass `null` when the level is inherited.
 * @param service - Service name this source belongs to (optional).
 * @param environment - Environment name this source belongs to (optional).
 */
export class LoggerSource {
  readonly name: string;
  readonly service: string | null;
  readonly environment: string | null;
  readonly resolvedLevel: LogLevel;
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
 * Lives at `logger.environments[envName]` (a
 * `Record<string, LoggerEnvironment>`). Frozen — mutate the override via
 * `logger.setLevel(level, { environment: "..." })` or remove it via
 * `logger.clearLevel({ environment: "..." })`.
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
