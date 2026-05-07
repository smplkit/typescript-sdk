/**
 * Audit namespace — `client.audit.events.{record,list,get}`.
 *
 * ADR-047 §2.6. Writes are fire-and-forget by default: `record` enqueues the
 * event onto an in-memory bounded buffer and returns immediately. The buffer
 * worker flushes on a timer or when depth crosses a watermark, and retries
 * transient failures with exponential backoff. Reads are async and return
 * Promises that resolve to typed `AuditEvent` instances.
 *
 * All HTTP work is delegated to the auto-generated openapi-fetch client
 * over `../generated/audit.d.ts` — the wrapper does not issue raw fetch
 * calls.
 */

import createClient from "openapi-fetch";

import type { paths } from "../generated/audit.d.ts";
import { AuditEventBuffer, type PostOutcome } from "./buffer.js";
import type { AuditEvent, CreateEventInput, ListEventsPage, ListEventsParams } from "./types.js";

type AuditHttp = ReturnType<typeof createClient<paths>>;

const JSONAPI_CONTENT_TYPE = "application/vnd.api+json";

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
  /** @internal */
  readonly _http: AuditHttp;
  private readonly _buffer: AuditEventBuffer;

  constructor(opts: { apiKey: string; baseUrl: string; timeoutMs?: number; fetch?: typeof fetch }) {
    const baseUrl = opts.baseUrl.replace(/\/$/, "");

    // openapi-fetch wraps the runtime fetch and provides typed
    // GET/POST/PUT/DELETE methods keyed off the OpenAPI paths interface.
    this._http = createClient<paths>({
      baseUrl,
      fetch: opts.fetch,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: JSONAPI_CONTENT_TYPE,
        "Content-Type": JSONAPI_CONTENT_TYPE,
      },
    });

    this._buffer = new AuditEventBuffer({
      post: async (item): Promise<PostOutcome> => {
        try {
          const headerInit: Record<string, string> = {};
          if (item.idempotencyKey !== null) headerInit["Idempotency-Key"] = item.idempotencyKey;
          const result = await this._http.POST("/api/v1/events", {
            // Casting through unknown because the generated body type is
            // EventResponse with id required, while the wrapper builds an
            // unsaved-resource body without an id (server assigns).
            body: item.body as unknown as paths["/api/v1/events"]["post"]["requestBody"]["content"]["application/vnd.api+json"],
            headers: headerInit,
          });
          return { status: result.response.status };
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
  record(input: CreateEventInput): void {
    const body = {
      data: { id: "", type: "event", attributes: _attributesFromInput(input) },
    };
    this._buffer.enqueue(body, input.idempotencyKey ?? null);
  }

  async list(params: ListEventsParams = {}): Promise<ListEventsPage> {
    const query: Record<string, string | number> = {};
    if (params.action !== undefined) query["filter[action]"] = params.action;
    if (params.resourceType !== undefined) query["filter[resource_type]"] = params.resourceType;
    if (params.resourceId !== undefined) query["filter[resource_id]"] = params.resourceId;
    if (params.actorType !== undefined) query["filter[actor_type]"] = params.actorType;
    if (params.actorId !== undefined) query["filter[actor_id]"] = params.actorId;
    if (params.occurredAtRange !== undefined) query["filter[occurred_at]"] = params.occurredAtRange;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.pageAfter !== undefined) query["page[after]"] = params.pageAfter;

    const result = await this._http.GET("/api/v1/events", {
      // openapi-fetch's typed query map is constrained by the spec's
      // exact param names (filteraction etc.); the JSON:API filter[*]
      // / page[*] format isn't expressible in that shape, so we cast
      // and let openapi-fetch URL-encode the literal keys.
      params: { query: query as unknown as Record<string, never> },
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit list failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    const body = result.data;
    const events = (body.data ?? []).map(_eventFromResource);
    let nextCursor: string | null = null;
    const nextLink = body.links?.next;
    if (typeof nextLink === "string" && nextLink.includes("page[after]=")) {
      nextCursor = nextLink.split("page[after]=")[1]!;
    }
    return { events, nextCursor };
  }

  async get(eventId: string): Promise<AuditEvent> {
    const result = await this._http.GET("/api/v1/events/{event_id}", {
      params: { path: { event_id: eventId } },
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(`audit get failed: ${result.response.status} ${result.response.statusText}`);
    }
    return _eventFromResource(result.data.data);
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

  constructor(opts: { apiKey: string; baseUrl: string; timeoutMs?: number; fetch?: typeof fetch }) {
    this.events = new EventsClient(opts);
  }

  /** @internal */
  async _close(): Promise<void> {
    await this.events._close();
  }
}
