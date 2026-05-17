/**
 * Smpl Audit SDK namespace — see ADR-047.
 */

export { AuditClient } from "./client.js";
export { FORWARDER_TYPES } from "./types.js";
export type {
  Action,
  ActionListPage,
  AuditEvent,
  CreateEventInput,
  CreateForwarderInput,
  Forwarder,
  ForwarderType,
  HttpConfiguration,
  HttpHeader,
  ListActionsParams,
  ListEventsPage,
  ListEventsParams,
  ListForwardersPage,
  ListForwardersParams,
  ListResourceTypesPage,
  ListResourceTypesParams,
  Pagination,
  ResourceType,
  TransformType,
  UpdateForwarderInput,
} from "./types.js";
