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
  snapshot: Record<string, unknown> | null;
  data: Record<string, unknown>;
  idempotencyKey: string;
}

export interface CreateEventInput {
  action: string;
  resourceType: string;
  resourceId: string;
  /** Defaults to server-side now() if omitted. */
  occurredAt?: Date | string;
  snapshot?: Record<string, unknown>;
  data?: Record<string, unknown>;
  /** Optional caller-supplied idempotency key. Server derives one from event content if absent. */
  idempotencyKey?: string;
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
