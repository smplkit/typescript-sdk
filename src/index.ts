/**
 * smplkit — Official TypeScript SDK for the smplkit platform.
 *
 * @packageDocumentation
 */

// Top-level client
export { SmplClient } from "./client.js";
export type { SmplClientOptions } from "./client.js";

// Per-request evaluation context — restorable scope returned by setContext
export { ContextScope } from "./context.js";

// Platform — cross-cutting CRUD (environments, services, contexts, context types)
export { PlatformClient } from "./platform/client.js";
export type { PlatformClientOptions } from "./platform/client.js";
export {
  EnvironmentsClient,
  ServicesClient,
  ContextsClient,
  ContextTypesClient,
} from "./platform/client.js";
export { Environment, Service, ContextType } from "./platform/models.js";
export { Color, EnvironmentClassification } from "./platform/types.js";

// Account — account-level settings
export { AccountClient } from "./account/client.js";
export type { AccountClientOptions } from "./account/client.js";
export { AccountSettings } from "./account/models.js";

// Audit
export { AuditClient } from "./audit/client.js";
export type { AuditClientOptions } from "./audit/client.js";
export {
  Forwarder,
  ForwarderEnvironment,
  ForwarderType,
  HttpConfiguration,
  HttpMethod as AuditHttpMethod,
  TransformType,
} from "./audit/types.js";
export type {
  EventType as AuditEventType,
  EventTypeListPage as AuditEventTypeListPage,
  ListEventTypesParams as AuditListEventTypesParams,
  AuditEvent,
  Category as AuditCategory,
  CategoryListPage as AuditCategoryListPage,
  ListCategoriesParams as AuditListCategoriesParams,
  CreateEventInput as CreateAuditEventInput,
  ListEventsPage as AuditEventListPage,
  ListEventsParams as AuditEventListParams,
  ListForwardersPage as AuditForwarderListPage,
  ListForwardersParams as AuditListForwardersParams,
  ResourceType as AuditResourceType,
  ListResourceTypesPage as AuditResourceTypeListPage,
  ListResourceTypesParams as AuditListResourceTypesParams,
  Pagination as AuditPagination,
} from "./audit/types.js";

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

// Jobs
export { JobsClient, RunsClient } from "./jobs/client.js";
export {
  HttpConfig,
  HttpMethod as JobsHttpMethod,
  Job,
  JobEnvironment,
  JobKind,
  Run,
  RunTrigger,
  Usage,
} from "./jobs/types.js";
export type { ListJobsParams, ListRunsParams } from "./jobs/types.js";

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
  SmplPaymentRequiredError,
  SmplNotInstalledError,
  SmplkitError,
  SmplkitConnectionError,
  SmplkitTimeoutError,
  SmplkitNotFoundError,
  SmplkitConflictError,
  SmplkitValidationError,
  SmplkitPaymentRequiredError,
  SmplkitNotInstalledError,
} from "./errors.js";
export type { ApiErrorDetail, ApiErrorObject } from "./errors.js";
