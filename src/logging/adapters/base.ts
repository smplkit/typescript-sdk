/**
 * Contract for logging framework adapters.
 */
export interface LoggingAdapter {
  /** Human-readable adapter name for diagnostics (e.g., 'winston'). */
  readonly name: string;

  /**
   * Return all existing loggers known to the framework.
   * Each entry contains a name and a level string.
   */
  discover(): Array<{ name: string; level: string }>;

  /**
   * Set the level on a specific logger.
   * @param loggerName - The logger name.
   * @param level - smplkit level string (e.g., 'DEBUG', 'INFO', 'WARN').
   */
  applyLevel(loggerName: string, level: string): void;

  /**
   * Install a hook that fires whenever a new logger is created in the framework.
   * The callback receives the logger name and level string.
   */
  installHook(onNewLogger: (name: string, level: string) => void): void;

  /** Remove the hook installed by `installHook()`. */
  uninstallHook(): void;
}
