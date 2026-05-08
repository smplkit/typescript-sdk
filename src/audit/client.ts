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
import type {
  AuditEvent,
  CreateEventInput,
  CreateForwarderInput,
  Forwarder,
  ForwarderDelivery,
  ForwarderDeliveryStatus,
  ForwarderHttp,
  ListDeliveriesPage,
  ListDeliveriesParams,
  ListEventsPage,
  ListEventsParams,
  ListForwardersPage,
  ListForwardersParams,
  RetryFailedDeliveriesSummary,
  TestForwarderRequest,
  TestForwarderResult,
  UpdateForwarderInput,
} from "./types.js";

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
  if (input.data !== undefined) attrs.data = input.data;
  if (input.doNotForward) attrs.do_not_forward = true;
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
    data: (attrs.data as Record<string, unknown> | undefined) ?? {},
    idempotencyKey: String(attrs.idempotency_key ?? ""),
    doNotForward: Boolean(attrs.do_not_forward ?? false),
  };
}

function _httpToWire(http: ForwarderHttp): Record<string, unknown> {
  return {
    method: http.method,
    url: http.url,
    headers: http.headers.map((h) => ({ name: h.name, value: h.value })),
    body: http.body,
    success_status: http.successStatus,
  };
}

function _httpFromWire(raw: Record<string, unknown> | undefined): ForwarderHttp {
  const r = raw ?? {};
  const headers = ((r.headers as Array<{ name?: string; value?: string }>) ?? []).map((h) => ({
    name: String(h.name ?? ""),
    value: String(h.value ?? ""),
  }));
  return {
    method: String(r.method ?? "POST"),
    url: String(r.url ?? ""),
    headers,
    body: (r.body as string | null) ?? null,
    successStatus: String(r.success_status ?? "2xx"),
  };
}

function _forwarderAttributes(
  input: CreateForwarderInput | UpdateForwarderInput,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    name: input.name,
    forwarder_type: input.forwarderType,
    enabled: input.enabled ?? true,
    http: _httpToWire(input.http),
  };
  if (input.filter !== undefined) attrs.filter = input.filter;
  if (input.transform !== undefined) attrs.transform = input.transform;
  if (input.data !== undefined) attrs.data = input.data;
  return attrs;
}

function _forwarderFromResource(resource: {
  id: string;
  attributes: Record<string, unknown>;
}): Forwarder {
  const a = resource.attributes;
  return {
    id: resource.id,
    name: String(a.name ?? ""),
    slug: String(a.slug ?? ""),
    forwarderType: String(a.forwarder_type ?? ""),
    enabled: Boolean(a.enabled ?? true),
    filter: (a.filter as Record<string, unknown> | null) ?? null,
    transform: (a.transform as string | null) ?? null,
    http: _httpFromWire(a.http as Record<string, unknown> | undefined),
    data: (a.data as Record<string, unknown> | undefined) ?? {},
    createdAt: (a.created_at as string | null) ?? null,
    updatedAt: (a.updated_at as string | null) ?? null,
    deletedAt: (a.deleted_at as string | null) ?? null,
    version: (a.version as number | null) ?? null,
  };
}

function _deliveryFromResource(resource: {
  id: string;
  attributes: Record<string, unknown>;
}): ForwarderDelivery {
  const a = resource.attributes;
  return {
    id: resource.id,
    forwarderId: String(a.forwarder_id ?? ""),
    eventId: String(a.event_id ?? ""),
    attemptNumber: Number(a.attempt_number ?? 1),
    status: (a.status as ForwarderDeliveryStatus) ?? "failed",
    request: (a.request as Record<string, unknown> | null) ?? null,
    responseStatus: (a.response_status as number | null) ?? null,
    responseBody: (a.response_body as string | null) ?? null,
    latencyMs: (a.latency_ms as number | null) ?? null,
    error: (a.error as string | null) ?? null,
    createdAt: (a.created_at as string | null) ?? null,
  };
}

function _nextCursorFromLinks(body: { links?: { next?: string | null } | null }): string | null {
  const next = body.links?.next;
  if (typeof next !== "string" || !next.includes("page[after]=")) return null;
  return next.split("page[after]=")[1]!;
}

class EventsClient {
  /** @internal */
  readonly _http: AuditHttp;
  private readonly _buffer: AuditEventBuffer;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    extraHeaders?: Record<string, string>;
  }) {
    const baseUrl = opts.baseUrl.replace(/\/$/, "");

    // openapi-fetch wraps the runtime fetch and provides typed
    // GET/POST/PUT/DELETE methods keyed off the OpenAPI paths interface.
    this._http = createClient<paths>({
      baseUrl,
      fetch: opts.fetch,
      headers: {
        ...(opts.extraHeaders ?? {}),
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
      throw new Error(`audit list failed: ${result.response.status} ${result.response.statusText}`);
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

// ---------------------------------------------------------------------------
// Forwarders
// ---------------------------------------------------------------------------

class DeliveryActionsClient {
  constructor(private readonly _http: AuditHttp) {}

  /** Retry a single failed delivery. Records a new attempt row with
   *  attempt_number = prior + 1; the prior row is unchanged. */
  async retry(forwarderId: string, deliveryId: string): Promise<ForwarderDelivery> {
    const result = await this._http.POST(
      "/api/v1/forwarders/{forwarder_id}/deliveries/{delivery_id}/actions/retry",
      { params: { path: { forwarder_id: forwarderId, delivery_id: deliveryId } } },
    );
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit retry delivery failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    return _deliveryFromResource(result.data.data);
  }
}

class DeliveriesClient {
  readonly actions: DeliveryActionsClient;

  constructor(private readonly _http: AuditHttp) {
    this.actions = new DeliveryActionsClient(_http);
  }

  async list(forwarderId: string, params: ListDeliveriesParams = {}): Promise<ListDeliveriesPage> {
    const query: Record<string, string | number> = {};
    if (params.status !== undefined) query["filter[status]"] = params.status;
    if (params.createdAtRange !== undefined) query["filter[created_at]"] = params.createdAtRange;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.pageAfter !== undefined) query["page[after]"] = params.pageAfter;

    const result = await this._http.GET("/api/v1/forwarders/{forwarder_id}/deliveries", {
      params: {
        path: { forwarder_id: forwarderId },
        query: query as unknown as Record<string, never>,
      },
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit list deliveries failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    const body = result.data;
    return {
      deliveries: (body.data ?? []).map(_deliveryFromResource),
      nextCursor: _nextCursorFromLinks(body),
    };
  }
}

class ForwarderActionsClient {
  constructor(private readonly _http: AuditHttp) {}

  /** Retry every failed delivery for a forwarder. Returns a count summary. */
  async retryFailedDeliveries(forwarderId: string): Promise<RetryFailedDeliveriesSummary> {
    const result = await this._http.POST(
      "/api/v1/forwarders/{forwarder_id}/actions/retry_failed_deliveries",
      { params: { path: { forwarder_id: forwarderId } } },
    );
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit bulk retry failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    const d = result.data as Record<string, unknown>;
    return {
      attempted: Number(d.attempted ?? 0),
      succeeded: Number(d.succeeded ?? 0),
      failed: Number(d.failed ?? 0),
    };
  }
}

class ForwardersClient {
  readonly deliveries: DeliveriesClient;
  readonly actions: ForwarderActionsClient;

  constructor(private readonly _http: AuditHttp) {
    this.deliveries = new DeliveriesClient(_http);
    this.actions = new ForwarderActionsClient(_http);
  }

  async create(input: CreateForwarderInput): Promise<Forwarder> {
    const body = { data: { id: "", type: "forwarder", attributes: _forwarderAttributes(input) } };
    const result = await this._http.POST("/api/v1/forwarders", {
      body: body as unknown as paths["/api/v1/forwarders"]["post"]["requestBody"]["content"]["application/vnd.api+json"],
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit create forwarder failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    return _forwarderFromResource(result.data.data);
  }

  async list(params: ListForwardersParams = {}): Promise<ListForwardersPage> {
    const query: Record<string, string | number | boolean> = {};
    if (params.forwarderType !== undefined) query["filter[forwarder_type]"] = params.forwarderType;
    if (params.enabled !== undefined) query["filter[enabled]"] = params.enabled;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.pageAfter !== undefined) query["page[after]"] = params.pageAfter;

    const result = await this._http.GET("/api/v1/forwarders", {
      params: { query: query as unknown as Record<string, never> },
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit list forwarders failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    const body = result.data;
    return {
      forwarders: (body.data ?? []).map(_forwarderFromResource),
      nextCursor: _nextCursorFromLinks(body),
    };
  }

  async get(forwarderId: string): Promise<Forwarder> {
    const result = await this._http.GET("/api/v1/forwarders/{forwarder_id}", {
      params: { path: { forwarder_id: forwarderId } },
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit get forwarder failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    return _forwarderFromResource(result.data.data);
  }

  async update(forwarderId: string, input: UpdateForwarderInput): Promise<Forwarder> {
    const body = {
      data: { id: forwarderId, type: "forwarder", attributes: _forwarderAttributes(input) },
    };
    const result = await this._http.PUT("/api/v1/forwarders/{forwarder_id}", {
      params: { path: { forwarder_id: forwarderId } },
      body: body as unknown as paths["/api/v1/forwarders/{forwarder_id}"]["put"]["requestBody"]["content"]["application/vnd.api+json"],
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit update forwarder failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    return _forwarderFromResource(result.data.data);
  }

  async delete(forwarderId: string): Promise<void> {
    const result = await this._http.DELETE("/api/v1/forwarders/{forwarder_id}", {
      params: { path: { forwarder_id: forwarderId } },
    });
    if (result.response.status !== 204) {
      throw new Error(
        `audit delete forwarder failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// functions.test_forwarder
// ---------------------------------------------------------------------------

class TestForwarderActionsClient {
  constructor(private readonly _http: AuditHttp) {}

  /** Server-side proxy to a customer-supplied URL. SSRF-guarded; the
   *  audit service rejects private/loopback/link-local addresses (incl.
   *  the EC2 IMDS at 169.254.169.254) and ports outside the allowlist. */
  async execute(input: TestForwarderRequest): Promise<TestForwarderResult> {
    const body: Record<string, unknown> = {
      method: input.method ?? "POST",
      url: input.url,
      headers: (input.headers ?? []).map((h) => ({ name: h.name, value: h.value })),
      body: input.body ?? null,
      success_status: input.successStatus ?? "2xx",
    };
    if (input.timeoutMs !== undefined) body.timeout_ms = input.timeoutMs;

    const result = await this._http.POST("/api/v1/functions/test_forwarder/actions/execute", {
      // This endpoint serves and accepts plain JSON, NOT JSON:API. The
      // openapi-fetch client adds its default JSON:API content-type
      // header; we override here so the server's strict validator
      // doesn't reject the request.
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body as unknown as paths["/api/v1/functions/test_forwarder/actions/execute"]["post"]["requestBody"]["content"]["application/json"],
    });
    if (!result.response.ok || result.data === undefined) {
      throw new Error(
        `audit test_forwarder failed: ${result.response.status} ${result.response.statusText}`,
      );
    }
    const d = result.data as Record<string, unknown>;
    return {
      succeeded: Boolean(d.succeeded),
      responseStatus: (d.response_status as number | null) ?? null,
      responseHeaders: (d.response_headers as Record<string, string> | undefined) ?? {},
      responseBody: String(d.response_body ?? ""),
      latencyMs: (d.latency_ms as number | null) ?? null,
      error: (d.error as string | null) ?? null,
    };
  }
}

class TestForwarderClient {
  readonly actions: TestForwarderActionsClient;
  constructor(http: AuditHttp) {
    this.actions = new TestForwarderActionsClient(http);
  }
}

class FunctionsClient {
  readonly test_forwarder: TestForwarderClient;
  constructor(http: AuditHttp) {
    this.test_forwarder = new TestForwarderClient(http);
  }
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

export class AuditClient {
  readonly events: EventsClient;
  readonly forwarders: ForwardersClient;
  readonly functions: FunctionsClient;

  constructor(opts: {
    apiKey: string;
    baseUrl: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
    extraHeaders?: Record<string, string>;
  }) {
    this.events = new EventsClient(opts);
    this.forwarders = new ForwardersClient(this.events._http);
    this.functions = new FunctionsClient(this.events._http);
  }

  /** @internal */
  async _close(): Promise<void> {
    await this.events._close();
  }
}
