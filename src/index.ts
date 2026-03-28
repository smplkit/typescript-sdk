/**
 * smplkit — Official TypeScript SDK for the smplkit platform.
 *
 * @packageDocumentation
 */

// Main client
export { SmplClient } from "./client.js";
export type { SmplClientOptions } from "./client.js";

// Config — management plane
export { ConfigClient } from "./config/client.js";
export type { CreateConfigOptions, GetConfigOptions } from "./config/types.js";
export { Config } from "./config/types.js";

// Config — runtime plane
export { ConfigRuntime } from "./config/runtime.js";
export type {
  ConfigChangeEvent,
  ConfigStats,
  ConnectionStatus,
  ConnectOptions,
} from "./config/runtime-types.js";

// Error hierarchy
export {
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
} from "./errors.js";
