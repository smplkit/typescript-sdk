/**
 * smplkit — Official TypeScript SDK for the smplkit platform.
 *
 * @packageDocumentation
 */

// Main client
export { SmplClient } from "./client.js";
export type { SmplClientOptions } from "./client.js";

// Config — management and prescriptive plane
export { ConfigClient } from "./config/client.js";
export type { ConfigChangeEvent } from "./config/client.js";
export type { CreateConfigOptions, GetConfigOptions } from "./config/types.js";
export { Config } from "./config/types.js";

// Flags — public types
export { Context, Rule } from "./flags/types.js";
export type { FlagType } from "./flags/types.js";

// Flags — management plane
export { FlagsClient } from "./flags/client.js";
export { Flag, ContextType } from "./flags/models.js";

// Flags — runtime plane
export {
  BoolFlagHandle,
  StringFlagHandle,
  NumberFlagHandle,
  JsonFlagHandle,
  FlagChangeEvent,
  FlagStats,
} from "./flags/client.js";

// Shared WebSocket
export { SharedWebSocket } from "./ws.js";

// Error hierarchy
export {
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplNotConnectedError,
  SmplConflictError,
  SmplValidationError,
} from "./errors.js";
