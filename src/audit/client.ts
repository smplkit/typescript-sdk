/**
 * The Smpl Audit client.
 *
 * Audit installs no in-process machinery, so it has no runtime/management
 * split: one `AuditClient` exposes the full surface, reachable as
 * `client.audit` ({@link SmplClient}) or standalone:
 *
 *     audit.events.record({ eventType, resourceType, resourceId, ... })
 *     audit.events.flush(timeoutMs)
 *     audit.events.list(...)
 *     audit.events.get(eventId)
 *     audit.resourceTypes.list(...)
 *     audit.eventTypes.list(...)
 *     audit.categories.list(...)
 *     audit.forwarders.new/get/list/save/delete(...)
 *
 * Reads, discovery, and forwarder CRUD perform their network round-trips
 * with `await`. Only `events.record` is fire-and-forget (it enqueues onto
 * a background buffer and returns without awaiting), which is the correct
 * shape for the hot path.
 *
 * By default `record` enqueues onto an in-memory bounded buffer and returns
 * immediately; the buffer retries with exponential backoff on transient
 * failures and drops the oldest item under back pressure. Pass `flush: true`
 * when the caller needs the event
 * durable before continuing — typically in CLI tools, in-test assertions,
 * or any flow about to terminate the process.
 *
 * All HTTP work is delegated to the auto-generated openapi-fetch client
 * over `../generated/audit.d.ts` — the wrapper does not issue raw fetch
 * calls.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";

import type { components, paths } from "../generated/audit.d.ts";
import {
  SmplError,
  SmplkitConnectionError,
  SmplkitTimeoutError,
  throwForStatus,
} from "../errors.js";
import { resolveClientConfig, serviceUrl } from "../config.js";
import { AuditEventBuffer, type PostOutcome } from "./buffer.js";
import {
  Forwarder,
  ForwarderEnvironment,
  ForwarderType,
  HttpConfiguration,
  HttpMethod,
  TransformType,
  type AuditEvent,
  type Category,
  type CategoryListPage,
  type CreateEventInput,
  type EventType,
  type EventTypeListPage,
  type HttpHeader,
  type ListCategoriesParams,
  type ListEventTypesParams,
  type ListEventsPage,
  type ListEventsParams,
  type ListForwardersPage,
  type ListForwardersParams,
  type ListResourceTypesParams,
  type ListResourceTypesPage,
  type Pagination,
  type ResourceType,
} from "./types.js";

// Type aliases for the generated request shapes. Constructing these
// shapes directly (instead of `Record<string, unknown>` casts) means a
// spec change that drops a field fails to type-check at the construction
// site rather than silently shipping stale bytes.
type GenEvent = components["schemas"]["Event"];
type GenEventResponse = components["schemas"]["EventResponse"];
type GenForwarder = components["schemas"]["Forwarder"];
type GenHttpConfiguration = components["schemas"]["HttpConfiguration"];
type GenForwarderEnvironment = components["schemas"]["ForwarderEnvironment"];
type GenForwarderCreateRequest = components["schemas"]["ForwarderCreateRequest"];
type GenForwarderRequest = components["schemas"]["ForwarderRequest"];

type AuditHttp = ReturnType<typeof createClient<paths>>;

const BASE_URL = "https://audit.smplkit.com";

const JSONAPI_CONTENT_TYPE = "application/vnd.api+json";

// ---------------------------------------------------------------------------
// Shared HTTP error handling
// ---------------------------------------------------------------------------

/** @internal */
async function checkError(response: Response, error?: unknown): Promise<never> {
  // ``openapi-fetch`` pre-reads the response body to populate ``result.error``
  // / ``result.data`` — by the time we get here ``response.text()`` returns
  // ``""`` because the stream is consumed. Prefer the pre-parsed error payload
  // when openapi-fetch handed one to us; fall back to a fresh ``.text()``.
  let body = "";
  if (error !== undefined && error !== null) {
    try {
      body = typeof error === "string" ? error : JSON.stringify(error);
      /* v8 ignore start — defensive guard; openapi-fetch parses JSON itself
         so circular refs / BigInts never reach this code path. */
    } catch {
      // leave body empty; throwForStatus tolerates an empty payload
    }
    /* v8 ignore stop */
  }
  /* v8 ignore start — fallback for the rare null/empty-error case. */
  if (!body) {
    body = await response.text().catch(() => "");
  }
  /* v8 ignore stop */
  throwForStatus(response.status, body);
}

/** @internal */
function wrapFetchError(err: unknown): never {
  if (err instanceof SmplError) throw err;
  if (err instanceof TypeError) {
    throw new SmplkitConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplkitConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// ---------------------------------------------------------------------------
// Wire <-> wrapper conversions (events)
// ---------------------------------------------------------------------------

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
  if (input.category !== undefined) attrs.category = input.category;
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
    category: (attrs.category as string | null) ?? null,
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

// ---------------------------------------------------------------------------
// Wire <-> wrapper conversions (forwarders)
// ---------------------------------------------------------------------------

function _configurationToWire(config: HttpConfiguration): GenHttpConfiguration {
  return {
    method: config.method as GenHttpConfiguration["method"],
    url: config.url,
    headers: config.headers.map((h: HttpHeader) => ({ name: h.name, value: h.value })),
    success_status: config.successStatus,
    tls_verify: config.tlsVerify,
    ca_cert: config.caCert,
  };
}

function _configurationFromWire(raw: Record<string, unknown> | undefined): HttpConfiguration {
  const r = raw ?? {};
  const headers = ((r.headers as Array<{ name?: string; value?: string }>) ?? []).map((h) => ({
    name: String(h.name ?? ""),
    value: String(h.value ?? ""),
  }));
  return new HttpConfiguration({
    method: (r.method as HttpMethod | undefined) ?? HttpMethod.POST,
    url: String(r.url ?? ""),
    headers,
    successStatus: String(r.success_status ?? "2xx"),
    // Absent ``tls_verify`` on the wire means a forwarder persisted before
    // the field landed — default to verifying so its prior secure
    // behaviour is preserved.
    tlsVerify: r.tls_verify === undefined ? true : Boolean(r.tls_verify),
    caCert: r.ca_cert == null ? null : String(r.ca_cert),
  });
}

function _environmentsToWire(environments: Record<string, ForwarderEnvironment>): {
  [key: string]: GenForwarderEnvironment;
} {
  // Per-environment `configuration` overrides are sent as full
  // HttpConfiguration payloads (plaintext headers in), mirroring the base
  // configuration's round-trip semantics.
  const out: { [key: string]: GenForwarderEnvironment } = {};
  for (const [envKey, env] of Object.entries(environments)) {
    out[envKey] = {
      enabled: env.enabled,
      configuration: env.configuration === null ? null : _configurationToWire(env.configuration),
    };
  }
  return out;
}

function _environmentsFromWire(
  raw: Record<string, unknown> | undefined,
): Record<string, ForwarderEnvironment> {
  const out: Record<string, ForwarderEnvironment> = {};
  for (const [envKey, value] of Object.entries(raw ?? {})) {
    const v = (value ?? {}) as {
      enabled?: unknown;
      configuration?: Record<string, unknown> | null;
    };
    out[envKey] = new ForwarderEnvironment({
      enabled: Boolean(v.enabled ?? false),
      configuration:
        v.configuration == null
          ? null
          : _configurationFromWire(v.configuration as Record<string, unknown>),
    });
  }
  return out;
}

function _normalizeEnvironments(
  environments:
    | Record<
        string,
        ForwarderEnvironment | { enabled?: boolean; configuration?: HttpConfiguration | null }
      >
    | null
    | undefined,
): Record<string, ForwarderEnvironment> {
  // Accept either ForwarderEnvironment instances or plain objects
  // (`{ enabled: true, configuration: new HttpConfiguration(...) }`) so
  // callers can use the lightweight literal form without importing the
  // class.
  const out: Record<string, ForwarderEnvironment> = {};
  for (const [envKey, value] of Object.entries(environments ?? {})) {
    out[envKey] =
      value instanceof ForwarderEnvironment
        ? value
        : new ForwarderEnvironment({
            enabled: value.enabled ?? false,
            configuration: value.configuration ?? null,
          });
  }
  return out;
}

function _forwarderAttrs(forwarder: Forwarder): GenForwarder {
  // The base `enabled` is server-pinned false (ADR-055); we don't send it.
  // Enablement travels entirely through `environments`.
  const attrs: GenForwarder = {
    name: forwarder.name,
    forwarder_type: forwarder.forwarderType,
    configuration: _configurationToWire(forwarder.configuration),
    forward_smplkit_events: forwarder.forwardSmplkitEvents,
  } as GenForwarder;
  if (Object.keys(forwarder.environments).length > 0) {
    attrs.environments = _environmentsToWire(forwarder.environments);
  }
  if (forwarder.description !== null) attrs.description = forwarder.description;
  if (forwarder.filter !== null) {
    attrs.filter = forwarder.filter as { [key: string]: unknown };
  }
  // transform and transformType travel as a pair: either both are set or
  // neither is. The SDK enforces the constraint at save time so the
  // mistake surfaces in the SDK call site, not as a server-side 400.
  const hasTransform = forwarder.transform !== null && forwarder.transform !== undefined;
  const hasTransformType =
    forwarder.transformType !== null && forwarder.transformType !== undefined;
  if (hasTransform !== hasTransformType) {
    throw new Error(
      "Forwarder.transform and Forwarder.transformType must be set together (or both unset)",
    );
  }
  if (hasTransform) {
    if (
      forwarder.transformType === TransformType.JSONATA &&
      typeof forwarder.transform !== "string"
    ) {
      throw new Error(
        "Forwarder.transform must be a string when Forwarder.transformType is JSONATA",
      );
    }
    attrs.transform_type = forwarder.transformType as TransformType;
    attrs.transform = forwarder.transform;
  }
  return attrs;
}

function _forwarderFromResource(
  resource: { id: string; attributes: Record<string, unknown> },
  client: ForwardersClient,
): Forwarder {
  const a = resource.attributes;
  return new Forwarder(client, {
    id: resource.id,
    name: String(a.name ?? ""),
    description: (a.description as string | null) ?? null,
    forwarderType: a.forwarder_type as ForwarderType,
    // The base `enabled` is server-pinned false; round-trip whatever the
    // server returned (always false) without assuming a default of true.
    enabled: Boolean(a.enabled ?? false),
    environments: _environmentsFromWire(a.environments as Record<string, unknown> | undefined),
    // Absent on the wire (a forwarder persisted before the field landed)
    // reads back as false — the additive default.
    forwardSmplkitEvents: Boolean(a.forward_smplkit_events ?? false),
    filter: (a.filter as Record<string, unknown> | null) ?? null,
    transformType: (a.transform_type as TransformType | null) ?? null,
    transform: (a.transform as string | null) ?? null,
    configuration: _configurationFromWire(a.configuration as Record<string, unknown> | undefined),
    createdAt: (a.created_at as string | null) ?? null,
    updatedAt: (a.updated_at as string | null) ?? null,
    deletedAt: (a.deleted_at as string | null) ?? null,
    version: (a.version as number | null) ?? null,
  });
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/** Surface for `client.audit.events.*`. */
class EventsClient {
  /** @internal */
  constructor(
    private readonly _http: AuditHttp,
    private readonly _buffer: AuditEventBuffer,
  ) {}

  /**
   * Enqueue an audit event for asynchronous delivery.
   *
   * Returns immediately when `flush` is false (the default) — the buffer's
   * worker performs the actual POST with retry on transient failures.
   *
   * When `flush: true`, this call awaits until the buffer has drained or
   * `flushTimeoutMs` elapses. Use this when the caller needs the event
   * durable before continuing — typical examples are CLI tools, in-test
   * assertions, and any flow about to exit the process. The
   * fire-and-forget default remains the right choice on the
   * request-handling hot path.
   */
  async record(input: CreateEventInput): Promise<void> {
    this._buffer.enqueue(_eventBodyFromInput(input), input.idempotencyKey ?? null);
    if (input.flush) {
      await this._buffer.flush(input.flushTimeoutMs ?? 5_000);
    }
  }

  /**
   * List audit events for the authenticated account.
   *
   * Filters apply server-side. `actorId` is matched as a literal string
   * against whatever the recording call stored. Pagination uses an opaque
   * cursor (`pageAfter`); the returned page exposes `nextCursor` if more
   * pages are available.
   *
   * `search` is an optional free-text filter: pass a string to return only
   * events whose `resourceId` or `description` contains it as a
   * case-insensitive substring; omit it (the default) to disable text
   * filtering. A `search` filter must be scoped — combine it with
   * `occurredAtRange`, or with both `resourceType` and `resourceId` — or the
   * request is rejected.
   *
   * `environments` scopes the read to a set of environments: pass a list
   * of environment keys and/or the reserved `"smplkit"` control-plane
   * bucket; the values are sent comma-separated as `filter[environment]`.
   * Omit it (the default) to leave the param off entirely and let
   * environment scope fall back to the `X-Smplkit-Environment` request
   * header.
   */
  async list(params: ListEventsParams = {}): Promise<ListEventsPage> {
    const query: Record<string, string | number> = {};
    if (params.eventType !== undefined) query["filter[event_type]"] = params.eventType;
    if (params.resourceType !== undefined) query["filter[resource_type]"] = params.resourceType;
    if (params.resourceId !== undefined) query["filter[resource_id]"] = params.resourceId;
    if (params.actorType !== undefined) query["filter[actor_type]"] = params.actorType;
    if (params.actorId !== undefined) query["filter[actor_id]"] = params.actorId;
    if (params.occurredAtRange !== undefined) query["filter[occurred_at]"] = params.occurredAtRange;
    if (params.search !== undefined) query["filter[search]"] = params.search;
    const environments = _joinEnvironments(params.environments);
    if (environments !== undefined) query["filter[environment]"] = environments;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.pageAfter !== undefined) query["page[after]"] = params.pageAfter;

    const result = await this._http.GET("/api/v1/events", {
      // openapi-fetch's typed query map is constrained by the spec's exact
      // param names; the JSON:API filter[*] / page[*] format isn't
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

  /**
   * Retrieve a single audit event by id.
   *
   * Throws {@link SmplNotFoundError} if no event with that id exists in the
   * caller's account.
   */
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

  /**
   * Block until the in-memory buffer is drained or `timeoutMs` elapses.
   *
   * Equivalent to passing `flush: true` to a final {@link record} call.
   * Useful for draining buffered events at process shutdown or after a
   * batch of fire-and-forget records.
   */
  async flush(timeoutMs = 5_000): Promise<void> {
    await this._buffer.flush(timeoutMs);
  }

  /** @internal */
  async _close(): Promise<void> {
    await this._buffer.close();
  }
}

// ---------------------------------------------------------------------------
// resource types
// ---------------------------------------------------------------------------

/** Surface for `client.audit.resourceTypes.*`. */
class ResourceTypesClient {
  constructor(private readonly _http: AuditHttp) {}

  /**
   * List the distinct `resource_type` slugs seen in the account.
   *
   * Response time is independent of how many years of events the account
   * has accumulated. Sorted alphabetically; offset paginated.
   *
   * `environments` scopes the listing to a set of environments: pass a list
   * of environment keys and/or the reserved `"smplkit"` control-plane
   * bucket; the values are sent comma-separated as `filter[environment]`.
   * Omit it (the default) to leave the param off entirely.
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
    const resourceTypes: ResourceType[] = (
      (body.data ?? []) as Array<{ id: string; attributes: Record<string, unknown> }>
    ).map((r) => ({
      id: r.id,
      resourceType: String(r.attributes.resource_type ?? r.id),
      createdAt: String(r.attributes.created_at ?? ""),
    }));
    return { resourceTypes, pagination: _paginationFromBody(body) };
  }
}

// ---------------------------------------------------------------------------
// event types
// ---------------------------------------------------------------------------

/** Surface for `client.audit.eventTypes.*`. */
class EventTypesClient {
  constructor(private readonly _http: AuditHttp) {}

  /**
   * List the distinct `event_type` slugs seen in the account.
   *
   * Without `filterResourceType`, returns one row per distinct event_type
   * — an event_type recorded with multiple resource_types appears once.
   * With the filter, returns the event_types seen with that specific
   * resource_type, powering the cascading-filter behavior on the Activity
   * tab.
   *
   * `environments` scopes the listing to a set of environments: pass a list
   * of environment keys and/or the reserved `"smplkit"` control-plane
   * bucket; the values are sent comma-separated as `filter[environment]`.
   * Omit it (the default) to leave the param off entirely.
   *
   * Response time is independent of how many years of events the account
   * has accumulated. Sorted alphabetically; offset paginated.
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
    const eventTypes: EventType[] = (
      (body.data ?? []) as Array<{ id: string; attributes: Record<string, unknown> }>
    ).map((r) => ({
      id: r.id,
      eventType: String(r.attributes.event_type ?? r.id),
      createdAt: String(r.attributes.created_at ?? ""),
    }));
    return { eventTypes, pagination: _paginationFromBody(body) };
  }
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

/** Surface for `client.audit.categories.*`. */
class CategoriesClient {
  constructor(private readonly _http: AuditHttp) {}

  /**
   * List the distinct `category` values seen in the account.
   *
   * Response time is independent of how many years of events the account
   * has accumulated. Sorted alphabetically; offset paginated.
   *
   * `environments` scopes the listing to a set of environments: pass a list
   * of environment keys and/or the reserved `"smplkit"` control-plane
   * bucket; the values are sent comma-separated as `filter[environment]`.
   * Omit it (the default) to leave the param off entirely.
   */
  async list(params: ListCategoriesParams = {}): Promise<CategoryListPage> {
    const query: Record<string, string | number | boolean> = {};
    const environments = _joinEnvironments(params.environments);
    if (environments !== undefined) query["filter[environment]"] = environments;
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.metaTotal !== undefined) query["meta[total]"] = params.metaTotal;

    const result = await this._http.GET("/api/v1/categories", {
      params: { query: query as unknown as Record<string, never> },
    });
    if (!result.response.ok) await _throwForResponse(result.response);
    if (result.data === undefined) throw new SmplError("Unexpected empty response from audit");
    const body = result.data;
    const categories: Category[] = (
      (body.data ?? []) as Array<{ id: string; attributes: Record<string, unknown> }>
    ).map((r) => ({
      id: r.id,
      category: String(r.attributes.category ?? r.id),
      createdAt: String(r.attributes.created_at ?? ""),
    }));
    return { categories, pagination: _paginationFromBody(body) };
  }
}

// ---------------------------------------------------------------------------
// forwarders
// ---------------------------------------------------------------------------

/** Surface for `client.audit.forwarders.*` — active-record CRUD for SIEM forwarders. */
class ForwardersClient {
  constructor(private readonly _http: AuditHttp) {}

  /**
   * Return an unsaved {@link Forwarder}. Call {@link Forwarder.save} to persist.
   *
   * @param key                    Caller-supplied unique identifier (the
   *                               forwarder's key). Unique within the
   *                               account; immutable for the lifetime of the
   *                               forwarder. The audit service returns 409 if
   *                               another live forwarder already uses this id.
   * @param fields.name            Display name. Free-form. Defaults to `key`
   *                               when not supplied.
   * @param fields.forwarderType   A {@link ForwarderType} member (e.g.
   *                               `ForwarderType.HTTP`,
   *                               `ForwarderType.DATADOG`).
   * @param fields.configuration   Destination HTTP request configuration —
   *                               an {@link HttpConfiguration} instance.
   *                               Header values carry credentials and are
   *                               returned in plaintext on reads, so a
   *                               get-mutate-put round-trip preserves them
   *                               without re-entering secrets.
   * @param fields.environments    Per-environment overrides keyed by
   *                               environment key (e.g. `"production"`). A
   *                               forwarder delivers in an environment only
   *                               when that environment's entry has
   *                               `enabled: true`. Values may be
   *                               {@link ForwarderEnvironment} instances or
   *                               plain objects (`{ enabled: true }`,
   *                               optionally with a `configuration`
   *                               {@link HttpConfiguration} override). Omit to
   *                               create a forwarder that delivers nowhere
   *                               until enabled per environment.
   * @param fields.description     Optional free-text description.
   * @param fields.forwardSmplkitEvents
   *                               When `true`, this forwarder also receives
   *                               platform change events that smplkit records
   *                               about your own resources (flag,
   *                               configuration, and similar changes),
   *                               delivered through every environment this
   *                               forwarder is enabled in. Independent of the
   *                               per-environment `environments` settings.
   *                               Defaults to `false` — platform change events
   *                               are not forwarded unless you opt in.
   * @param fields.filter          Optional JSON Logic filter; events that
   *                               don't match are recorded as `filtered_out`
   *                               deliveries.
   * @param fields.transform       Optional template applied to the event
   *                               payload before POST. Shape depends on
   *                               `transformType` — for
   *                               {@link TransformType.JSONATA}, a string
   *                               containing a JSONata expression. Any value
   *                               of any type is accepted. `null` sends the
   *                               event as-is.
   * @param fields.transformType   A {@link TransformType} member naming the
   *                               engine that evaluates `transform`. Must be
   *                               provided together with `transform` — neither
   *                               field is meaningful in isolation.
   *
   * @throws Error If exactly one of `transform` / `transformType` is
   *   provided, or if `transformType` is {@link TransformType.JSONATA} and
   *   `transform` is not a string.
   */
  new(
    key: string,
    fields: {
      name?: string;
      forwarderType: ForwarderType;
      configuration: HttpConfiguration;
      environments?: Record<
        string,
        ForwarderEnvironment | { enabled?: boolean; configuration?: HttpConfiguration | null }
      > | null;
      description?: string | null;
      forwardSmplkitEvents?: boolean;
      filter?: Record<string, unknown> | null;
      transform?: unknown;
      transformType?: TransformType | null;
    },
  ): Forwarder {
    _validateTransform(fields.transform ?? null, fields.transformType ?? null);
    return new Forwarder(this, {
      id: key,
      name: fields.name ?? key,
      forwarderType: fields.forwarderType,
      configuration: fields.configuration,
      environments: _normalizeEnvironments(fields.environments),
      description: fields.description,
      forwardSmplkitEvents: fields.forwardSmplkitEvents,
      filter: fields.filter,
      transform: fields.transform,
      transformType: fields.transformType,
    });
  }

  /**
   * List forwarders for the authenticated account.
   *
   * Offset paginated: pass `pageNumber` (1-based) and
   * `pageSize` (default 1000, max 1000). Pass `metaTotal: true` to populate
   * `total` and `totalPages` in the returned `pagination` (costs an extra
   * COUNT query server-side).
   */
  async list(params: ListForwardersParams = {}): Promise<ListForwardersPage> {
    const query: Record<string, string | number | boolean> = {};
    if (params.forwarderType !== undefined) query["filter[forwarder_type]"] = params.forwarderType;
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    if (params.metaTotal !== undefined) query["meta[total]"] = params.metaTotal;

    let data:
      | { data?: unknown[]; meta?: { pagination?: Record<string, unknown> | null } | null }
      | undefined;
    try {
      const result = await this._http.GET("/api/v1/forwarders", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    return {
      forwarders: (
        (data?.data ?? []) as Array<{ id: string; attributes: Record<string, unknown> }>
      ).map((r) => _forwarderFromResource(r, this)),
      pagination: _paginationFromBody(data ?? {}),
    };
  }

  /**
   * Fetch a single forwarder by id; returned instance is bound to this
   * client so `forwarder.save()` and `forwarder.delete()` work.
   */
  async get(forwarderId: string): Promise<Forwarder> {
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.GET("/api/v1/forwarders/{forwarder_id}", {
        params: { path: { forwarder_id: forwarderId } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from audit");
    return _forwarderFromResource(data.data, this);
  }

  /**
   * Delete a forwarder.
   *
   * @param forwarderId - The id (key) of the forwarder to delete.
   */
  async delete(forwarderId: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/forwarders/{forwarder_id}", {
        params: { path: { forwarder_id: forwarderId } },
      });
      if (result.response.status !== 204) await checkError(result.response, result.error);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * @internal POST a new forwarder. Called by `Forwarder.save()` on unsaved
   * instances; not intended for direct use.
   *
   * The audit service requires a caller-supplied `data.id` on create — the
   * forwarder's stable key, propagated from `forwarders.new(key, ...)`.
   */
  async _createForwarder(forwarder: Forwarder): Promise<Forwarder> {
    if (forwarder.id === null) {
      throw new Error("Forwarder.id is required on create (caller-supplied key)");
    }
    const body: GenForwarderCreateRequest = {
      data: {
        id: forwarder.id,
        type: "forwarder",
        attributes: _forwarderAttrs(forwarder),
      },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.POST("/api/v1/forwarders", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from audit");
    return _forwarderFromResource(data.data, this);
  }

  /**
   * @internal Full-replace PUT for an existing forwarder. Called by
   * `Forwarder.save()` on instances with a `createdAt`; not intended for
   * direct use.
   *
   * Header values are returned in plaintext on reads, so a get-mutate-put
   * round-trip preserves them without re-entering secrets.
   */
  async _updateForwarder(forwarder: Forwarder): Promise<Forwarder> {
    if (forwarder.id === null) {
      throw new Error("cannot update a Forwarder with no id");
    }
    const body: GenForwarderRequest = {
      data: { id: forwarder.id, type: "forwarder", attributes: _forwarderAttrs(forwarder) },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.PUT("/api/v1/forwarders/{forwarder_id}", {
        params: { path: { forwarder_id: forwarder.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from audit");
    return _forwarderFromResource(data.data, this);
  }

  /** @internal Called by `Forwarder.delete()`. */
  async _deleteForwarder(id: string): Promise<void> {
    return this.delete(id);
  }
}

/**
 * Validate the `transform` / `transformType` pairing.
 *
 * @throws Error If exactly one of the two is provided, or if `transformType`
 *   is JSONATA and `transform` is not a string.
 * @internal
 */
function _validateTransform(transform: unknown, transformType: TransformType | null): void {
  if ((transform === null) !== (transformType === null)) {
    throw new Error("transform and transformType must be specified together");
  }
  if (transformType === TransformType.JSONATA && typeof transform !== "string") {
    throw new Error("transform must be a string when transformType is JSONATA");
  }
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/** Configuration options for the {@link AuditClient}. */
export interface AuditClientOptions {
  /** API key. When omitted, resolved from `SMPLKIT_API_KEY` or `~/.smplkit`. */
  apiKey?: string;
  /**
   * Deployment environment to scope recording and reads to, sent as
   * `X-Smplkit-Environment`. Optional — forwarder CRUD and discovery are
   * environment-agnostic, and reads accept an explicit `environments`
   * filter. When reached via {@link SmplClient} this is the SDK's configured
   * runtime environment; via a standalone client without it, recording
   * falls back to the server-side default environment.
   */
  environment?: string;
  /**
   * Full audit-service base URL. Usually resolved from `baseDomain`/`scheme`;
   * supplied directly by the top-level clients which have already computed
   * it.
   */
  baseUrl?: string;
  /** Named `~/.smplkit` profile section. */
  profile?: string;
  /** Base domain for API requests (default `"smplkit.com"`). */
  baseDomain?: string;
  /** URL scheme (default `"https"`). */
  scheme?: string;
  /** Enable SDK debug logging. */
  debug?: boolean;
  /**
   * Extra headers attached to every request. An `X-Smplkit-Environment`
   * entry here wins over `environment`.
   */
  extraHeaders?: Record<string, string>;
  /** Request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Custom fetch implementation, primarily for testing. */
  fetch?: typeof fetch;
}

/**
 * The Smpl Audit client.
 *
 * Audit installs no in-process machinery, so it has no runtime/management
 * split: one client exposes the full surface — event recording and reads,
 * distinct-value discovery, and SIEM forwarder CRUD — reachable as
 * `client.audit` ({@link SmplClient}) or constructed directly:
 *
 * @example
 * ```typescript
 * import { AuditClient } from "@smplkit/sdk";
 *
 * const audit = new AuditClient({ environment: "production" });
 * await audit.events.record({
 *   eventType: "invoice.created",
 *   resourceType: "invoice",
 *   resourceId: "inv-1",
 *   flush: true,
 * });
 * for (const ft of (await audit.forwarders.list()).forwarders) {
 *   // ...
 * }
 * ```
 *
 * Namespaces: `events` (record/flush/list/get), `resourceTypes`,
 * `eventTypes`, `categories` (discovery), and `forwarders` (CRUD).
 */
export class AuditClient {
  /** Event recording and read-side queries. */
  readonly events: EventsClient;
  /** Distinct `resource_type` discovery. */
  readonly resourceTypes: ResourceTypesClient;
  /** Distinct `event_type` discovery. */
  readonly eventTypes: EventTypesClient;
  /** Distinct `category` discovery. */
  readonly categories: CategoriesClient;
  /** SIEM forwarder CRUD. */
  readonly forwarders: ForwardersClient;

  /** @internal */
  private readonly _http: AuditHttp;
  /** @internal */
  private readonly _buffer: AuditEventBuffer;

  constructor(options: AuditClientOptions = {}) {
    const { apiKey, baseUrl } = resolveAuditCredentials(options);
    const ms = options.timeoutMs ?? 30_000;

    // Runtime audit ops are environment-scoped: record / list / get /
    // discovery all resolve their environment from the
    // `X-Smplkit-Environment` request header (ADR-055). We stamp it once at
    // the client level from the SDK's configured runtime environment so
    // every generated call carries it. A caller-supplied `extraHeaders`
    // entry of the same name wins (explicit override), so the env header
    // goes in before `extraHeaders`.
    const headers: Record<string, string> = {};
    if (options.environment !== undefined) headers["X-Smplkit-Environment"] = options.environment;
    Object.assign(headers, options.extraHeaders ?? {});

    const customFetch = options.fetch;
    // openapi-fetch wraps the runtime fetch and provides typed
    // GET/POST/PUT/DELETE methods keyed off the OpenAPI paths interface.
    this._http = createClient<paths>({
      baseUrl: baseUrl.replace(/\/+$/, ""),
      headers: {
        ...headers,
        Authorization: `Bearer ${apiKey}`,
        Accept: JSONAPI_CONTENT_TYPE,
        "Content-Type": JSONAPI_CONTENT_TYPE,
      },
      fetch: async (request: Request): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
          return await (customFetch ?? fetch)(new Request(request, { signal: controller.signal }));
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw new SmplkitTimeoutError(`Request timed out after ${ms}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
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

    this.events = new EventsClient(this._http, this._buffer);
    this.resourceTypes = new ResourceTypesClient(this._http);
    this.eventTypes = new EventTypesClient(this._http);
    this.categories = new CategoriesClient(this._http);
    this.forwarders = new ForwardersClient(this._http);
  }

  /** Release HTTP resources and drain the event buffer. */
  async close(): Promise<void> {
    await this._close();
  }

  /** @internal */
  async _close(): Promise<void> {
    await this.events._close();
  }
}

/**
 * Resolve the audit API key and base URL.
 *
 * `baseUrl`/`apiKey` are used directly when both are supplied (the path a
 * top-level client takes after it has already resolved them); otherwise the
 * management config resolver fills in whatever is missing (`~/.smplkit` /
 * env vars / defaults).
 * @internal
 */
function resolveAuditCredentials(options: AuditClientOptions): { apiKey: string; baseUrl: string } {
  if (options.apiKey !== undefined && options.baseUrl !== undefined) {
    return { apiKey: options.apiKey, baseUrl: options.baseUrl };
  }
  const cfg = resolveClientConfig(options);
  return {
    apiKey: options.apiKey ?? cfg.apiKey,
    baseUrl: options.baseUrl ?? serviceUrl(cfg.scheme, "audit", cfg.baseDomain) ?? BASE_URL,
  };
}
