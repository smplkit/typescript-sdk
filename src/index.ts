/**
 * smplkit — Official TypeScript SDK for the smplkit platform.
 *
 * @packageDocumentation
 */

// Main client
export { SmplkitClient } from "./client.js";
export type { SmplkitClientOptions } from "./client.js";

// Config types
export { ConfigClient } from "./config/client.js";
export type {
  Config,
  CreateConfigOptions,
  GetConfigOptions,
  UpdateConfigOptions,
} from "./config/types.js";

// Error hierarchy
export {
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
} from "./errors.js";
