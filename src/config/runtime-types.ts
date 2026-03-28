/**
 * Types for the config runtime plane.
 */

/** Describes a single value change pushed by the server or detected on refresh. */
export interface ConfigChangeEvent {
  /** The config key that changed. */
  key: string;
  /** The previous value (null if the key was absent). */
  oldValue: unknown;
  /** The updated value (null if the key was removed). */
  newValue: unknown;
  /** How the change was delivered. */
  source: "websocket" | "poll" | "manual";
}

/** Diagnostic statistics for a {@link ConfigRuntime} instance. */
export interface ConfigStats {
  /**
   * Total number of HTTP fetches performed, including the initial connect
   * and any reconnection re-syncs or manual refreshes. Incremented by the
   * chain length (number of configs fetched) on each fetch.
   */
  fetchCount: number;
  /** ISO-8601 timestamp of the most recent fetch, or null if none yet. */
  lastFetchAt: string | null;
}

/** WebSocket connection status. */
export type ConnectionStatus = "connected" | "connecting" | "disconnected";

/** Options for {@link Config.connect}. */
export interface ConnectOptions {
  /**
   * Maximum milliseconds to wait for the initial fetch.
   * @default 30000
   */
  timeout?: number;
}
