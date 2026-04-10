/**
 * Contract for pluggable logging framework integration.
 *
 * Adapters bridge the smplkit logging runtime to a specific logging
 * framework (e.g., Winston, Pino).
 */
export interface LoggingAdapter {
  /** Human-readable adapter name for diagnostics (e.g., 'winston'). */
  readonly name: string;

  /**
   * Scan the runtime for existing loggers.
   * Returns an array of { name, level } where level is a smplkit level string.
   */
  discover(): Array<{ name: string; level: string }>;

  /**
   * Set the level on a specific logger.
   * @param loggerName - The original (non-normalized) logger name.
   * @param level - smplkit level string (e.g., 'DEBUG', 'INFO', 'WARN').
   */
  applyLevel(loggerName: string, level: string): void;

  /**
   * Install continuous discovery hook.
   * The callback receives (original_name, smplkit_level_string) whenever
   * a new logger is created in the framework.
   */
  installHook(onNewLogger: (name: string, level: string) => void): void;

  /** Remove the hook installed by installHook(). Called on client close(). */
  uninstallHook(): void;
}
