/**
 * smplkit — Official TypeScript SDK for the smplkit platform.
 *
 * @packageDocumentation
 */

// Top-level clients
export { SmplClient } from "./client.js";
export type { SmplClientOptions } from "./client.js";
export { SmplManagementClient } from "./management/client.js";
export type { SmplManagementClientOptions } from "./management/client.js";

// Config
export { ConfigClient, ConfigManagement } from "./config/client.js";
export type { ConfigChangeEvent } from "./config/client.js";
export { Config, ConfigItem, ConfigEnvironment, ItemType } from "./config/types.js";
export { LiveConfigProxy } from "./config/proxy.js";

// Flags — public types
export { Context, Op, Rule, FlagDeclaration } from "./flags/types.js";

// Flags — management + runtime
export { FlagsClient, FlagsManagement } from "./flags/client.js";
export {
  Flag,
  BooleanFlag,
  StringFlag,
  NumberFlag,
  JsonFlag,
  FlagValue,
  FlagRule,
  FlagEnvironment,
} from "./flags/models.js";
export { FlagChangeEvent, FlagStats } from "./flags/client.js";

// Logging
export { LoggingClient, LoggingManagement } from "./logging/client.js";
export { Logger, LogGroup } from "./logging/models.js";
export { LogLevel, LoggerEnvironment, LoggerChangeEvent, LoggerSource } from "./logging/types.js";
export type { LoggingAdapter } from "./logging/adapters/base.js";
export { WinstonAdapter } from "./logging/adapters/winston.js";
export type { WinstonAdapterConfig } from "./logging/adapters/winston.js";
export { PinoAdapter } from "./logging/adapters/pino.js";
export type { PinoAdapterConfig } from "./logging/adapters/pino.js";

// Management
export {
  EnvironmentsClient,
  ContextTypesClient,
  ContextsClient,
  AccountSettingsClient,
} from "./management/client.js";
export { Environment, ContextType, AccountSettings } from "./management/models.js";
export { EnvironmentClassification, Color } from "./management/types.js";

// Shared WebSocket
export { SharedWebSocket } from "./ws.js";

// Error hierarchy — canonical names (Smplkit prefix). Old `Smpl*` names
// remain exported as deprecated aliases for backwards compatibility.
export {
  SmplkitError,
  SmplkitConnectionError,
  SmplkitTimeoutError,
  SmplkitNotFoundError,
  SmplkitConflictError,
  SmplkitValidationError,
  // Deprecated aliases — to be removed.
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
} from "./errors.js";
export type { ApiErrorDetail, ApiErrorObject } from "./errors.js";
