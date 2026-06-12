/**
 * Smpl Audit SDK namespace.
 *
 * The audit subsystem records who did what to which resource and when.
 * Audit installs no in-process machinery, so it has no
 * runtime/management split: a single {@link AuditClient} exposes the full
 * surface and is reachable as `client.audit` on {@link SmplClient} or
 * constructed directly.
 *
 * The client owns event recording and read-side queries plus SIEM
 * forwarder CRUD:
 *
 * - `audit.events.record({ ..., flush: false })` — enqueue an audit event
 *   for asynchronous delivery; pass `flush: true` to block until the buffer
 *   drains.
 * - `audit.events.flush(timeoutMs)` — drain the buffer.
 * - `audit.events.list(...)` / `audit.events.get(id)` — query the audit log.
 * - `audit.resourceTypes.list(...)`, `audit.eventTypes.list(...)`, and
 *   `audit.categories.list(...)` — distinct-value listings that back the
 *   Activity tab filter dropdowns.
 * - `audit.forwarders.new/get/list/save/delete` — manage SIEM forwarders.
 *
 * The shared models (`AuditEvent`, `Forwarder`, `HttpConfiguration`,
 * `HttpHeader`, `ResourceType`, `EventType`, `Category`) plus the
 * `ForwarderType`, `HttpMethod`, and `TransformType` enums live in
 * `./types.js` and are re-exported here for convenience.
 */

export { AuditClient, type AuditClientOptions } from "./client.js";
export {
  Forwarder,
  ForwarderEnvironment,
  ForwarderType,
  HttpConfiguration,
  HttpMethod,
  TransformType,
} from "./types.js";
export type {
  AuditEvent,
  Category,
  CategoryListPage,
  CreateEventInput,
  EventType,
  EventTypeListPage,
  HttpHeader,
  ListCategoriesParams,
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
