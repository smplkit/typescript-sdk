/**
 * Audit namespace — `client.audit.events.{create,list,get}`.
 *
 * ADR-047 §2.6. Writes are fire-and-forget by default: `create` enqueues the
 * event onto an in-memory bounded buffer and returns immediately. The buffer
 * worker flushes on a timer or when depth crosses a watermark, and retries
 * transient failures with exponential backoff. Reads are async and return
 * Promises that resolve to typed `AuditEvent` instances.
 */

import { AuditEventBuffer, type PostOutcome } from "./buffer.js";
import type {
  AuditEvent,
  CreateEventInput,
  ListEventsPage,
  ListEventsParams,
} from "./types.js";

const JSONAPI_HEADERS: Record<string, string> = {
  "Content-Type": "application/vnd.api+json",
  Accept: "application/vnd.api+json",
};

function _attributesFromInput(input: CreateEventInput): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    action: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
  };
  if (input.occurredAt !== undefined) {
    const ts = input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt;
    attrs.occurred_at = ts;
  }
  if (input.snapshot !== undefined) attrs.snapshot = input.snapshot;
  if (input.data !== undefined) attrs.data = input.data;
  return attrs;
}

function _eventFromResource(resource: {
  id: string;
  attributes: Record<string, unknown>;
}): AuditEvent {
  const attrs = resource.attributes;
  return {
    id: resource.id,
    action: String(attrs.action ?? ""),
    resourceType: String(attrs.resource_type ?? ""),
    resourceId: String(attrs.resource_id ?? ""),
    occurredAt: String(attrs.occurred_at ?? ""),
    createdAt: String(attrs.created_at ?? ""),
    actorType: String(attrs.actor_type ?? ""),
    actorId: (attrs.actor_id as string | null) ?? null,
    actorLabel: String(attrs.actor_label ?? ""),
    snapshot: (attrs.snapshot as Record<string, unknown> | null) ?? null,
    data: (attrs.data as Record<string, unknown> | undefined) ?? {},
    idempotencyKey: String(attrs.idempotency_key ?? ""),
  };
}

class EventsClient {
  private readonly _apiKey: string;
  private readonly _baseUrl: string;
  private readonly _timeoutMs: number;
  private readonly _buffer: AuditEventBuffer;
  /** @internal */
  _fetch: typeof fetch = fetch;

  constructor(opts: { apiKey: string; baseUrl: string; timeoutMs?: number }) {
    this._apiKey = opts.apiKey;
    this._baseUrl = opts.baseUrl.replace(/\/$/, "");
    this._timeoutMs = opts.timeoutMs ?? 10_000;

    this._buffer = new AuditEventBuffer({
      post: async (item): Promise<PostOutcome> => {
        try {
          const headers: Record<string, string> = {
            ...JSONAPI_HEADERS,
            Authorization: `Bearer ${this._apiKey}`,
          };
          if (item.idempotencyKey !== null) headers["Idempotency-Key"] = item.idempotencyKey;
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), this._timeoutMs);
          try {
            const resp = await this._fetch(`${this._baseUrl}/api/v1/events`, {
              method: "POST",
              headers,
              body: JSON.stringify(item.body),
              signal: ctrl.signal,
            });
            return { status: resp.status };
          } finally {
            clearTimeout(t);
          }
        } catch {
          return { status: 0 };
        }
      },
    });
  }

  /**
   * Enqueue an audit event for asynchronous delivery.
   * Returns immediately. The actual POST happens on the buffer worker.
   *
   * Customers may not emit `smpl.*` resource types — the server will
   * reject those with a 403 (the buffer logs and drops permanent
   * failures, so a misuse will silently disappear from the queue).
   */
  create(input: CreateEventInput): void {
    const body = {
      data: { type: "event", attributes: _attributesFromInput(input) },
    };
    this._buffer.enqueue(body, input.idempotencyKey ?? null);
  }

  async list(params: ListEventsParams = {}): Promise<ListEventsPage> {
    const qs = new URLSearchParams();
    if (params.action !== undefined) qs.set("filter[action]", params.action);
    if (params.resourceType !== undefined) qs.set("filter[resource_type]", params.resourceType);
    if (params.resourceId !== undefined) qs.set("filter[resource_id]", params.resourceId);
    if (params.actorType !== undefined) qs.set("filter[actor_type]", params.actorType);
    if (params.actorId !== undefined) qs.set("filter[actor_id]", params.actorId);
    if (params.occurredAtRange !== undefined)
      qs.set("filter[occurred_at]", params.occurredAtRange);
    if (params.pageSize !== undefined) qs.set("page[size]", String(params.pageSize));
    if (params.pageAfter !== undefined) qs.set("page[after]", params.pageAfter);

    const resp = await this._fetch(`${this._baseUrl}/api/v1/events?${qs.toString()}`, {
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        Accept: "application/vnd.api+json",
      },
    });
    if (!resp.ok) {
      throw new Error(`audit list failed: ${resp.status} ${resp.statusText}`);
    }
    const body = (await resp.json()) as {
      data?: Array<{ id: string; attributes: Record<string, unknown> }>;
      links?: { next?: string };
    };
    const events = (body.data ?? []).map(_eventFromResource);
    let nextCursor: string | null = null;
    const nextLink = body.links?.next;
    if (typeof nextLink === "string" && nextLink.includes("page[after]=")) {
      nextCursor = nextLink.split("page[after]=")[1]!;
    }
    return { events, nextCursor };
  }

  async get(eventId: string): Promise<AuditEvent> {
    const resp = await this._fetch(`${this._baseUrl}/api/v1/events/${eventId}`, {
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        Accept: "application/vnd.api+json",
      },
    });
    if (!resp.ok) {
      throw new Error(`audit get failed: ${resp.status} ${resp.statusText}`);
    }
    const body = (await resp.json()) as { data: { id: string; attributes: Record<string, unknown> } };
    return _eventFromResource(body.data);
  }

  /** Block until the in-memory buffer is drained or `timeoutMs` elapses. */
  async flush(timeoutMs = 5_000): Promise<void> {
    await this._buffer.flush(timeoutMs);
  }

  /** @internal */
  async _close(): Promise<void> {
    await this._buffer.close();
  }
}

export class AuditClient {
  readonly events: EventsClient;

  constructor(opts: { apiKey: string; baseUrl: string; timeoutMs?: number }) {
    this.events = new EventsClient(opts);
  }

  /** @internal */
  async _close(): Promise<void> {
    await this.events._close();
  }
}
