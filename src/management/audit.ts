/**
 * Smpl Audit management surface — `mgmt.audit.*`.
 *
 * Counterpart to the runtime `AuditClient`. The runtime client owns
 * event recording and read-side queries; this client owns SIEM
 * forwarder CRUD via the active-record {@link Forwarder} model:
 *
 *   mgmt.audit.forwarders.{new,get,list,delete}
 *   Forwarder.{save,delete}
 *
 * New audit-management capabilities should be added here, not in
 * `src/audit/client.ts`.
 */

import createClient from "openapi-fetch";
import type { components, paths } from "../generated/audit.d.ts";
import { SmplError, SmplkitConnectionError, throwForStatus } from "../errors.js";
import {
  Forwarder,
  ForwarderType,
  HttpConfiguration,
  HttpMethod,
  TransformType,
  type ForwarderModelClient,
  type HttpHeader,
  type ListForwardersPage,
  type ListForwardersParams,
  type Pagination,
} from "../audit/types.js";

type AuditHttp = ReturnType<typeof createClient<paths>>;
type GenForwarder = components["schemas"]["Forwarder"];
type GenHttpConfiguration = components["schemas"]["HttpConfiguration"];
type GenForwarderResponse = components["schemas"]["ForwarderResponse"];

/** @internal */
async function checkError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
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

function _configurationToWire(config: HttpConfiguration): GenHttpConfiguration {
  return {
    method: config.method as GenHttpConfiguration["method"],
    url: config.url,
    headers: config.headers.map((h: HttpHeader) => ({ name: h.name, value: h.value })),
    success_status: config.successStatus,
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
  });
}

function _forwarderAttrs(forwarder: Forwarder): GenForwarder {
  const attrs: GenForwarder = {
    name: forwarder.name,
    forwarder_type: forwarder.forwarderType,
    enabled: forwarder.enabled,
    configuration: _configurationToWire(forwarder.configuration),
  };
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
  client: ForwarderModelClient,
): Forwarder {
  const a = resource.attributes;
  return new Forwarder(client, {
    id: resource.id,
    name: String(a.name ?? ""),
    description: (a.description as string | null) ?? null,
    forwarderType: a.forwarder_type as ForwarderType,
    enabled: Boolean(a.enabled ?? true),
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

/**
 * `mgmt.audit.forwarders.*` — active-record CRUD for SIEM forwarders.
 */
export class ForwardersClient implements ForwarderModelClient {
  /** @internal */
  constructor(private readonly _http: AuditHttp) {}

  /**
   * Construct an unsaved {@link Forwarder}. Call {@link Forwarder.save}
   * to persist.
   *
   * @param fields.name            Display name. Free-form.
   * @param fields.forwarderType   Destination type — see {@link ForwarderType}.
   * @param fields.configuration   Destination HTTP request configuration.
   *                               Headers carry credentials and are
   *                               encrypted at rest server-side; reads
   *                               return them redacted.
   * @param fields.enabled         Whether the forwarder is active. Defaults true.
   * @param fields.description     Optional free-text description.
   * @param fields.filter          Optional JSON Logic filter; events that
   *                               don't match are recorded as
   *                               `filtered_out` deliveries.
   * @param fields.transformType   Engine used to evaluate `transform`.
   *                               Today only {@link TransformType.JSONATA}
   *                               is supported. Must be supplied together
   *                               with `transform` (both or neither).
   * @param fields.transform       Optional template applied to each
   *                               event before delivery. The value is
   *                               arbitrary JSON — for JSONATA, it
   *                               must be a string containing a JSONata
   *                               expression. Must be supplied together
   *                               with `transformType` (both or neither).
   */
  new(fields: {
    name: string;
    forwarderType: ForwarderType;
    configuration: HttpConfiguration;
    enabled?: boolean;
    description?: string | null;
    filter?: Record<string, unknown> | null;
    transformType?: TransformType | null;
    transform?: unknown;
  }): Forwarder {
    return new Forwarder(this, {
      name: fields.name,
      forwarderType: fields.forwarderType,
      configuration: fields.configuration,
      enabled: fields.enabled,
      description: fields.description,
      filter: fields.filter,
      transformType: fields.transformType,
      transform: fields.transform,
    });
  }

  /**
   * List forwarders for the authenticated account.
   *
   * Offset paginated per ADR-014: pass {@link ListForwardersParams.pageNumber}
   * (1-based) and {@link ListForwardersParams.pageSize} (default 1000,
   * max 1000). Pass `metaTotal=true` to populate `total` and `totalPages`
   * in the returned `pagination` (costs an extra `COUNT` query
   * server-side).
   */
  async list(params: ListForwardersParams = {}): Promise<ListForwardersPage> {
    const query: Record<string, string | number | boolean> = {};
    if (params.forwarderType !== undefined) query["filter[forwarder_type]"] = params.forwarderType;
    if (params.enabled !== undefined) query["filter[enabled]"] = params.enabled;
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
      if (!result.response.ok) await checkError(result.response);
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
   * Fetch a single forwarder by id. The returned instance is bound to
   * this client so {@link Forwarder.save} and {@link Forwarder.delete}
   * round-trip back here.
   */
  async get(forwarderId: string): Promise<Forwarder> {
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.GET("/api/v1/forwarders/{forwarder_id}", {
        params: { path: { forwarder_id: forwarderId } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from audit");
    return _forwarderFromResource(data.data, this);
  }

  /** Soft-delete a forwarder by id. */
  async delete(forwarderId: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/forwarders/{forwarder_id}", {
        params: { path: { forwarder_id: forwarderId } },
      });
      if (result.response.status !== 204) await checkError(result.response);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * @internal Called by `Forwarder.save()` on unsaved instances.
   */
  async _createForwarder(forwarder: Forwarder): Promise<Forwarder> {
    const body: GenForwarderResponse = {
      data: { id: "", type: "forwarder", attributes: _forwarderAttrs(forwarder) },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.POST("/api/v1/forwarders", { body });
      if (!result.response.ok) await checkError(result.response);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from audit");
    return _forwarderFromResource(data.data, this);
  }

  /**
   * @internal Full-replace PUT. Called by `Forwarder.save()` on
   * instances that already have a `createdAt`. Header values must be
   * re-supplied as plaintext; the GET path redacts them, so a PUT body
   * containing `"<redacted>"` would persist that literal.
   */
  async _updateForwarder(forwarder: Forwarder): Promise<Forwarder> {
    if (forwarder.id === null) {
      throw new Error("cannot update a Forwarder with no id");
    }
    const body: GenForwarderResponse = {
      data: { id: forwarder.id, type: "forwarder", attributes: _forwarderAttrs(forwarder) },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.PUT("/api/v1/forwarders/{forwarder_id}", {
        params: { path: { forwarder_id: forwarder.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response);
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

// ---------------------------------------------------------------------------
// Top-level management audit clients
// ---------------------------------------------------------------------------

/** `mgmt.audit.*` — management surface for the audit service. */
export class ManagementAuditClient {
  /** SIEM forwarder CRUD. */
  readonly forwarders: ForwardersClient;

  /** @internal */
  constructor(http: AuditHttp) {
    this.forwarders = new ForwardersClient(http);
  }
}
