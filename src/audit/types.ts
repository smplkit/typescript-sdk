/**
 * Audit resource models exposed by the SDK.
 *
 * The wrapper layer's domain types — `Event`, `Forwarder`,
 * `HttpConfiguration`, `HttpHeader`, `ResourceType`, `EventType` —
 * sit on top of the auto-generated `../generated/audit.d.ts` types.
 * The split keeps the public-facing SDK surface stable across
 * regenerations.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A single audit event as returned by the audit service.
 *
 * Field set mirrors the JSON:API resource attributes plus the resource
 * `id`.
 *
 * Actor attribution (`actorType`, `actorId`, `actorLabel`) is
 * customer-supplied and all three are free-form, nullable strings. The
 * audit service stores whatever the caller passed in and never
 * backfills from the request credential — callers that want events
 * attributed to the calling user or API key must populate the fields
 * themselves on `record(...)`.
 */
export interface AuditEvent {
  /** Server-assigned UUID for this event. */
  id: string;
  /** What happened (e.g. `"user.created"`, `"invoice.paid"`). Any non-empty string. */
  eventType: string;
  /** Kind of resource the event is about (e.g. `"invoice"`). Any non-empty string. */
  resourceType: string;
  /** Identifier of the specific resource the event is about. */
  resourceId: string;
  /** When the event actually happened, as reported by the source. */
  occurredAt: string;
  /** When the audit service first ingested this event. */
  createdAt: string;
  /**
   * Kind of actor that caused the event (e.g. `"USER"`, `"API_KEY"`,
   * `"SYSTEM"`, or any label the caller chose). `null` when not supplied.
   */
  actorType: string | null;
  /**
   * Identifier of the actor that caused the event. Free-form — any
   * identifier scheme is accepted. `null` when not supplied.
   */
  actorId: string | null;
  /**
   * Human-readable label for the actor (e.g. an email address or API key
   * name). `null` when not supplied.
   */
  actorLabel: string | null;
  /**
   * Free-form bucket label for the event (e.g. `"auth"`, `"billing"`,
   * `"config-change"`). Stored exactly as supplied; drives the audit log's
   * category filter and the `categories` discovery listing
   * ({@link AuditClient.categories}). `null` when not supplied.
   */
  category: string | null;
  /**
   * Free-form per-event payload defined by the customer. Surfaced on the
   * audit-event resource as a structured JSONB column.
   */
  data: Record<string, unknown>;
  /** Customer-supplied dedupe key. Empty when the customer didn't supply one. */
  idempotencyKey: string;
  /**
   * When `true`, skip this event from SIEM forwarder delivery regardless
   * of any matching forwarder filter.
   */
  doNotForward: boolean;
  /**
   * The environment the event was recorded in. Read-only and always
   * present on reads — the audit service resolves it when the event is
   * recorded (from a single-environment credential, or from the runtime
   * SDK's configured environment, which the SDK sends on the recording
   * request body).
   */
  environment: string | null;
}

/**
 * Inputs for `client.audit.events.record(...)`.
 */
export interface CreateEventInput {
  /** What happened (e.g. `"invoice.created"`). Any non-empty string. */
  eventType: string;
  /**
   * Kind of resource the event is about (e.g. `"invoice"`). Any non-empty
   * string. Customer events must NOT use the `smpl.` prefix — that
   * namespace is reserved for smplkit-emitted events and the server will
   * reject customer attempts with a 403.
   */
  resourceType: string;
  /** Identifier of the affected resource. */
  resourceId: string;
  /** When the event happened in the originating system. Defaults to `now` server-side if omitted. */
  occurredAt?: Date | string;
  /**
   * Free-form label for the kind of actor that caused the event (e.g.
   * `"USER"`, `"API_KEY"`, `"SYSTEM"`, or any custom value). The audit
   * service never backfills this from the request credential — supply it
   * explicitly when you want the event attributed.
   */
  actorType?: string;
  /** Free-form identifier of the actor that caused the event. Any string scheme is accepted. */
  actorId?: string;
  /** Human-readable label for the actor (e.g. an email address or API key name). */
  actorLabel?: string;
  /**
   * Optional free-form bucket label for the event (e.g. `"auth"`,
   * `"billing"`, `"config-change"`). Stored exactly as supplied; powers
   * the audit log's category filter and the `categories` discovery
   * listing ({@link AuditClient.categories}). Omit it to leave the event
   * uncategorized.
   */
  category?: string;
  /**
   * Free-form contextual JSON. To record a resource snapshot, place it
   * inside `data` — smplkit's internal convention nests it at
   * `data.snapshot` for consistency with the platform's own emissions,
   * but the shape is unconstrained:
   *
   * ```typescript
   * record({
   *   eventType: "invoice.created",
   *   resourceType: "invoice",
   *   resourceId: "inv-1",
   *   data: { snapshot: { total_cents: 4900 }, ip: "1.2.3.4" },
   * });
   * ```
   */
  data?: Record<string, unknown>;
  /**
   * Optional caller-supplied idempotency key. If omitted, the server
   * derives one from event content (account_id + event_type +
   * resource_type + resource_id + occurred_at + actor_* + data).
   */
  idempotencyKey?: string;
  /**
   * When `true`, the audit service records the event normally but does
   * NOT POST it through any configured SIEM forwarder. A
   * `skipped_do_not_forward` delivery row is recorded for each enabled
   * forwarder so the skip is visible in the forwarder delivery log.
   */
  doNotForward?: boolean;
  /**
   * When `true`, block until the buffer drains (or `flushTimeoutMs`
   * elapses) before returning.
   */
  flush?: boolean;
  /**
   * Upper bound on the blocking flush, in milliseconds. Ignored when
   * `flush` is false.
   */
  flushTimeoutMs?: number;
}

/**
 * Parameters accepted by `client.audit.events.list(...)`. Cursor
 * paginated; pass {@link pageAfter} from the prior page's `nextCursor` to
 * walk forward.
 */
export interface ListEventsParams {
  /** Filter to this event type slug. */
  eventType?: string;
  /** Filter to this resource_type slug. */
  resourceType?: string;
  /** Filter to this resource id. */
  resourceId?: string;
  /** Filter to this actor type. */
  actorType?: string;
  /** Filter to this actor id. Matched as a literal string against whatever the recording call stored. */
  actorId?: string;
  /** Range notation, e.g. `"[2026-01-01T00:00:00Z,*)"`. */
  occurredAtRange?: string;
  /**
   * Optional free-text filter — returns only events whose `resourceId` or
   * `description` contains it as a case-insensitive substring. Must be scoped
   * (combine with `occurredAtRange`, or with both `resourceType` and
   * `resourceId`) or the request is rejected. Omit to disable text filtering.
   */
  search?: string;
  /**
   * Scope the read to a set of environments: pass a list of environment
   * keys and/or the reserved `"smplkit"` control-plane bucket; the values
   * are sent comma-separated as `filter[environment]`. Omit it (the
   * default) to scope the read to the client's configured environment;
   * with no configured environment the filter is left off entirely.
   */
  environments?: string[];
  /** Items per page (1–1000). Defaults to 1000. */
  pageSize?: number;
  /** Opaque cursor returned by the prior page's `nextCursor`. */
  pageAfter?: string;
}

/**
 * A single page from `client.audit.events.list(...)`.
 *
 * `events` is the page's events; `nextCursor` is the opaque token for the
 * next page (or `null` when this is the last page).
 */
export interface ListEventsPage {
  /** Events on this page, newest first. */
  events: AuditEvent[];
  /** Opaque cursor for the next page, or `null` if this is the last page. */
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Resource types (distinct resource_type slugs seen in the account)
// ---------------------------------------------------------------------------

/**
 * A distinct resource_type slug seen for the account.
 *
 * The `id` and `resourceType` fields are the same value — JSON:API
 * surfaces the customer-facing key as the resource id. The duplication
 * keeps SDK consumers from having to dig into the id field when filtering
 * UI controls; pick whichever name reads better in context.
 */
export interface ResourceType {
  /** The resource-type slug, surfaced as the JSON:API resource id. */
  id: string;
  /** Same value as {@link id}; provided for readability. */
  resourceType: string;
  /** Earliest sighting of this resource_type for the account. */
  createdAt: string;
}

/**
 * Parameters accepted by `client.audit.resourceTypes.list(...)`.
 */
export interface ListResourceTypesParams {
  /**
   * Scope the listing to a set of environments: pass a list of environment
   * keys and/or the reserved `"smplkit"` control-plane bucket; the values
   * are sent comma-separated as `filter[environment]`. Omit it (the
   * default) to scope the listing to the client's configured environment;
   * with no configured environment the filter is left off entirely.
   */
  environments?: string[];
  /** 1-based page number to return. Defaults to 1. */
  pageNumber?: number;
  /** Items per page (1–1000). Defaults to 1000. */
  pageSize?: number;
  /** Include `total` and `totalPages` in {@link Pagination}. Defaults to false. */
  metaTotal?: boolean;
}

/**
 * A single page from `client.audit.resourceTypes.list(...)`.
 *
 * `resourceTypes` is the page; `pagination` is the response's
 * `meta.pagination` block (`page`, `size`, and — only when the caller
 * passed `metaTotal: true` — `total` and `totalPages`).
 */
export interface ListResourceTypesPage {
  /** Resource types on this page, alphabetically sorted. */
  resourceTypes: ResourceType[];
  /** Pagination metadata. */
  pagination: Pagination;
}

// ---------------------------------------------------------------------------
// Event types (distinct event_type slugs seen in the account)
// ---------------------------------------------------------------------------

/**
 * A distinct event_type slug seen for the account.
 *
 * Same shape as {@link ResourceType} — `id` and `eventType` are the same
 * value. When the parent list call filtered by `resourceType`,
 * `createdAt` is the first sighting of that specific (event_type,
 * resource_type) triple, not the event_type overall.
 */
export interface EventType {
  /** The event_type slug, surfaced as the JSON:API resource id. */
  id: string;
  /** Same value as {@link id}; provided for readability. */
  eventType: string;
  /**
   * Earliest sighting of this event_type (or event_type/resource_type pair
   * when the list call was filtered) for the account.
   */
  createdAt: string;
}

/**
 * Parameters accepted by `client.audit.eventTypes.list(...)`.
 */
export interface ListEventTypesParams {
  /** When set, returns only the event types seen with this resource_type. */
  filterResourceType?: string;
  /**
   * Scope the listing to a set of environments: pass a list of environment
   * keys and/or the reserved `"smplkit"` control-plane bucket; the values
   * are sent comma-separated as `filter[environment]`. Omit it (the
   * default) to scope the listing to the client's configured environment;
   * with no configured environment the filter is left off entirely.
   */
  environments?: string[];
  /** 1-based page number to return. Defaults to 1. */
  pageNumber?: number;
  /** Items per page (1–1000). Defaults to 1000. */
  pageSize?: number;
  /** Include `total` and `totalPages` in {@link Pagination}. Defaults to false. */
  metaTotal?: boolean;
}

/**
 * A single page from `client.audit.eventTypes.list(...)`.
 *
 * `eventTypes` is the page; `pagination` is the response's
 * `meta.pagination` block (`page`, `size`, and — only when the caller
 * passed `metaTotal: true` — `total` and `totalPages`).
 */
export interface EventTypeListPage {
  /** Event types on this page, alphabetically sorted. */
  eventTypes: EventType[];
  /** Pagination metadata. */
  pagination: Pagination;
}

// ---------------------------------------------------------------------------
// Categories (distinct category values seen in the account)
// ---------------------------------------------------------------------------

/**
 * A distinct `category` value seen for the account.
 *
 * Same shape as {@link ResourceType} and {@link EventType} — `id` and
 * `category` are the same value, surfaced as the JSON:API resource id. The
 * duplication keeps SDK consumers from having to dig into the `id` field
 * when populating filter UI controls; pick whichever name reads better in
 * context.
 */
export interface Category {
  /** The category value, surfaced as the JSON:API resource id. */
  id: string;
  /** Same value as {@link id}; provided for readability. */
  category: string;
  /** Earliest sighting of this category for the account. */
  createdAt: string;
}

/**
 * Parameters accepted by `client.audit.categories.list(...)`.
 */
export interface ListCategoriesParams {
  /**
   * Scope the listing to a set of environments: pass a list of environment
   * keys and/or the reserved `"smplkit"` control-plane bucket; the values
   * are sent comma-separated as `filter[environment]`. Omit it (the
   * default) to scope the listing to the client's configured environment;
   * with no configured environment the filter is left off entirely.
   */
  environments?: string[];
  /** 1-based page number to return. Defaults to 1. */
  pageNumber?: number;
  /** Items per page (1–1000). Defaults to 1000. */
  pageSize?: number;
  /** Include `total` and `totalPages` in {@link Pagination}. Defaults to false. */
  metaTotal?: boolean;
}

/**
 * A single page from `client.audit.categories.list(...)`.
 *
 * `categories` is the page; `pagination` is the response's
 * `meta.pagination` block (`page`, `size`, and — only when the caller
 * passed `metaTotal: true` — `total` and `totalPages`).
 */
export interface CategoryListPage {
  /** Categories on this page, alphabetically sorted. */
  categories: Category[];
  /** Pagination metadata. */
  pagination: Pagination;
}

// ---------------------------------------------------------------------------
// Forwarders (SIEM streaming)
// ---------------------------------------------------------------------------

/**
 * Supported SIEM forwarder destination types.
 *
 * The audit service declares `forwarder_type` as a string with an enum
 * constraint; this TypeScript-side enum mirrors that constraint so customers
 * get autocomplete and type-checked values instead of stringly-typed inputs.
 *
 * The available types are real-time HTTP destinations sharing one outbound
 * delivery path. Object-storage archival (S3, GCS, etc.) has a different
 * operational shape (batching, IAM, lifecycle policies) and may get its own
 * type if customer demand warrants.
 */
export enum ForwarderType {
  DATADOG = "datadog",
  ELASTIC = "elastic",
  HONEYCOMB = "honeycomb",
  HTTP = "http",
  NEW_RELIC = "new_relic",
  SPLUNK_HEC = "splunk_hec",
  SUMO_LOGIC = "sumo_logic",
}

/**
 * HTTP verb used by a forwarder's outbound delivery.
 *
 * Mirrors the audit spec's `HttpConfigurationMethod` enum so customers
 * get autocomplete and a typed value back from
 * `forwarder.configuration.method`.
 */
export enum HttpMethod {
  DELETE = "DELETE",
  GET = "GET",
  PATCH = "PATCH",
  POST = "POST",
  PUT = "PUT",
}

/**
 * Engine used to evaluate a forwarder's `transform`.
 *
 * Today only {@link JSONATA} is supported.
 */
export enum TransformType {
  JSONATA = "JSONATA",
}

/**
 * Forwarder destination HTTP request shape.
 */
export class HttpConfiguration {
  /** HTTP verb used for delivery. Defaults to {@link HttpMethod.POST}. */
  method: HttpMethod;
  /** Destination URL the audit service POSTs each event to. */
  url: string;
  /**
   * Headers attached to every outbound request, as a name→value object (e.g.
   * `{ "DD-API-KEY": "s3cr3t" }`). Values often carry credentials and are
   * returned in plaintext on reads, so a get-mutate-put round-trip preserves
   * them without re-entering secrets. Use {@link setHeader} / {@link getHeader}
   * to read and write individual headers.
   */
  headers: Record<string, string>;
  /**
   * Status the destination must return for delivery to count as success —
   * either an exact code (`"200"`, `"204"`) or a class (`"2xx"`, `"4xx"`).
   * Defaults to `"2xx"`.
   */
  successStatus: string;
  /**
   * Whether to verify the destination's TLS certificate chain. Defaults to
   * `true`; flip to `false` only for short-lived testing against a
   * destination that serves an untrusted certificate. Prefer pinning the
   * issuing CA via {@link caCert} for long-lived self-signed setups.
   */
  tlsVerify: boolean;
  /**
   * Optional PEM-encoded certificate (or bundle) trusted in addition to
   * the system CA store. Ignored when {@link tlsVerify} is `false`. `null`
   * (the default) means "use system CAs only".
   */
  caCert: string | null;

  constructor(
    fields: {
      method?: HttpMethod;
      url?: string;
      headers?: Record<string, string>;
      successStatus?: string;
      tlsVerify?: boolean;
      caCert?: string | null;
    } = {},
  ) {
    this.method = fields.method ?? HttpMethod.POST;
    this.url = fields.url ?? "";
    this.headers = { ...(fields.headers ?? {}) };
    this.successStatus = fields.successStatus ?? "2xx";
    this.tlsVerify = fields.tlsVerify ?? true;
    this.caCert = fields.caCert ?? null;
  }

  /** Set (or replace) a single request header by name. */
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  /** The value of header `name`, or `undefined` if it is not set. */
  getHeader(name: string): string | undefined {
    return this.headers[name];
  }
}

/**
 * One environment's **sparse override** for a forwarder (ADR-056).
 *
 * A forwarder's {@link Forwarder.environments} map holds one of these per
 * environment. Only the leaves you set are sent on save; everything you leave
 * unset is inherited from the forwarder's base definition, and the server
 * resolves base ⊕ overrides when an event is delivered. The base definition
 * delivers nowhere, so a forwarder delivers in an environment only when that
 * environment's override sets `enabled` to `true`.
 *
 * Set overrides through {@link Forwarder.environment}, e.g.
 * `forwarder.environment("production").url = "https://prod.siem.example.com/in"`.
 *
 * **Reading a leaf returns this environment's override, or `null` when it does
 * not override that leaf** — the SDK does not merge in the base value
 * (forwarders resolve server-side). To see a base value, read the forwarder's
 * base definition (`forwarder.configuration`).
 */
export class ForwarderEnvironment {
  /**
   * Whether the forwarder delivers events in this environment. Defaults to
   * `false`.
   */
  enabled: boolean;
  /**
   * Per-environment override of the base {@link HttpConfiguration.url}. `null`
   * (the default) inherits the base {@link Forwarder.configuration} url.
   */
  url: string | null;
  /**
   * Per-environment override of the base {@link HttpConfiguration.method}.
   * `null` (the default) inherits the base {@link Forwarder.configuration} method.
   */
  method: HttpMethod | null;
  /**
   * Per-environment override of the base
   * {@link HttpConfiguration.successStatus}. `null` (the default) inherits the
   * base {@link Forwarder.configuration} value.
   */
  successStatus: string | null;
  /**
   * Per-environment override of the base {@link HttpConfiguration.tlsVerify}.
   * `null` (the default) inherits the base {@link Forwarder.configuration} value.
   */
  tlsVerify: boolean | null;
  /**
   * Per-environment override of the base {@link HttpConfiguration.caCert}.
   * `null` (the default) inherits the base {@link Forwarder.configuration} value.
   */
  caCert: string | null;
  /**
   * Per-environment header overrides, as a name→value object. Each entry
   * overrides (or adds) that one header by name on top of the base headers,
   * leaving the rest inherited. Use {@link setHeader} / {@link getHeader}.
   */
  headers: Record<string, string>;

  constructor(
    fields: {
      enabled?: boolean;
      url?: string | null;
      method?: HttpMethod | null;
      successStatus?: string | null;
      tlsVerify?: boolean | null;
      caCert?: string | null;
      headers?: Record<string, string>;
    } = {},
  ) {
    this.enabled = fields.enabled ?? false;
    this.url = fields.url ?? null;
    this.method = fields.method ?? null;
    this.successStatus = fields.successStatus ?? null;
    this.tlsVerify = fields.tlsVerify ?? null;
    this.caCert = fields.caCert ?? null;
    this.headers = { ...(fields.headers ?? {}) };
  }

  /** Override (or add) a single header by name in this environment. */
  setHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  /**
   * This environment's override for header `name`, or `undefined` when it does
   * not override that header.
   */
  getHeader(name: string): string | undefined {
    return this.headers[name];
  }
}

/**
 * A SIEM streaming forwarder configured on the customer's account.
 *
 * Active-record style: mutate fields directly and call {@link save} to
 * persist, or {@link delete} to remove. Header values in
 * `configuration.headers` are returned in plaintext on reads, so fetching a
 * forwarder, mutating it, and calling {@link save} preserves its header
 * values without re-entering secrets.
 */
export class Forwarder {
  /**
   * Caller-supplied unique identifier (key) for this forwarder. Unique
   * within an account and immutable for the lifetime of the forwarder.
   * `null` only while the instance represents an unsaved forwarder
   * constructed without an id (which `save()` would then reject).
   */
  id: string | null;
  /** Display name. Free-form. */
  name: string;
  /** Destination type — see {@link ForwarderType}. */
  forwarderType: ForwarderType;
  /** Destination request configuration. */
  configuration: HttpConfiguration;
  /**
   * Per-environment sparse overrides keyed by environment key (e.g.
   * `"production"`, `"staging"`). A forwarder delivers in an environment only
   * when `environments[env].enabled` is `true`. Each entry overrides only the
   * leaves it sets; omitted leaves inherit the base {@link configuration} (the
   * server resolves base ⊕ overrides on delivery). Reach one via
   * {@link environment}. Every referenced environment must exist and be managed
   * for the account.
   */
  environments: Record<string, ForwarderEnvironment>;
  /** Optional free-text description. */
  description: string | null;
  /**
   * When `true`, this forwarder also receives platform change events that
   * smplkit records about your own resources (flag, configuration, and
   * similar changes). Each such event is delivered through every
   * environment this forwarder is enabled in, using that environment's
   * resolved configuration. Independent of the per-environment
   * {@link environments} settings, since platform change events are not
   * tied to a deployment environment. Defaults to `false` — platform
   * change events are not forwarded unless you opt in.
   */
  forwardSmplkitEvents: boolean;
  /**
   * Optional JSON Logic expression evaluated per event. When set, events
   * that don't match are recorded as `filtered_out` deliveries instead of
   * being POSTed to the destination.
   */
  filter: Record<string, unknown> | null;
  /**
   * Optional template applied to each event before delivery. Shape depends
   * on {@link transformType}; for {@link TransformType.JSONATA}, a string
   * containing a JSONata expression. `null` delivers the event JSON as-is.
   */
  transform: unknown;
  /**
   * Engine used to evaluate {@link transform}. Must be set whenever
   * {@link transform} is set.
   */
  transformType: TransformType | null;
  /**
   * When the audit service first persisted this forwarder. `null` for an
   * unsaved instance.
   */
  createdAt: string | null;
  /** When this forwarder was last mutated. */
  updatedAt: string | null;
  /** Deletion timestamp; `null` for live forwarders. */
  deletedAt: string | null;
  /** Monotonic version counter; bumped on every server-side write. */
  version: number | null;

  /** @internal */
  _client: ForwarderModelClient | null;

  /**
   * Whether the forwarder delivers in at least one environment. Read-only
   * roll-up derived from {@link environments} — `true` iff any environment
   * override has `enabled` set. Enable per environment via
   * `forwarder.environment(env).enabled = true`; the forwarder has no
   * server-side top-level `enabled` field.
   */
  get enabled(): boolean {
    return Object.values(this.environments).some((env) => env.enabled);
  }

  /** @internal */
  constructor(
    client: ForwarderModelClient | null,
    fields: {
      id?: string | null;
      name: string;
      forwarderType: ForwarderType;
      configuration: HttpConfiguration;
      environments?: Record<string, ForwarderEnvironment> | null;
      description?: string | null;
      forwardSmplkitEvents?: boolean;
      filter?: Record<string, unknown> | null;
      transform?: unknown;
      transformType?: TransformType | null;
      createdAt?: string | null;
      updatedAt?: string | null;
      deletedAt?: string | null;
      version?: number | null;
    },
  ) {
    this._client = client;
    this.id = fields.id ?? null;
    this.name = fields.name;
    this.forwarderType = fields.forwarderType;
    this.configuration = fields.configuration;
    this.environments = fields.environments ?? {};
    this.description = fields.description ?? null;
    this.forwardSmplkitEvents = fields.forwardSmplkitEvents ?? false;
    this.filter = fields.filter ?? null;
    this.transform = fields.transform ?? null;
    this.transformType = fields.transformType ?? null;
    this.createdAt = fields.createdAt ?? null;
    this.updatedAt = fields.updatedAt ?? null;
    this.deletedAt = fields.deletedAt ?? null;
    this.version = fields.version ?? null;
  }

  /**
   * Create or update this forwarder on the server.
   *
   * Upsert behavior is driven by {@link createdAt}: a forwarder with no
   * `createdAt` is created (POST); otherwise it's full-replace updated
   * (PUT). After the call, every field is refreshed from the server
   * response (including newly-assigned `id`, `createdAt`, `updatedAt`,
   * `version`).
   */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Forwarder was constructed without a client; cannot save");
    }
    const other =
      this.createdAt === null
        ? await this._client._createForwarder(this)
        : await this._client._updateForwarder(this);
    this._apply(other);
  }

  /** Delete this forwarder on the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("Forwarder was constructed without a client or id; cannot delete");
    }
    await this._client._deleteForwarder(this.id);
  }

  /**
   * The per-environment override for `environment` — the single place to read
   * or set what this forwarder overrides there (ADR-056).
   *
   * Returns the {@link ForwarderEnvironment} for `environment`, creating an
   * empty one (and inserting it into {@link environments}) on first access, so
   * you can set overrides directly:
   *
   * ```typescript
   * forwarder.environment("production").enabled = true;
   * forwarder.environment("production").url = "https://prod.siem.example.com/in";
   * forwarder.environment("production").setHeader("DD-API-KEY", "prod-secret");
   * ```
   *
   * Only the leaves you set are sent on save; everything else inherits the base
   * definition (the server resolves base ⊕ overrides on delivery). Set base
   * fields by direct assignment on the forwarder itself (e.g.
   * `forwarder.configuration`).
   */
  environment(environment: string): ForwarderEnvironment {
    let env = this.environments[environment];
    if (env === undefined) {
      env = new ForwarderEnvironment();
      this.environments[environment] = env;
    }
    return env;
  }

  /** @internal Copy every server-authoritative field from `other` onto self. */
  _apply(other: Forwarder): void {
    this.id = other.id;
    this.name = other.name;
    this.forwarderType = other.forwarderType;
    this.configuration = other.configuration;
    this.environments = other.environments;
    this.description = other.description;
    this.forwardSmplkitEvents = other.forwardSmplkitEvents;
    this.filter = other.filter;
    this.transform = other.transform;
    this.transformType = other.transformType;
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
    this.deletedAt = other.deletedAt;
    this.version = other.version;
  }
}

/**
 * @internal Minimal interface that `Forwarder.save()` / `.delete()`
 * call back into. Implemented by `ForwardersClient` in `./client.ts`.
 */
export interface ForwarderModelClient {
  _createForwarder(forwarder: Forwarder): Promise<Forwarder>;
  _updateForwarder(forwarder: Forwarder): Promise<Forwarder>;
  _deleteForwarder(id: string): Promise<void>;
}

/**
 * Parameters accepted by `client.audit.forwarders.list(...)`.
 */
export interface ListForwardersParams {
  /** Filter to a single forwarder type. */
  forwarderType?: ForwarderType;
  /** 1-based page number to return. Defaults to 1. */
  pageNumber?: number;
  /** Items per page (1–1000). Defaults to 1000. */
  pageSize?: number;
  /** Include `total` and `totalPages` in {@link Pagination}. Defaults to false. */
  metaTotal?: boolean;
}

/**
 * A single page from `client.audit.forwarders.list(...)`.
 *
 * `forwarders` is the page's forwarders; `pagination` is the response's
 * `meta.pagination` block (`page`, `size`, and — only when the caller
 * passed `metaTotal: true` — `total` and `totalPages`).
 */
export interface ListForwardersPage {
  /** Forwarders on this page, in server-defined order. */
  forwarders: Forwarder[];
  /** Pagination metadata (`page`, `size`, optional `total`/`totalPages`). */
  pagination: Pagination;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Offset-pagination block echoed in `meta.pagination` on every list
 * response (other than the documented cursor-paged endpoints — audit
 * events and forwarder deliveries).
 *
 * `page` and `size` always reflect the parameters that served the
 * response (the defaults when the caller omitted them). `total` and
 * `totalPages` are only populated when the caller passed
 * `metaTotal: true`, since computing them costs an extra `COUNT` query.
 */
export interface Pagination {
  /** 1-based page number returned. */
  page: number;
  /** Number of items per page. */
  size: number;
  /** Total matching items across all pages. Only set when `metaTotal=true`. */
  total?: number;
  /** Total pages at the requested page size. Only set when `metaTotal=true`. */
  totalPages?: number;
}
