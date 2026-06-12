/**
 * The Smpl Platform client — cross-cutting CRUD on `client.platform`.
 *
 * `PlatformClient` groups the account-wide configuration resources that aren't
 * owned by a single product, mirroring the product UI's Platform area:
 *
 * - `platform.environments` — environment CRUD
 * - `platform.services` — service CRUD
 * - `platform.contexts` — evaluation-context registration + read/delete
 * - `platform.contextTypes` — context-type CRUD
 *
 * All four are pure CRUD — no `install()` gate. Every sub-client speaks to the
 * app service, so the client needs exactly one app transport (plus the
 * context-registration buffer that `contexts` drains).
 *
 * The client supports two construction shapes:
 *
 * - **Wired** into {@link SmplClient} — borrows the parent's app transport and
 *   an externally-supplied context buffer. This is the common path;
 *   `client.flags` borrows `client.platform.contexts` as its
 *   evaluation-context registration seam.
 * - **Standalone** — `new PlatformClient({ apiKey, baseUrl, ... })` builds and
 *   owns its own app transport and buffer. `close()` tears down only the owned
 *   transport.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import {
  SmplkitError,
  SmplkitNotFoundError,
  SmplkitValidationError,
  SmplkitConnectionError,
  throwForStatus,
} from "../errors.js";
import { resolveClientConfig, serviceUrl } from "../config.js";
import { Color, EnvironmentClassification, coerceColor } from "./types.js";
import { Environment, ContextType, Service } from "./models.js";
import { Context } from "../flags/types.js";
import { ContextRegistrationBuffer, CONTEXT_BATCH_FLUSH_SIZE } from "../buffer.js";

type AppHttp = ReturnType<typeof createClient<import("../generated/app.d.ts").paths>>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the two-arg or composite-id form to `(type, key)`. */
function splitContextId(idOrType: string, key?: string): [string, string] {
  if (key === undefined) {
    if (!idOrType.includes(":")) {
      throw new Error(
        `context id must be 'type:key' (got ${JSON.stringify(idOrType)}); ` +
          "alternatively pass type and key as separate args",
      );
    }
    const colonIdx = idOrType.indexOf(":");
    return [idOrType.slice(0, colonIdx), idOrType.slice(colonIdx + 1)];
  }
  return [idOrType, key];
}

async function checkError(response: Response, error?: unknown): Promise<never> {
  // ``openapi-fetch`` pre-reads the response body to populate ``result.error``
  // / ``result.data`` — by the time we get here ``response.text()`` returns
  // ``""`` because the stream is consumed. Prefer the pre-parsed error payload
  // when openapi-fetch handed one to us; fall back to a fresh ``.text()`` for
  // the rare case where openapi-fetch didn't parse it (non-JSON body, network
  // shape change, etc.). Without this, customers see ``HTTP 400`` with empty
  // body instead of the JSON:API error code / detail the server actually
  // returned (e.g. ``environment_unmanaged``).
  let body = "";
  if (error !== undefined && error !== null) {
    try {
      body = typeof error === "string" ? error : JSON.stringify(error);
      /* v8 ignore start — JSON.stringify only throws on circular refs / BigInts,
         which openapi-fetch's JSON parser would have already rejected before
         we reach this code path. Kept as a belt-and-braces guard. */
    } catch {
      // leave body empty; throwForStatus tolerates an empty payload
    }
    /* v8 ignore stop */
  }
  /* v8 ignore start — fallback path for the rare case where openapi-fetch
     produces undefined/null error (e.g. genuinely empty response body or a
     transport-layer surprise). The happy paths above cover JSON and text. */
  if (!body) {
    body = await response.text().catch(() => "");
  }
  /* v8 ignore stop */
  throwForStatus(response.status, body);
}

function wrapFetchError(err: unknown): never {
  if (err instanceof SmplkitError) throw err;
  if (err instanceof TypeError) {
    throw new SmplkitConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplkitConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * Build the `page[number]` / `page[size]` query for a list call.
 *
 * Each value is included only when the caller supplied a non-undefined
 * override — omitting both yields `{}`, letting the server send the default
 * page (1) and size (1000).
 */
function paginationQuery(params: {
  pageNumber?: number;
  pageSize?: number;
}): Record<string, number> {
  const query: Record<string, number> = {};
  if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
  if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
  return query;
}

function envFromResource(resource: any, client: EnvironmentsClient): Environment {
  const attrs = resource.attributes ?? {};
  let color: Color | string | null = null;
  if (typeof attrs.color === "string" && attrs.color.length > 0) {
    try {
      color = new Color(attrs.color);
    } catch {
      color = null;
    }
  }
  return new Environment(client, {
    id: resource.id ?? null,
    name: attrs.name ?? "",
    color,
    classification:
      attrs.classification === "AD_HOC"
        ? EnvironmentClassification.AD_HOC
        : EnvironmentClassification.STANDARD,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

function svcFromResource(resource: any, client: ServicesClient): Service {
  const attrs = resource.attributes ?? {};
  return new Service(client, {
    id: resource.id ?? null,
    name: attrs.name ?? "",
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

function ctFromResource(resource: any, client: ContextTypesClient): ContextType {
  const attrs = resource.attributes ?? {};
  const rawMeta = attrs.attributes;
  const attributeMetadata: Record<string, Record<string, any>> = {};
  if (rawMeta && typeof rawMeta === "object") {
    for (const [k, v] of Object.entries(rawMeta)) {
      attributeMetadata[k] = typeof v === "object" && v !== null ? (v as Record<string, any>) : {};
    }
  }
  return new ContextType(client, {
    id: resource.id ?? null,
    name: attrs.name ?? resource.id ?? "",
    attributes: attributeMetadata,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

function ctxFromResource(resource: any, client: ContextsClient): Context {
  const compositeId: string = resource.id ?? "";
  const colonIdx = compositeId.indexOf(":");
  const ctxType = colonIdx >= 0 ? compositeId.slice(0, colonIdx) : compositeId;
  const ctxKey = colonIdx >= 0 ? compositeId.slice(colonIdx + 1) : "";
  const attrs = resource.attributes ?? {};
  const rawAttrs = attrs.attributes;
  const attrDict: Record<string, unknown> =
    rawAttrs && typeof rawAttrs === "object" ? { ...(rawAttrs as Record<string, unknown>) } : {};
  const ctx = new Context(ctxType, ctxKey, attrDict, {
    name: attrs.name ?? undefined,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
  ctx._client = client;
  return ctx;
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/** Environment CRUD (`client.platform.environments`). */
export class EnvironmentsClient {
  /** @internal */
  constructor(private readonly _http: AppHttp) {}

  /**
   * Build an unsaved {@link Environment}; call `.save()` to persist it.
   *
   * @param id - Stable, human-readable identifier for the environment (for
   *   example `"production"`).
   * @param options.name - Display name shown in the Console.
   * @param options.color - Accent color for the environment, as a {@link Color}
   *   or a CSS hex string. Defaults to no color.
   * @param options.classification - Whether the environment participates in the
   *   standard environment ordering. Defaults to
   *   {@link EnvironmentClassification.STANDARD}.
   * @returns An unsaved {@link Environment} bound to this client.
   */
  new(
    id: string,
    options: {
      name: string;
      color?: Color | string | null;
      classification?: EnvironmentClassification;
    },
  ): Environment {
    return new Environment(this, {
      id,
      name: options.name,
      color: coerceColor(options.color ?? null),
      classification: options.classification ?? EnvironmentClassification.STANDARD,
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * List environments in the account.
   *
   * @param params.pageNumber - 1-based page to fetch. Defaults to the first
   *   page.
   * @param params.pageSize - Maximum number of environments per page. Defaults
   *   to the server's page size.
   * @returns The environments on the requested page.
   */
  async list(params: { pageNumber?: number; pageSize?: number } = {}): Promise<Environment[]> {
    const query = paginationQuery(params);
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/environments", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => envFromResource(r, this));
  }

  /**
   * Fetch a single environment by id.
   *
   * @param id - Identifier of the environment to fetch.
   * @returns The matching {@link Environment}.
   * @throws {@link SmplkitNotFoundError} If no environment with that id exists.
   */
  async get(id: string): Promise<Environment> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/environments/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data)
      throw new SmplkitNotFoundError(`Environment with id ${JSON.stringify(id)} not found`);
    return envFromResource(data.data, this);
  }

  /**
   * Delete an environment by id.
   *
   * @param id - Identifier of the environment to delete.
   */
  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/environments/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response, result.error);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal */
  async _create(env: Environment): Promise<Environment> {
    /* v8 ignore start — defensive guard: `Environment.id` is always set by
       `platform.environments.new(id, ...)`, the only public path that reaches
       `_create`. The spec narrows `data.id` to a non-null string on create. */
    if (env.id === null) {
      throw new SmplkitValidationError("Cannot create an Environment without an id");
    }
    /* v8 ignore stop */
    const body: any = {
      data: {
        id: env.id,
        type: "environment",
        attributes: {
          name: env.name,
          color: env.color === null ? null : env.color.hex,
          classification: env.classification,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.POST("/api/v1/environments", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError("Failed to create environment");
    return envFromResource(data.data, this);
  }

  /** @internal */
  async _update(env: Environment): Promise<Environment> {
    if (!env.id) throw new Error("cannot update an Environment with no id");
    const body: any = {
      data: {
        id: env.id,
        type: "environment",
        attributes: {
          name: env.name,
          color: env.color === null ? null : env.color.hex,
          classification: env.classification,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.PUT("/api/v1/environments/{id}", {
        params: { path: { id: env.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError(`Failed to update environment ${env.id}`);
    return envFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** Service CRUD (`client.platform.services`). */
export class ServicesClient {
  /** @internal */
  constructor(private readonly _http: AppHttp) {}

  /**
   * Build an unsaved {@link Service}; call `.save()` to persist it.
   *
   * @param id - Stable, human-readable identifier for the service.
   * @param options.name - Display name shown in the Console.
   * @returns An unsaved {@link Service} bound to this client.
   */
  new(id: string, options: { name: string }): Service {
    return new Service(this, {
      id,
      name: options.name,
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * List services in the account.
   *
   * @param params.pageNumber - 1-based page to fetch. Defaults to the first
   *   page.
   * @param params.pageSize - Maximum number of services per page. Defaults to
   *   the server's page size.
   * @returns The services on the requested page.
   */
  async list(params: { pageNumber?: number; pageSize?: number } = {}): Promise<Service[]> {
    const query = paginationQuery(params);
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/services", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => svcFromResource(r, this));
  }

  /**
   * Fetch a single service by id.
   *
   * @param id - Identifier of the service to fetch.
   * @returns The matching {@link Service}.
   * @throws {@link SmplkitNotFoundError} If no service with that id exists.
   */
  async get(id: string): Promise<Service> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/services/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data)
      throw new SmplkitNotFoundError(`Service with id ${JSON.stringify(id)} not found`);
    return svcFromResource(data.data, this);
  }

  /**
   * Delete a service by id.
   *
   * @param id - Identifier of the service to delete.
   */
  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/services/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response, result.error);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal */
  async _create(svc: Service): Promise<Service> {
    /* v8 ignore start — defensive guard: `Service.id` is always set by
       `platform.services.new(id, ...)`, the only public path that reaches
       `_create`. The spec narrows `data.id` to a non-null string on create. */
    if (svc.id === null) {
      throw new SmplkitValidationError("Cannot create a Service without an id");
    }
    /* v8 ignore stop */
    const body: any = {
      data: {
        id: svc.id,
        type: "service",
        attributes: {
          name: svc.name,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.POST("/api/v1/services", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError("Failed to create service");
    return svcFromResource(data.data, this);
  }

  /** @internal */
  async _update(svc: Service): Promise<Service> {
    if (!svc.id) throw new Error("cannot update a Service with no id");
    const body: any = {
      data: {
        id: svc.id,
        type: "service",
        attributes: {
          name: svc.name,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.PUT("/api/v1/services/{id}", {
        params: { path: { id: svc.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError(`Failed to update service ${svc.id}`);
    return svcFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// Context Types
// ---------------------------------------------------------------------------

/** Context-type CRUD (`client.platform.contextTypes`). */
export class ContextTypesClient {
  /** @internal */
  constructor(private readonly _http: AppHttp) {}

  /**
   * Build an unsaved {@link ContextType}; call `.save()` to persist it.
   *
   * @param id - Stable, human-readable identifier for the context type (for
   *   example `"user"`).
   * @param options.name - Display name shown in the Console. Defaults to `id`
   *   when omitted.
   * @param options.attributes - Known-attribute slots, keyed by attribute name,
   *   with a metadata object per slot. Defaults to no declared attributes.
   * @returns An unsaved {@link ContextType} bound to this client.
   */
  new(
    id: string,
    options: { name?: string; attributes?: Record<string, Record<string, any>> } = {},
  ): ContextType {
    return new ContextType(this, {
      id,
      name: options.name ?? id,
      attributes: options.attributes ?? {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * List context types in the account.
   *
   * @param params.pageNumber - 1-based page to fetch. Defaults to the first
   *   page.
   * @param params.pageSize - Maximum number of context types per page. Defaults
   *   to the server's page size.
   * @returns The context types on the requested page.
   */
  async list(params: { pageNumber?: number; pageSize?: number } = {}): Promise<ContextType[]> {
    const query = paginationQuery(params);
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/context_types", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => ctFromResource(r, this));
  }

  /**
   * Fetch a single context type by id.
   *
   * @param id - Identifier of the context type to fetch.
   * @returns The matching {@link ContextType}.
   * @throws {@link SmplkitNotFoundError} If no context type with that id exists.
   */
  async get(id: string): Promise<ContextType> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/context_types/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data)
      throw new SmplkitNotFoundError(`ContextType with id ${JSON.stringify(id)} not found`);
    return ctFromResource(data.data, this);
  }

  /**
   * Delete a context type by id.
   *
   * @param id - Identifier of the context type to delete.
   */
  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/context_types/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response, result.error);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal */
  async _create(ct: ContextType): Promise<ContextType> {
    const body: any = {
      data: {
        id: ct.id,
        type: "context_type",
        attributes: {
          name: ct.name,
          attributes: ct.attributes,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.POST("/api/v1/context_types", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError("Failed to create context type");
    return ctFromResource(data.data, this);
  }

  /** @internal */
  async _update(ct: ContextType): Promise<ContextType> {
    if (!ct.id) throw new Error("cannot update a ContextType with no id");
    const body: any = {
      data: {
        id: ct.id,
        type: "context_type",
        attributes: {
          name: ct.name,
          attributes: ct.attributes,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.PUT("/api/v1/context_types/{id}", {
        params: { path: { id: ct.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError(`Failed to update context type ${ct.id}`);
    return ctFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

/** Context registration + read/delete (`client.platform.contexts`). */
export class ContextsClient {
  /** @internal */
  readonly _buffer: ContextRegistrationBuffer;

  /** @internal */
  constructor(
    private readonly _http: AppHttp,
    buffer?: ContextRegistrationBuffer,
  ) {
    this._buffer = buffer ?? new ContextRegistrationBuffer();
  }

  /**
   * Buffer one or more contexts for registration.
   *
   * Buffered contexts are sent in batches: a background flush kicks in once
   * enough have accumulated, and any remainder is sent on the next explicit
   * flush. Pass `flush: true` to send everything buffered right away.
   *
   * @param items - A single context or a list of contexts to register.
   * @param options.flush - When `true`, send all buffered contexts immediately
   *   rather than waiting for the batch threshold. Defaults to `false`.
   */
  async register(items: Context | Context[], options: { flush?: boolean } = {}): Promise<void> {
    const batch = Array.isArray(items) ? items : [items];
    this._buffer.observe(batch);
    if (options.flush) {
      await this.flush();
      return;
    }
    if (this._buffer.pendingCount >= CONTEXT_BATCH_FLUSH_SIZE) {
      void this.flush();
    }
  }

  /** Send any pending observations to the server. */
  async flush(): Promise<void> {
    const batch = this._buffer.drain();
    if (batch.length === 0) return;
    try {
      const result = await this._http.POST("/api/v1/contexts/bulk", {
        body: {
          contexts: batch.map((ctx) => ({
            type: ctx.type,
            key: ctx.key,
            attributes: ctx.attributes,
          })),
        },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** Number of observations queued and awaiting flush. */
  get pendingCount(): number {
    return this._buffer.pendingCount;
  }

  /**
   * List all contexts of a given type.
   *
   * @param type - Context type to list (for example `"user"`).
   * @param params.pageNumber - 1-based page to fetch. Defaults to the first
   *   page.
   * @param params.pageSize - Maximum number of contexts per page. Defaults to
   *   the server's page size.
   * @returns The contexts of the given type on the requested page.
   */
  async list(
    type: string,
    params: { pageNumber?: number; pageSize?: number } = {},
  ): Promise<Context[]> {
    const query: Record<string, string | number> = { "filter[context_type]": type };
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/contexts", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => ctxFromResource(r, this));
  }

  /**
   * Fetch a single context, identified by composite id or by type and key.
   *
   * @param idOrType - Either the composite context id `"type:key"` (when `key`
   *   is omitted) or just the context type (when `key` is supplied).
   * @param key - The context key. Provide it to use the two-argument form; omit
   *   it when `idOrType` already carries the composite id.
   * @returns The matching {@link Context}.
   * @throws {@link SmplkitNotFoundError} If no context with that id exists.
   */
  async get(idOrType: string, key?: string): Promise<Context> {
    const [ctxType, ctxKey] = splitContextId(idOrType, key);
    const composite = `${ctxType}:${ctxKey}`;
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/contexts/{id}", {
        params: { path: { id: composite } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data)
      throw new SmplkitNotFoundError(`Context with id ${JSON.stringify(composite)} not found`);
    return ctxFromResource(data.data, this);
  }

  /**
   * Delete a single context, identified by composite id or by type and key.
   *
   * @param idOrType - Either the composite context id `"type:key"` (when `key`
   *   is omitted) or just the context type (when `key` is supplied).
   * @param key - The context key. Provide it to use the two-argument form; omit
   *   it when `idOrType` already carries the composite id.
   */
  async delete(idOrType: string, key?: string): Promise<void> {
    const [ctxType, ctxKey] = splitContextId(idOrType, key);
    const composite = `${ctxType}:${ctxKey}`;
    try {
      const result = await this._http.DELETE("/api/v1/contexts/{id}", {
        params: { path: { id: composite } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response, result.error);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal — called by `Context.save()`. */
  async _saveContext(ctx: Context): Promise<Context> {
    const body: any = {
      data: {
        id: ctx.id,
        type: "context",
        attributes: {
          name: ctx.name ?? null,
          context_type: ctx.type,
          attributes: ctx.attributes,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.PUT("/api/v1/contexts/{id}", {
        params: { path: { id: ctx.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError(`Failed to save context ${ctx.id}`);
    return ctxFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// PlatformClient (client.platform)
// ---------------------------------------------------------------------------

/** Configuration options for the {@link PlatformClient}. */
export interface PlatformClientOptions {
  /** API key. When omitted, resolved from `SMPLKIT_API_KEY` or `~/.smplkit`. */
  apiKey?: string;
  /**
   * Full app-service base URL. Usually resolved from `baseDomain`/`scheme`;
   * supplied directly by the top-level clients which have already computed it.
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
  /** Extra headers attached to every request. */
  extraHeaders?: Record<string, string>;
  /**
   * Internal — a pre-built app transport supplied by a top-level client so the
   * platform surface shares one connection pool. Not for direct use.
   * @internal
   */
  appTransport?: AppHttp;
  /**
   * Internal — the shared context-registration buffer. Not for direct use.
   * @internal
   */
  contextBuffer?: ContextRegistrationBuffer;
}

/**
 * The Smpl Platform client.
 *
 * Groups the account-wide CRUD resources that aren't owned by a single
 * product, reachable as `client.platform` ({@link SmplClient}) or constructed
 * directly:
 *
 * @example
 * ```typescript
 * import { PlatformClient } from "@smplkit/sdk";
 *
 * const platform = new PlatformClient({ apiKey: "sk_..." });
 * const prod = platform.environments.new("production", { name: "Production" });
 * await prod.save();
 * for (const svc of await platform.services.list()) {
 *   // ...
 * }
 * ```
 *
 * Sub-clients: `environments`, `services`, `contexts`, `contextTypes`. Pure
 * CRUD — no `install()` required.
 */
export class PlatformClient {
  /** Environment CRUD. */
  readonly environments: EnvironmentsClient;
  /** Service CRUD. */
  readonly services: ServicesClient;
  /** Evaluation-context registration + read/delete. */
  readonly contexts: ContextsClient;
  /** Context-type CRUD. */
  readonly contextTypes: ContextTypesClient;

  private readonly _appHttp: AppHttp;

  /** @internal — the shared context-registration buffer. */
  readonly _contextBuffer: ContextRegistrationBuffer;

  constructor(options: PlatformClientOptions = {}) {
    if (options.appTransport !== undefined) {
      this._appHttp = options.appTransport;
    } else {
      const cfg = resolveClientConfig(options);
      const appUrl = options.baseUrl ?? serviceUrl(cfg.scheme, "app", cfg.baseDomain);
      this._appHttp = createClient<import("../generated/app.d.ts").paths>({
        baseUrl: appUrl.replace(/\/+$/, ""),
        headers: {
          ...(options.extraHeaders ?? {}),
          Authorization: `Bearer ${cfg.apiKey}`,
          Accept: "application/json",
        },
      });
    }

    const buffer = options.contextBuffer ?? new ContextRegistrationBuffer();
    this._contextBuffer = buffer;

    this.environments = new EnvironmentsClient(this._appHttp);
    this.services = new ServicesClient(this._appHttp);
    this.contexts = new ContextsClient(this._appHttp, buffer);
    this.contextTypes = new ContextTypesClient(this._appHttp);
  }

  /**
   * Close the app transport — only when this client owns it.
   *
   * A wired client borrows the parent's app transport and closes nothing.
   */
  close(): void {
    // openapi-fetch has no pooled transport to tear down; kept for interface
    // symmetry with the wired/standalone construction shapes.
  }
}
