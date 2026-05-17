/**
 * Smpl Audit management surface — `mgmt.audit.*`.
 *
 * Counterpart to the runtime `AuditClient`. The runtime client owns event
 * recording and read-side queries; this client owns SIEM forwarder CRUD:
 *
 *   mgmt.audit.forwarders.{create,get,list,update,delete}
 *
 * New audit-management capabilities should be added here, not in
 * `src/audit/client.ts`.
 */

import createClient from "openapi-fetch";
import type { components, paths } from "../generated/audit.d.ts";
import { SmplError, SmplkitConnectionError, throwForStatus } from "../errors.js";
import type {
  CreateForwarderInput,
  Forwarder,
  HttpConfiguration,
  HttpHeader,
  ListForwardersPage,
  ListForwardersParams,
  Pagination,
  TransformType,
  UpdateForwarderInput,
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
  return {
    method: String(r.method ?? "POST"),
    url: String(r.url ?? ""),
    headers,
    successStatus: String(r.success_status ?? "2xx"),
  };
}

function _forwarderAttributes(input: CreateForwarderInput | UpdateForwarderInput): GenForwarder {
  const attrs: GenForwarder = {
    name: input.name,
    forwarder_type: input.forwarderType,
    enabled: input.enabled ?? true,
    configuration: _configurationToWire(input.configuration),
  };
  if (input.description !== undefined) attrs.description = input.description;
  if (input.filter !== undefined) {
    attrs.filter = input.filter as { [key: string]: unknown };
  }
  if (input.transformType !== undefined) attrs.transform_type = input.transformType;
  if (input.transform !== undefined) attrs.transform = input.transform;
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
    description: (a.description as string | null) ?? null,
    forwarderType: a.forwarder_type as Forwarder["forwarderType"],
    enabled: Boolean(a.enabled ?? true),
    filter: (a.filter as Record<string, unknown> | null) ?? null,
    transformType: (a.transform_type as TransformType | null) ?? null,
    transform: a.transform ?? null,
    configuration: _configurationFromWire(a.configuration as Record<string, unknown> | undefined),
    createdAt: (a.created_at as string | null) ?? null,
    updatedAt: (a.updated_at as string | null) ?? null,
    deletedAt: (a.deleted_at as string | null) ?? null,
    version: (a.version as number | null) ?? null,
  };
}

/** `mgmt.audit.forwarders.*` — CRUD for SIEM forwarders. */
export class ForwardersClient {
  /** @internal */
  constructor(private readonly _http: AuditHttp) {}

  async create(input: CreateForwarderInput): Promise<Forwarder> {
    const body: GenForwarderResponse = {
      data: { id: "", type: "forwarder", attributes: _forwarderAttributes(input) },
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
    return _forwarderFromResource(data.data);
  }

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
      ).map(_forwarderFromResource),
      pagination: _paginationFromBody(data ?? {}),
    };
  }

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
    return _forwarderFromResource(data.data);
  }

  /**
   * Full-replace update. PUT semantics — every field is overwritten.
   *
   * Header values must be re-supplied as plaintext; the GET path
   * returns them in plaintext for exactly this round-trip.
   */
  async update(forwarderId: string, input: UpdateForwarderInput): Promise<Forwarder> {
    const body: GenForwarderResponse = {
      data: { id: forwarderId, type: "forwarder", attributes: _forwarderAttributes(input) },
    };
    let data: { data: { id: string; attributes: Record<string, unknown> } } | undefined;
    try {
      const result = await this._http.PUT("/api/v1/forwarders/{forwarder_id}", {
        params: { path: { forwarder_id: forwarderId } },
        body,
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data as typeof data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplError("Unexpected empty response from audit");
    return _forwarderFromResource(data.data);
  }

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
