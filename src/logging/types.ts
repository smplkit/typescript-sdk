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
  /** The logger key that changed. */
  key: string;
  /** The new effective log level, or null if removed. */
  level: LogLevel | null;
  /** How the change was delivered. */
  source: string;
}
