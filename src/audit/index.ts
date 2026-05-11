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
  ForwarderHttp,
  ForwarderType,
  HttpHeader,
  ListActionsParams,
  ListEventsPage,
  ListEventsParams,
  ListForwardersPage,
  ListForwardersParams,
  ListResourceTypesPage,
  ListResourceTypesParams,
  ResourceType,
  UpdateForwarderInput,
} from "./types.js";
