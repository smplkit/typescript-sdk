/**
 * Audit event resource types — surface exposed by `client.audit.events.*`.
 *
 * ADR-047 §2.3.1.
 */

/**
 * A single audit event as returned by the audit service. ADR-047 §2.3.1.
 */
export interface AuditEvent {
  /** Server-assigned UUID for this event. */
  id: string;
  /** Event type slug — e.g. `"user.created"`, `"invoice.paid"`. */
  eventType: string;
  /** Type of resource the event operated on — e.g. `"invoice"`. */
  resourceType: string;
  /** Customer-facing id of the resource the event operated on. */
  resourceId: string;
  /** ISO-8601-with-offset timestamp of when the event actually happened. */
  occurredAt: string;
  /** ISO-8601-with-offset timestamp of when the audit service ingested the event. */
  createdAt: string;
  /**
   * Kind of actor that caused the event — e.g. `"USER"`, `"API_KEY"`,
   * `"SYSTEM"`, or any label the caller chose. `null` when the caller
   * did not supply one; the audit service never backfills.
   */
  actorType: string | null;
  /**
   * Identifier of the actor that caused the event. Free-form — any
   * identifier scheme is accepted. `null` when not supplied.
   */
  actorId: string | null;
  /**
   * Human-readable label for the actor (e.g. an email address or API
   * key name). `null` when not supplied.
   */
  actorLabel: string | null;
  /**
   * Free-form per-event payload defined by the customer. Surfaced on
   * the audit-event resource as a structured JSONB column.
   */
  data: Record<string, unknown>;
  /** Customer-supplied dedupe key. Empty when the customer didn't supply one. */
  idempotencyKey: string;
  /**
   * When `true`, the audit service records the event but skips SIEM
   * forwarder delivery regardless of any matching forwarder filter.
   */
  doNotForward: boolean;
  /**
   * The environment the event was recorded in. Read-only and always
   * present on reads — the audit service resolves it when the event is
   * recorded (from a single-environment credential, or from the runtime
   * SDK's configured environment, which the SDK sends on every recording
   * call). Never set on the recording request body.
   */
  environment: string | null;
}

/**
 * Inputs for `client.audit.events.record(...)`.
 */
export interface CreateEventInput {
  /** Event type slug — e.g. `"invoice.paid"`. */
  eventType: string;
  /** Type of resource the event operated on. */
  resourceType: string;
  /** Customer-facing id of the resource. */
  resourceId: string;
  /** Defaults to server-side `now()` if omitted. */
  occurredAt?: Date | string;
  /**
   * Free-form label for the kind of actor that caused the event (e.g.
   * `"USER"`, `"API_KEY"`, `"SYSTEM"`, or any custom value). The audit
   * service never backfills this from the request credential — supply
   * it explicitly when you want the event attributed.
   */
  actorType?: string;
  /** Free-form identifier of the actor. Any string scheme is accepted. */
  actorId?: string;
  /** Human-readable label for the actor (e.g. email or API key name). */
  actorLabel?: string;
  /**
   * Free-form contextual JSON. To record a resource snapshot, nest it
   * inside `data` — smplkit's internal convention is `data.snapshot`,
   * but the shape is unconstrained.
   */
  data?: Record<string, unknown>;
  /** Optional caller-supplied idempotency key. Server derives one from event content if absent. */
  idempotencyKey?: string;
  /**
   * When `true`, the audit service records the event normally but does
   * NOT POST it through any configured SIEM forwarder. A
   * `skipped_do_not_forward` delivery row is recorded for each enabled
   * forwarder so the skip is visible in the forwarder delivery log.
   */
  doNotForward?: boolean;
}

/**
 * Parameters accepted by `client.audit.events.list(...)`. Cursor
 * paginated per ADR-014; pass {@link pageAfter} from the prior page's
 * `nextCursor` to walk forward.
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
  /** Filter to this actor id. */
  actorId?: string;
  /** Range notation per ADR-014, e.g. `"[2026-01-01T00:00:00Z,*)"`. */
  occurredAtRange?: string;
  /**
   * Restrict results to these environment keys (e.g.
   * `["production", "staging"]`). Sent as a comma-separated
   * `filter[environment]`. Omit (or pass an empty array) to scope to your
   * single accessible environment; send more than one only when your
   * credential can read multiple. The reserved value `"smplkit"` selects
   * the platform change events smplkit records about your own resources
   * (flags, configuration, and so on), which are not tied to a deployment
   * environment.
   */
  environments?: string[];
  /** Items per page (1–1000). Defaults to 1000. */
  pageSize?: number;
  /** Opaque cursor returned by the prior page's `nextCursor`. */
  pageAfter?: string;
}

/**
 * Page of events returned by `client.audit.events.list(...)`.
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
 * A distinct `resource_type` slug seen for the account.
 */
export interface ResourceType {
  /** The resource_type slug, surfaced as the JSON:API resource id. */
  id: string;
  /** ISO-8601 timestamp of the earliest sighting for the account. */
  createdAt: string;
}

/**
 * Parameters accepted by `client.audit.resourceTypes.list(...)`.
 */
export interface ListResourceTypesParams {
  /**
   * Restrict the discovered resource types to those seen in these
   * environment keys (e.g. `["production", "staging"]`). Sent as a
   * comma-separated `filter[environment]`. Omit (or pass an empty array)
   * to scope to your single accessible environment. The reserved value
   * `"smplkit"` selects the platform resource types smplkit records about
   * your own resources.
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
 * Page of resource types returned by
 * `client.audit.resourceTypes.list(...)`.
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
 * A distinct event type slug seen for the account.
 */
export interface EventType {
  /** The event type slug, surfaced as the JSON:API resource id. */
  id: string;
  /**
   * ISO-8601 timestamp of the earliest sighting for the account. When
   * the list call was filtered by `resourceType`, this is the first
   * sighting of that specific (event_type, resource_type) pair.
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
   * Restrict the discovered event types to those seen in these environment
   * keys (e.g. `["production", "staging"]`). Sent as a comma-separated
   * `filter[environment]`. Omit (or pass an empty array) to scope to your
   * single accessible environment. The reserved value `"smplkit"` selects
   * the platform event types smplkit records about your own resources.
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
 * Page of event types returned by `client.audit.eventTypes.list(...)`.
 */
export interface EventTypeListPage {
  /** Event types on this page, alphabetically sorted. */
  eventTypes: EventType[];
  /** Pagination metadata. */
  pagination: Pagination;
}

// ---------------------------------------------------------------------------
// Forwarders (SIEM streaming)
// ---------------------------------------------------------------------------

/**
 * A single name/value HTTP header on a forwarder destination.
 */
export interface HttpHeader {
  /** Header name (e.g. `"Authorization"`, `"DD-API-KEY"`). */
  name: string;
  /**
   * Header value, plaintext on writes. The audit service encrypts values
   * at rest; reads return them as `"<redacted>"`.
   */
  value: string;
}

/**
 * Supported SIEM forwarder destination types.
 *
 * ADR-047 §2.12. Mirrors the audit service's OpenAPI `ForwarderType`
 * enum so callers get autocomplete and the compiler rejects typos at
 * build time. The available types are real-time HTTP destinations
 * sharing one outbound plumbing path. Object-storage archival (S3, GCS,
 * etc.) has different operational shape (batching, IAM, lifecycle
 * policies) and will get its own type if customer demand warrants.
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
 * Mirrors the audit service's OpenAPI `HttpConfigurationMethod` enum so
 * callers get autocomplete and a typed value back from
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
 * Engine used to evaluate {@link Forwarder.transform}. Must be set
 * whenever `transform` is set. Today only `JSONATA` is supported.
 */
export enum TransformType {
  JSONATA = "JSONATA",
}

/**
 * Forwarder destination HTTP request shape.
 *
 * Today every destination type uses HTTP; future transports (FTP, SQS,
 * ...) will join this as members of a discriminated union under
 * {@link Forwarder.configuration}.
 */
export class HttpConfiguration {
  /** HTTP verb used for delivery. Defaults to {@link HttpMethod.POST}. */
  method: HttpMethod;
  /** Destination URL the audit service POSTs each event to. */
  url: string;
  /**
   * Headers attached to every outbound request. Values carry credentials
   * and are encrypted at rest server-side; reads return them redacted.
   */
  headers: HttpHeader[];
  /**
   * Status the destination must return for delivery to count as success
   * — either an exact code (`"200"`, `"204"`) or a status class
   * (`"2xx"`, `"4xx"`). Defaults to `"2xx"`.
   */
  successStatus: string;
  /**
   * Whether to verify the destination's TLS certificate chain. Defaults
   * to `true`; flip to `false` only for short-lived testing against a
   * destination that serves an untrusted certificate. Prefer pinning the
   * CA via {@link caCert} for long-lived self-signed setups.
   */
  tlsVerify: boolean;
  /**
   * Optional PEM-encoded certificate (or bundle) trusted in addition to
   * the system CA store. Ignored when {@link tlsVerify} is `false`.
   * `null` (the default) means "use system CAs only".
   */
  caCert: string | null;

  constructor(
    fields: {
      method?: HttpMethod;
      url?: string;
      headers?: HttpHeader[];
      successStatus?: string;
      tlsVerify?: boolean;
      caCert?: string | null;
    } = {},
  ) {
    this.method = fields.method ?? HttpMethod.POST;
    this.url = fields.url ?? "";
    this.headers = fields.headers ?? [];
    this.successStatus = fields.successStatus ?? "2xx";
    this.tlsVerify = fields.tlsVerify ?? true;
    this.caCert = fields.caCert ?? null;
  }
}

/**
 * Per-environment enablement and optional configuration override for a
 * forwarder.
 *
 * A forwarder delivers events in a given environment only when that
 * environment has an entry in {@link Forwarder.environments} with
 * `enabled: true`. An environment with no entry (or `enabled: false`)
 * receives no deliveries.
 */
export class ForwarderEnvironment {
  /**
   * Whether the forwarder delivers events in this environment. Defaults
   * to `false`.
   */
  enabled: boolean;
  /**
   * Optional per-environment destination configuration that fully
   * replaces the forwarder's base {@link Forwarder.configuration} for
   * this environment. `null` (the default) inherits the base
   * configuration. As with the base configuration, header values are
   * plaintext on writes and returned redacted on reads — re-supply real
   * values before {@link Forwarder.save}.
   */
  configuration: HttpConfiguration | null;

  constructor(fields: { enabled?: boolean; configuration?: HttpConfiguration | null } = {}) {
    this.enabled = fields.enabled ?? false;
    this.configuration = fields.configuration ?? null;
  }
}

/**
 * A SIEM streaming forwarder configured on the customer's account.
 *
 * Active-record style: mutate fields directly and call {@link save} to
 * persist, or {@link delete} to remove. Header values in
 * `configuration.headers` are always returned redacted on reads — the
 * GET path on the audit API replaces every header value with
 * `"<redacted>"`. Re-supply the real values before calling {@link save}
 * (the SDK does not cache them client-side).
 */
export class Forwarder {
  /**
   * Server-assigned UUID for this forwarder. `null` until {@link save}
   * has run for the first time.
   */
  id: string | null;
  /** Display name. Free-form. */
  name: string;
  /** Destination type — see {@link ForwarderType}. */
  forwarderType: ForwarderType;
  /** Destination request configuration. */
  configuration: HttpConfiguration;
  /**
   * Read-only. Always `false` — the base enablement is pinned off.
   * Whether a forwarder actually delivers is decided per environment via
   * {@link environments}; mutating this field has no effect on the
   * server.
   */
  readonly enabled: boolean;
  /**
   * Per-environment overrides keyed by environment key (e.g.
   * `"production"`, `"staging"`). A forwarder delivers in an environment
   * only when `environments[env].enabled` is `true`. Each entry may carry
   * an optional {@link HttpConfiguration} override; omit it to inherit
   * the base {@link configuration}. Every referenced environment must
   * exist and be managed for the account.
   */
  environments: Record<string, ForwarderEnvironment>;
  /** Optional free-text description. */
  description: string | null;
  /**
   * When `true`, this forwarder also receives smplkit's own platform
   * change events — the audit events smplkit records about your own
   * resources (flag, configuration, and similar changes). Each such event
   * is delivered through every environment this forwarder is
   * {@link environments enabled} in, using that environment's resolved
   * configuration. Defaults to `false`: platform change events are not
   * forwarded unless you opt in.
   */
  forwardSmplkitEvents: boolean;
  /**
   * Optional JSON Logic expression evaluated per event. When set, events
   * that don't match are recorded as `filtered_out` deliveries instead
   * of being POSTed to the destination.
   */
  filter: Record<string, unknown> | null;
  /**
   * Optional template applied to each event before delivery. The wire
   * schema widens to arbitrary JSON to leave room for future transform
   * engines carrying structured templates; for
   * {@link TransformType.JSONATA} the value must be a JSONata
   * expression string. `null` delivers the event JSON as-is.
   *
   * {@link transform} and {@link transformType} travel as a pair —
   * both set, or both `null`. The SDK enforces this at save time.
   */
  transform: unknown;
  /**
   * Engine used to evaluate {@link transform}. Required whenever
   * {@link transform} is set, forbidden when it isn't. Today only
   * {@link TransformType.JSONATA} is supported.
   */
  transformType: TransformType | null;
  /**
   * When the audit service first persisted this forwarder. `null` for
   * an unsaved instance.
   */
  createdAt: string | null;
  /** When this forwarder was last mutated. */
  updatedAt: string | null;
  /** Soft-delete timestamp. `null` for live forwarders. */
  deletedAt: string | null;
  /** Monotonic version counter; bumped on every server-side write. */
  version: number | null;

  /** @internal */
  _client: ForwarderModelClient | null;

  constructor(
    client: ForwarderModelClient | null,
    fields: {
      id?: string | null;
      name: string;
      forwarderType: ForwarderType;
      configuration: HttpConfiguration;
      enabled?: boolean;
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
    // `enabled` is server-pinned false; we keep the field so reads
    // round-trip the server value, but enablement is driven by
    // `environments` (see the field docs).
    this.enabled = fields.enabled ?? false;
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
   * Upsert behavior is driven by {@link createdAt}: a forwarder with
   * no `createdAt` is created (POST); otherwise it's full-replace
   * updated (PUT). After the call, every field is refreshed from the
   * server response (including newly-assigned `id`, `createdAt`,
   * `updatedAt`, `version`).
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

  /** Soft-delete this forwarder on the server. */
  async delete(): Promise<void> {
    if (this._client === null || this.id === null) {
      throw new Error("Forwarder was constructed without a client or id; cannot delete");
    }
    await this._client._deleteForwarder(this.id);
  }

  /** @internal Copy every server-authoritative field from `other` onto self. */
  _apply(other: Forwarder): void {
    this.id = other.id;
    this.name = other.name;
    this.forwarderType = other.forwarderType;
    this.configuration = other.configuration;
    // `enabled` is declared readonly to the public API (it's server-pinned
    // false and inert), but the internal refresh still round-trips
    // whatever the server returned.
    (this as { enabled: boolean }).enabled = other.enabled;
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
 * call back into. Implemented by `ForwardersClient` in
 * `src/management/audit.ts`.
 */
export interface ForwarderModelClient {
  _createForwarder(forwarder: Forwarder): Promise<Forwarder>;
  _updateForwarder(forwarder: Forwarder): Promise<Forwarder>;
  _deleteForwarder(id: string): Promise<void>;
}

/**
 * Parameters accepted by `mgmt.audit.forwarders.list(...)`.
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
 * Page of forwarders returned by `mgmt.audit.forwarders.list(...)`.
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
