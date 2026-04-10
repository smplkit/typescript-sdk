/**
 * Pino logging framework adapter.
 *
 * Integrates the smplkit logging runtime with Pino. Tracks logger
 * instances (including child loggers) for discovery and level control.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LoggingAdapter } from "./base.js";

// ---------------------------------------------------------------------------
// Level conversion
// ---------------------------------------------------------------------------

const SMPLKIT_TO_PINO: Record<string, string> = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "fatal",
  SILENT: "silent",
};

const PINO_TO_SMPLKIT: Record<string, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  fatal: "FATAL",
  silent: "SILENT",
};

function toSmplkitLevel(pinoLevel: string): string {
  return PINO_TO_SMPLKIT[pinoLevel] ?? "INFO";
}

function toPinoLevel(smplkitLevel: string): string {
  return SMPLKIT_TO_PINO[smplkitLevel] ?? "info";
}

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface PinoAdapterConfig {
  /** Which binding field to use as the logger name (default: 'name'). */
  nameField?: string;
  /** @internal — inject a pino module for testing. */
  _pino?: unknown;
}

// ---------------------------------------------------------------------------
// PinoAdapter
// ---------------------------------------------------------------------------

export class PinoAdapter implements LoggingAdapter {
  readonly name = "pino";

  private readonly _nameField: string;
  private _pino: any;
  private _registry: Map<string, WeakRef<any>> = new Map();
  private _originalPino: ((...args: any[]) => any) | null = null;
  private _pinoModule: any;

  constructor(config?: PinoAdapterConfig) {
    this._nameField = config?.nameField ?? "name";

    if (config?._pino) {
      this._pino = config._pino;
    } else {
      // Import pino — throws if not installed (caught by auto-loader).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this._pino = require("pino");
    }
    this._pinoModule = this._pino;
  }

  discover(): Array<{ name: string; level: string }> {
    // Pino has no global registry — return tracked loggers from our registry.
    const result: Array<{ name: string; level: string }> = [];
    for (const [name, ref] of this._registry) {
      const logger = ref.deref();
      if (logger) {
        result.push({
          name,
          level: toSmplkitLevel(logger.level ?? "info"),
        });
      } else {
        // Logger was GC'd — clean up
        this._registry.delete(name);
      }
    }
    return result;
  }

  applyLevel(loggerName: string, level: string): void {
    const ref = this._registry.get(loggerName);
    if (!ref) return;

    const logger = ref.deref();
    if (!logger) {
      this._registry.delete(loggerName);
      return;
    }

    logger.level = toPinoLevel(level);
  }

  installHook(onNewLogger: (name: string, level: string) => void): void {
    const nameField = this._nameField;
    const registry = this._registry;
    const pinoMod = this._pinoModule;

    // Monkey-patch the pino default export to intercept logger creation
    this._originalPino = pinoMod.default ?? pinoMod;

    const patchChild = (logger: any): void => {
      if (!logger || typeof logger.child !== "function") return;

      const origChild = logger.child.bind(logger);
      logger.child = (bindings: any, ...rest: any[]): any => {
        const child = origChild(bindings, ...rest);
        const childName = bindings?.[nameField];
        if (childName && typeof childName === "string") {
          registry.set(childName, new WeakRef(child));
          try {
            onNewLogger(childName, toSmplkitLevel(child.level ?? "info"));
          } catch {
            // ignore callback errors
          }
        }
        // Recursively patch child so grandchildren are also tracked
        patchChild(child);
        return child;
      };
    };

    // Wrap the module-level pino function
    const originalPinoFn = typeof pinoMod === "function" ? pinoMod : pinoMod.default;
    if (typeof originalPinoFn === "function") {
      const wrappedPino = (...args: any[]): any => {
        const logger = originalPinoFn(...args);
        // Extract name from options (first arg if object)
        const opts = args[0];
        const loggerName = typeof opts === "object" && opts !== null ? opts[nameField] : undefined;
        if (loggerName && typeof loggerName === "string") {
          registry.set(loggerName, new WeakRef(logger));
          try {
            onNewLogger(loggerName, toSmplkitLevel(logger.level ?? "info"));
          } catch {
            // ignore callback errors
          }
        }
        patchChild(logger);
        return logger;
      };

      // Copy all properties from original to wrapper
      for (const key of Object.keys(originalPinoFn)) {
        (wrappedPino as any)[key] = (originalPinoFn as any)[key];
      }

      if (pinoMod.default) {
        pinoMod.default = wrappedPino;
      }
      // For CommonJS require('pino') scenarios, we store the wrapper
      // but can't replace the module export. The hook works for child loggers
      // created from already-patched parents.
    }
  }

  uninstallHook(): void {
    if (this._originalPino) {
      const pinoMod = this._pinoModule;
      if (pinoMod.default && this._originalPino !== pinoMod) {
        pinoMod.default = this._originalPino;
      }
      this._originalPino = null;
    }
  }
}
