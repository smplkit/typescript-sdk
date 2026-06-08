/**
 * Audit namespace — runtime client.
 *
 * Public surface:
 *   client.audit.events.{record,list,get,flush}
 *   client.audit.resourceTypes.list(...)
 *   client.audit.eventTypes.list(...)
 *
 * The runtime audit client owns event recording and read-side queries —
 * fire-and-forget `record`, plus the audit-log list/get and the
 * distinct-value listings that back the Activity tab filter dropdowns.
 *
 * Management-plane operations (SIEM forwarder CRUD) live on
 * `SmplManagementClient` under `mgmt.audit.*`. ADR-047 §2.7.
 *
 * All HTTP work is delegated to the auto-generated openapi-fetch client
 * over `../generated/audit.d.ts` — the wrapper does not issue raw fetch
 * calls.
 */

import createClient from "openapi-fetch";

import type { components, paths } from "../generated/audit.d.ts";
import { SmplError, throwForStatus } from "../errors.js";
import { AuditEventBuffer, type PostOutcome } from "./buffer.js";
import type {
  AuditEvent,
  CreateEventInput,
  EventType,
  EventTypeListPage,
  ListEventTypesParams,
  ListEventsPage,
  ListEventsParams,
  ListResourceTypesPage,
  ListResourceTypesParams,
  Pagination,
  ResourceType,
} from "./types.js";

// Type aliases for the generated request shapes. Constructing these
// shapes directly (instead of `Record<string, unknown>` casts) means
// a spec change that drops a field fails to type-check at the
// construction site rather than silently shipping stale bytes.
type GenEvent = components["schemas"]["Event"];
type GenEventResponse = components["schemas"]["EventResponse"];

type AuditHttp = ReturnType<typeof createClient<paths>>;

const JSONAPI_CONTENT_TYPE = "application/vnd.api+json";

function _eventBodyFromInput(input: CreateEventInput): GenEventResponse {
  const attrs: GenEvent = {
    event_type: input.eventType,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    do_not_forward: input.doNotForward ?? false,
  };
  if (input.occurredAt !== undefined) {
    attrs.occurred_at =
      input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt;
  }
  if (input.actorType !== undefined) attrs.actor_type = input.actorType;
  if (input.actorId !== undefined) attrs.actor_id = input.actorId;
  if (input.actorLabel !== undefined) attrs.actor_label = input.actorLabel;
  if (input.data !== undefined) {
    attrs.data = input.data as { [key: string]: unknown };
  }
  return { data: { id: "", type: "event", attributes: attrs } };
}

function _eventFromResource(resource: {
  id: string;
  attributes: Record<string, unknown>;
}): AuditEvent {
  const attrs = resource.attributes;
  return {
    id: resource.id,
    eventType: String(attrs.event_type ?? ""),
    resourceType: String(attrs.resource_type ?? ""),
    resourceId: String(attrs.resource_id ?? ""),
    occurredAt: String(attrs.occurred_at ?? ""),
    createdAt: String(attrs.created_at ?? ""),
    actorType: (attrs.actor_type as string | null) ?? null,
    actorId: (attrs.actor_id as string | null) ?? null,
    actorLabel: (attrs.actor_label as string | null) ?? null,
    data: (attrs.data as Record<string, unknown> | undefined) ?? {},
    idempotencyKey: String(attrs.idempotency_key ?? ""),
    doNotForward: Boolean(attrs.do_not_forward ?? false),
    environment: (attrs.environment as string | null) ?? null,
  };
}

function _nextCursorFromLinks(body: { links?: { next?: string | null } | null }): string | null {
  const next = body.links?.next;
  if (typeof next !== "string" || !next.includes("page[after]=")) return null;
  // The link may include other query params after the cursor; the cursor
  // token is base64-url-safe so we slice at the next `&`.
  return next.split("page[after]=")[1]!.split("&")[0]!;
}

function _paginationFromBody(body: {
  meta?: { pagination?: Record<string, unknown> | null } | null;
}): Pagination {
  const raw = body.meta?.pagination ?? {};
  const out: Pagination = {
    page: Number(raw.page ?? 0),
    size: Number(raw.size ?? 0),
  };
  if (raw.total !== undefined && raw.total !== null) out.total = Number(raw.total);
  if (raw.total_pages !== undefined && raw.total_pages !== null) {
    out.totalPages = Number(raw.total_pages);
  }
  return out;
}

async function _throwForResponse(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  throwForStatus(response.status, body);
}

/**
 * Comma-join environment keys for the `filter[environment]` read filter.
 * Returns `undefined` (so the caller omits the param entirely) when the
 * list is absent or empty, matching the "unset ⇒ no filter sent" contract.
 */
function _joinEnvironments(environments: string[] | undefined): string | undefined {
  if (environments === undefined || environments.length === 0) return undefined;
  return environments.join(",");
}

class EventsClient {
  /** @internal */
  readonly _http: AuditHttp;
  private readonly _buffer: AuditEventBuffer;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    environment?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    extraHeaders?: Record<string, string>;
  }) {
    const baseUrl = opts.baseUrl.replace(/\/$/, "");

    // Runtime audit ops are environment-scoped: record / list / get /
    // discovery all resolve their environment from the
    // `X-Smplkit-Environment` request header (ADR-055). We stamp it once
    // at the client level from the SDK's configured runtime environment so
    // every generated call carries it. A caller-supplied `extraHeaders`
    // entry of the same name wins (explicit override), so the env header
    // goes in before `extraHeaders`.
    const headers: Record<string, string> = {};
    if (opts.environment !== undefined) headers["X-Smplkit-Environment"] = opts.environment;
    Object.assign(headers, opts.extraHeaders ?? {});

    // openapi-fetch wraps the runtime fetch and provides typed
    // GET/POST/PUT/DELETE methods keyed off the OpenAPI paths interface.
    this._http = createClient<paths>({
      baseUrl,
      fetch: opts.fetch,
      headers: {
        ...headers,
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
            body: item.body as GenEventResponse,
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
    this._buffer.enqueue(_eventBodyFromInput(input), input.idempotencyKey ?? null);
  }

  async list(params: ListEventsParams = {}): Promise<ListEventsPage> {
    const query: Record<string, string | number> = {};
    if (params.eventType !== undefined) query["filter[event_type]"] = params.eventType;
    if (params.resourceType !== undefined) query["filter[resource_type]"] = params.resourceType;
    if (params.resourceId !== undefined) query["filter[resource_id]"] = params.resourceId;
    if (params.actorType !== undefined) query["filter[actor_type]"] = params.actorType;
    if (params.actorId !== undefined) query["filter[actor_id]"] = params.actorId;
    if (params.occurredAtRange !== undefined) query["filter[occurred_at]"] = params.occurredAtRange;
    const environments = _joinEnvironments(params.environments);
    if (environments !== undefined) query["filter[environment]"] = environments;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.pageAfter !== undefined) query["page[after]"] = params.pageAfter;

    const result = await this._http.GET("/api/v1/events", {
      // openapi-fetch's typed query map is constrained by the spec's
      // exact param names; the JSON:API filter[*] / page[*] format isn't
      // expressible in that shape, so we cast and let openapi-fetch
      // URL-encode the literal keys.
      params: { query: query as unknown as Record<string, never> },
    });
    if (!result.response.ok) await _throwForResponse(result.response);
    if (result.data === undefined) throw new SmplError("Unexpected empty response from audit");
    const body = result.data;
    const rows = (body.data ?? []) as Array<{ id: string; attributes: Record<string, unknown> }>;
    return { events: rows.map(_eventFromResource), nextCursor: _nextCursorFromLinks(body) };
  }

  async get(eventId: string): Promise<AuditEvent> {
    const result = await this._http.GET("/api/v1/events/{event_id}", {
      params: { path: { event_id: eventId } },
    });
    if (!result.response.ok) await _throwForResponse(result.response);
    if (result.data === undefined) throw new SmplError("Unexpected empty response from audit");
    return _eventFromResource(
      result.data.data as { id: string; attributes: Record<string, unknown> },
    );
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

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

class ResourceTypesClient {
  constructor(private readonly _http: AuditHttp) {}

  /**
   * List the distinct `resource_type` slugs recorded for this account.
   *
   * Backed by a maintain-by-write side table (ADR-047 §2.5), so the
   * response time is independent of event volume. Sorted alphabetically;
   * offset pagination via `pageNumber` / `pageSize`.
   */
  async list(params: ListResourceTypesParams = {}): Promise<ListResourceTypesPage> {
    const query: Record<string, string | number | boolean> = {};
    const environments = _joinEnvironments(params.environments);
    if (environments !== undefined) query["filter[environment]"] = environments;
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.metaTotal !== undefined) query["meta[total]"] = params.metaTotal;

    const result = await this._http.GET("/api/v1/resource_types", {
      params: { query: query as unknown as Record<string, never> },
    });
    if (!result.response.ok) await _throwForResponse(result.response);
    if (result.data === undefined) throw new SmplError("Unexpected empty response from audit");
    const body = result.data;
    const resourceTypes: ResourceType[] = (body.data ?? []).map(
      (r: { id: string; attributes: Record<string, unknown> }) => ({
        id: r.id,
        createdAt: String((r.attributes as Record<string, unknown>).created_at ?? ""),
      }),
    );
    return { resourceTypes, pagination: _paginationFromBody(body) };
  }
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

class EventTypesClient {
  constructor(private readonly _http: AuditHttp) {}

  /**
   * List the distinct `event_type` slugs recorded for this account.
   *
   * Without `filterResourceType`, returns one row per distinct event type.
   * With `filterResourceType`, returns only the event types recorded with
   * that resource_type, powering cascading-filter UIs (ADR-047 §2.5).
   * Sorted alphabetically; offset pagination via `pageNumber` / `pageSize`.
   */
  async list(params: ListEventTypesParams = {}): Promise<EventTypeListPage> {
    const query: Record<string, string | number | boolean> = {};
    if (params.filterResourceType !== undefined)
      query["filter[resource_type]"] = params.filterResourceType;
    const environments = _joinEnvironments(params.environments);
    if (environments !== undefined) query["filter[environment]"] = environments;
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.metaTotal !== undefined) query["meta[total]"] = params.metaTotal;

    const result = await this._http.GET("/api/v1/event_types", {
      params: { query: query as unknown as Record<string, never> },
    });
    if (!result.response.ok) await _throwForResponse(result.response);
    if (result.data === undefined) throw new SmplError("Unexpected empty response from audit");
    const body = result.data;
    const eventTypes: EventType[] = (body.data ?? []).map(
      (r: { id: string; attributes: Record<string, unknown> }) => ({
        id: r.id,
        createdAt: String((r.attributes as Record<string, unknown>).created_at ?? ""),
      }),
    );
    return { eventTypes, pagination: _paginationFromBody(body) };
  }
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export class AuditClient {
  readonly events: EventsClient;
  readonly resourceTypes: ResourceTypesClient;
  readonly eventTypes: EventTypesClient;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    environment?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    extraHeaders?: Record<string, string>;
  }) {
    this.events = new EventsClient(opts);
    this.resourceTypes = new ResourceTypesClient(this.events._http);
    this.eventTypes = new EventTypesClient(this.events._http);
  }

  /** @internal */
  async _close(): Promise<void> {
    await this.events._close();
  }
}
