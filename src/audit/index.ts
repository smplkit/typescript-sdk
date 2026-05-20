/**
 * Smpl Audit SDK namespace — see ADR-047.
 */

export { AuditClient } from "./client.js";
export { Forwarder, ForwarderType, HttpConfiguration, HttpMethod, TransformType } from "./types.js";
export type {
  AuditEvent,
  CreateEventInput,
  EventType,
  EventTypeListPage,
  HttpHeader,
  ListEventTypesParams,
  ListEventsPage,
  ListEventsParams,
  ListForwardersPage,
  ListForwardersParams,
  ListResourceTypesPage,
  ListResourceTypesParams,
  Pagination,
  ResourceType,
} from "./types.js";
