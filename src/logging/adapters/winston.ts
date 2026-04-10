/**
 * Winston logging framework adapter.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LoggingAdapter } from "./base.js";

// ---------------------------------------------------------------------------
// Level conversion
// ---------------------------------------------------------------------------

const SMPLKIT_TO_WINSTON: Record<string, string> = {
  TRACE: "silly",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "error",
  SILENT: "silent",
};

const WINSTON_TO_SMPLKIT: Record<string, string> = {
  silly: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  silent: "SILENT",
};

function toSmplkitLevel(winstonLevel: string): string {
  return WINSTON_TO_SMPLKIT[winstonLevel] ?? "INFO";
}

function toWinstonLevel(smplkitLevel: string): string {
  return SMPLKIT_TO_WINSTON[smplkitLevel] ?? "info";
}

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface WinstonAdapterConfig {
  /** Whether to include the default logger in discovery (default: true). */
  discoverDefault?: boolean;
  /** @internal — inject a winston module for testing. */
  _winston?: unknown;
}

// ---------------------------------------------------------------------------
// WinstonAdapter
// ---------------------------------------------------------------------------

export class WinstonAdapter implements LoggingAdapter {
  readonly name = "winston";

  private readonly _discoverDefault: boolean;
  private _winston: any;
  private _originalAdd: ((...args: any[]) => any) | null = null;

  constructor(config?: WinstonAdapterConfig) {
    this._discoverDefault = config?.discoverDefault ?? true;

    if (config?._winston) {
      this._winston = config._winston;
    } else {
      // Import winston — throws if not installed (caught by auto-loader).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this._winston = require("winston");
    }
  }

  discover(): Array<{ name: string; level: string }> {
    const result: Array<{ name: string; level: string }> = [];

    // Discover named loggers in the container
    const container = this._winston.loggers;
    if (container && container.loggers) {
      const loggers: Map<string, any> = container.loggers;
      for (const [name, logger] of loggers) {
        result.push({
          name,
          level: toSmplkitLevel(logger.level ?? "info"),
        });
      }
    }

    // Optionally discover the default logger
    if (this._discoverDefault) {
      const defaultLogger = this._winston.default ?? this._winston;
      if (defaultLogger && typeof defaultLogger.level === "string") {
        result.push({
          name: "__default__",
          level: toSmplkitLevel(defaultLogger.level),
        });
      }
    }

    return result;
  }

  applyLevel(loggerName: string, level: string): void {
    const winstonLevel = toWinstonLevel(level);

    if (loggerName === "__default__") {
      const defaultLogger = this._winston.default ?? this._winston;
      if (defaultLogger) {
        defaultLogger.level = winstonLevel;
      }
      return;
    }

    const container = this._winston.loggers;
    if (container && container.loggers) {
      const logger = container.loggers.get(loggerName);
      if (logger) {
        logger.level = winstonLevel;
      }
    }
  }

  installHook(onNewLogger: (name: string, level: string) => void): void {
    const container = this._winston.loggers;
    if (!container) return;

    this._originalAdd = container.add.bind(container);

    container.add = (id: string, ...rest: any[]): any => {
      const logger = this._originalAdd!(id, ...rest);
      try {
        onNewLogger(id, toSmplkitLevel(logger.level ?? "info"));
      } catch {
        // ignore callback errors
      }
      return logger;
    };
  }

  uninstallHook(): void {
    if (this._originalAdd) {
      const container = this._winston.loggers;
      if (container) {
        container.add = this._originalAdd;
      }
      this._originalAdd = null;
    }
  }
}
