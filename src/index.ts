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
export { ConfigClient } from "./config/client.js";
export type { ConfigChangeEvent } from "./config/client.js";
export { Config, ConfigItem, ConfigEnvironment, ItemType } from "./config/types.js";
export { LiveConfigProxy } from "./config/proxy.js";

// Flags — public types
export { Context, Op, Rule, FlagDeclaration } from "./flags/types.js";

// Flags — runtime client + models
export { FlagsClient } from "./flags/client.js";
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
export { LoggingClient } from "./logging/client.js";
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

// Error hierarchy. `Smpl*` are the canonical class names (TypeScript can't
// use bare `Error`/`TypeError`/etc. — those are JS built-ins). The
// `Smplkit*` aliases are also exported for callers that prefer the longer
// prefix matching the package name (`@smplkit/sdk`).
export {
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
  SmplkitError,
  SmplkitConnectionError,
  SmplkitTimeoutError,
  SmplkitNotFoundError,
  SmplkitConflictError,
  SmplkitValidationError,
} from "./errors.js";
export type { ApiErrorDetail, ApiErrorObject } from "./errors.js";
