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
// Forwarders (SIEM streaming, Pro tier)
// ---------------------------------------------------------------------------

export interface HttpHeader {
  name: string;
  value: string;
}

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
  forwarderType: string;
  enabled: boolean;
  filter: Record<string, unknown> | null;
  transform: string | null;
  /** Header values are returned redacted on reads. */
  http: ForwarderHttp;
  data: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string | null;
  version: number | null;
}

export interface CreateForwarderInput {
  name: string;
  forwarderType: string;
  http: ForwarderHttp;
  enabled?: boolean;
  filter?: Record<string, unknown>;
  transform?: string;
  data?: Record<string, unknown>;
}

export interface UpdateForwarderInput extends CreateForwarderInput {
  /** Re-supply real header values. The GET path redacts them; sending
   *  `"<redacted>"` would persist that literal. */
}

export interface ListForwardersParams {
  forwarderType?: string;
  enabled?: boolean;
  pageSize?: number;
  pageAfter?: string;
}

export interface ListForwardersPage {
  forwarders: Forwarder[];
  nextCursor: string | null;
}

export type ForwarderDeliveryStatus =
  | "succeeded"
  | "failed"
  | "filtered_out"
  | "skipped_do_not_forward";

export interface ForwarderDelivery {
  id: string;
  forwarderId: string;
  eventId: string;
  attemptNumber: number;
  status: ForwarderDeliveryStatus;
  request: Record<string, unknown> | null;
  responseStatus: number | null;
  responseBody: string | null;
  latencyMs: number | null;
  error: string | null;
  createdAt: string | null;
}

export interface ListDeliveriesParams {
  status?: ForwarderDeliveryStatus;
  /** Range notation per ADR-014, e.g. `[2026-01-01T00:00:00Z,*)`. */
  createdAtRange?: string;
  pageSize?: number;
  pageAfter?: string;
}

export interface ListDeliveriesPage {
  deliveries: ForwarderDelivery[];
  nextCursor: string | null;
}

export interface RetryFailedDeliveriesSummary {
  attempted: number;
  succeeded: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// functions.test_forwarder
// ---------------------------------------------------------------------------

export interface TestForwarderRequest {
  url: string;
  method?: string;
  headers?: HttpHeader[];
  body?: string | null;
  successStatus?: string;
  /** Capped at 30s server-side. */
  timeoutMs?: number;
}

export interface TestForwarderResult {
  succeeded: boolean;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string;
  latencyMs: number | null;
  error: string | null;
}
