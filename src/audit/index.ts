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
 * `ResourceType`, `EventType`, `Category`) plus the `ForwarderType`,
 * `HttpMethod`, and `TransformType` enums live in `./types.js` and are
 * re-exported here for convenience.
 *
 * This module is also the package's `@smplkit/sdk/audit` subpath — the
 * edge/serverless entry. Its import graph is free of Node built-ins and of
 * the `ws` transport, so it bundles for edge runtimes (e.g. Cloudflare
 * Workers). Two differences from the package root apply there:
 *
 * - Configuration resolves from defaults → the `SMPLKIT_API_KEY` /
 *   `SMPLKIT_BASE_DOMAIN` / `SMPLKIT_SCHEME` / `SMPLKIT_ENVIRONMENT`
 *   environment variables → constructor options, exactly like the root —
 *   minus the `~/.smplkit` file step (that machinery needs `node:fs`, and
 *   an isolate has no home directory anyway).
 * - Pass `buffered: false` for the stateless write path: no background
 *   buffer or timers; `record()` performs one awaited POST per call.
 */

export { AuditClient, type AuditClientOptions } from "./client.js";
// The full typed error surface, so edge callers can catch what record()/list() throw.
export * from "../errors.js";
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
