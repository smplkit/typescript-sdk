/**
 * smplkit — Official TypeScript SDK for the smplkit platform.
 *
 * @packageDocumentation
 */

// Main client
export { SmplClient } from "./client.js";
export type { SmplClientOptions } from "./client.js";

// Config
export { ConfigClient, ConfigManagement } from "./config/client.js";
export type { ConfigChangeEvent } from "./config/client.js";
export { Config } from "./config/types.js";
export { LiveConfigProxy } from "./config/proxy.js";

// Flags — public types
export { Context, Rule } from "./flags/types.js";

// Flags — management + runtime
export { FlagsClient, FlagsManagement } from "./flags/client.js";
export { Flag, BooleanFlag, StringFlag, NumberFlag, JsonFlag } from "./flags/models.js";
export { FlagChangeEvent, FlagStats } from "./flags/client.js";

// Logging
export { LoggingClient, LoggingManagement } from "./logging/client.js";
export { Logger, LogGroup } from "./logging/models.js";
export { LogLevel } from "./logging/types.js";
export type { LoggerChangeEvent } from "./logging/types.js";
export type { LoggingAdapter } from "./logging/adapters/base.js";
export { WinstonAdapter } from "./logging/adapters/winston.js";
export type { WinstonAdapterConfig } from "./logging/adapters/winston.js";
export { PinoAdapter } from "./logging/adapters/pino.js";
export type { PinoAdapterConfig } from "./logging/adapters/pino.js";

// Management
export { ManagementClient } from "./management/client.js";
export {
  EnvironmentsClient,
  ContextTypesClient,
  ContextsClient,
  AccountSettingsClient,
} from "./management/client.js";
export { Environment, ContextType, ContextEntity, AccountSettings } from "./management/models.js";
export { EnvironmentClassification } from "./management/types.js";

// Logging — LoggerSource
export { LoggerSource } from "./logging/types.js";

// Shared WebSocket
export { SharedWebSocket } from "./ws.js";

// Error hierarchy
export {
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
} from "./errors.js";
export type { ApiErrorObject } from "./errors.js";
