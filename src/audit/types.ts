/**
 * Audit event resource types — surface exposed by `client.audit.events.*`.
 *
 * ADR-047 §2.3.1.
 */

export interface AuditEvent {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  occurredAt: string; // ISO-8601 with offset
  createdAt: string; // ISO-8601 with offset
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  data: Record<string, unknown>;
  idempotencyKey: string;
  doNotForward: boolean;
}

export interface CreateEventInput {
  action: string;
  resourceType: string;
  resourceId: string;
  /** Defaults to server-side now() if omitted. */
  occurredAt?: Date | string;
  /**
   * Free-form contextual JSON. To record a resource snapshot, nest it
   * inside `data` — smplkit's internal convention is `data.snapshot`,
   * but the shape is unconstrained.
   */
  data?: Record<string, unknown>;
  /** Optional caller-supplied idempotency key. Server derives one from event content if absent. */
  idempotencyKey?: string;
  /**
   * When true, the audit service records the event normally but does NOT POST
   * it through any configured SIEM forwarder. A `skipped_do_not_forward`
   * delivery row is recorded for each enabled forwarder so the skip is
   * visible in the forwarder delivery log.
   */
  doNotForward?: boolean;
}

export interface ListEventsParams {
  action?: string;
  resourceType?: string;
  resourceId?: string;
  actorType?: string;
  actorId?: string;
  /** Range notation per ADR-014, e.g. `[2026-01-01T00:00:00Z,*)`. */
  occurredAtRange?: string;
  pageSize?: number;
  pageAfter?: string;
}

export interface ListEventsPage {
  events: AuditEvent[];
  /** Opaque cursor for the next page, or null if this is the last page. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Resource types (distinct resource_type slugs seen in the account)
// ---------------------------------------------------------------------------

export interface ResourceType {
  /** The resource_type slug. */
  id: string;
  createdAt: string;
}

export interface ListResourceTypesParams {
  pageSize?: number;
  pageAfter?: string;
}

export interface ListResourceTypesPage {
  resourceTypes: ResourceType[];
  /** Opaque cursor for the next page, or null if this is the last page. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Actions (distinct action slugs seen in the account)
// ---------------------------------------------------------------------------

export interface Action {
  /** The action slug. */
  id: string;
  createdAt: string;
}

export interface ListActionsParams {
  /** When set, returns only the actions seen with this resource_type. */
  filterResourceType?: string;
  pageSize?: number;
  pageAfter?: string;
}

export interface ActionListPage {
  actions: Action[];
  /** Opaque cursor for the next page, or null if this is the last page. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Forwarders (SIEM streaming)
// ---------------------------------------------------------------------------

export interface HttpHeader {
  name: string;
  value: string;
}

/**
 * Supported SIEM forwarder destination types.
 *
 * ADR-047 §2.12. Mirrors the OpenAPI ``ForwarderType`` enum so callers
 * see autocomplete and the compiler rejects typos at build time. The
 * runtime values are a subset of the published constant
 * {@link FORWARDER_TYPES} for callers that need to iterate.
 */
export type ForwarderType =
  | "HTTP"
  | "DATADOG"
  | "SPLUNK_HEC"
  | "SUMO_LOGIC"
  | "NEW_RELIC"
  | "HONEYCOMB"
  | "ELASTIC";

/**
 * Runtime tuple of every {@link ForwarderType} value, in the same order
 * as the type union. Useful for `<select>` options or membership checks
 * where a static type alone won't do.
 */
export const FORWARDER_TYPES: readonly ForwarderType[] = [
  "HTTP",
  "DATADOG",
  "SPLUNK_HEC",
  "SUMO_LOGIC",
  "NEW_RELIC",
  "HONEYCOMB",
  "ELASTIC",
] as const;

export interface ForwarderHttp {
  method: string;
  url: string;
  headers: HttpHeader[];
  body: string | null;
  /**
   * 3-character string: an exact HTTP code (e.g. `"200"`, `"204"`) or a
   * class (`"2xx"`, `"3xx"`, `"4xx"`, `"5xx"`).
   */
  successStatus: string;
}

export interface Forwarder {
  id: string;
  name: string;
  slug: string;
  forwarderType: ForwarderType;
  enabled: boolean;
  filter: Record<string, unknown> | null;
  transform: string | null;
  /** Header values are returned redacted on reads. */
  http: ForwarderHttp;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  version: number | null;
}

export interface CreateForwarderInput {
  name: string;
  forwarderType: ForwarderType;
  http: ForwarderHttp;
  enabled?: boolean;
  filter?: Record<string, unknown>;
  transform?: string;
}

export interface UpdateForwarderInput extends CreateForwarderInput {
  /** Re-supply real header values. The GET path redacts them; sending
   *  `"<redacted>"` would persist that literal. */
}

export interface ListForwardersParams {
  forwarderType?: ForwarderType;
  enabled?: boolean;
  pageSize?: number;
  pageAfter?: string;
}

export interface ListForwardersPage {
  forwarders: Forwarder[];
  nextCursor: string | null;
}
