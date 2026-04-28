/**
 * Management sub-clients for client.management.*.
 *
 * Provides client.management.{environments, contexts, context_types,
 * account_settings} for app-service-owned resources.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import {
  SmplError,
  SmplNotFoundError,
  SmplValidationError,
  SmplConnectionError,
  throwForStatus,
} from "../errors.js";
import { EnvironmentClassification } from "./types.js";
import { Environment, ContextType, ContextEntity, AccountSettings } from "./models.js";
import type { Context } from "../flags/types.js";
import type { ContextRegistrationBuffer } from "../flags/client.js";

type AppClient = ReturnType<typeof createClient<import("../generated/app.d.ts").paths>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function checkError(response: Response, _context: string): Promise<never> {
  const body = await response.text().catch(() => "");
  throwForStatus(response.status, body);
}

function wrapFetchError(err: unknown): never {
  if (err instanceof SmplError) {
    throw err;
  }
  if (err instanceof TypeError) {
    throw new SmplConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

function envFromResource(
  resource: any,
  client: EnvironmentsClient,
): Environment {
  const attrs = resource.attributes ?? {};
  return new Environment(client, {
    id: resource.id ?? null,
    name: attrs.name ?? "",
    color: attrs.color ?? null,
    classification:
      attrs.classification === "AD_HOC"
        ? EnvironmentClassification.AD_HOC
        : EnvironmentClassification.STANDARD,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

function ctFromResource(resource: any, client: ContextTypesClient): ContextType {
  const attrs = resource.attributes ?? {};
  const rawMeta = attrs.attributes;
  let attributeMetadata: Record<string, Record<string, any>> = {};
  if (rawMeta && typeof rawMeta === "object") {
    for (const [k, v] of Object.entries(rawMeta)) {
      attributeMetadata[k] = typeof v === "object" && v !== null ? (v as Record<string, any>) : {};
    }
  }
  return new ContextType(client, {
    id: resource.id ?? null,
    name: attrs.name ?? "",
    attributes: attributeMetadata,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

function ctxEntityFromResource(resource: any): ContextEntity {
  const compositeId: string = resource.id ?? "";
  const colonIdx = compositeId.indexOf(":");
  const ctxType = colonIdx >= 0 ? compositeId.slice(0, colonIdx) : compositeId;
  const ctxKey = colonIdx >= 0 ? compositeId.slice(colonIdx + 1) : "";
  const attrs = resource.attributes ?? {};
  const rawAttrs = attrs.attributes;
  const attrDict: Record<string, any> =
    rawAttrs && typeof rawAttrs === "object" ? { ...(rawAttrs as Record<string, any>) } : {};
  return new ContextEntity({
    type: ctxType,
    key: ctxKey,
    name: attrs.name ?? null,
    attributes: attrDict,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

// ---------------------------------------------------------------------------
// EnvironmentsClient
// ---------------------------------------------------------------------------

/**
 * CRUD client for environments.
 *
 * Accessed via `client.management.environments`.
 */
export class EnvironmentsClient {
  /** @internal */
  constructor(private readonly _http: AppClient) {}

  /**
   * Return an unsaved `Environment`. Call `.save()` to persist.
   */
  new(
    id: string,
    options: {
      name: string;
      color?: string | null;
      classification?: EnvironmentClassification;
    },
  ): Environment {
    return new Environment(this, {
      id,
      name: options.name,
      color: options.color ?? null,
      classification: options.classification ?? EnvironmentClassification.STANDARD,
      createdAt: null,
      updatedAt: null,
    });
  }

  /** List all environments. */
  async list(): Promise<Environment[]> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/environments", {});
      if (!result.response.ok) await checkError(result.response, "Failed to list environments");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => envFromResource(r, this));
  }

  /** Fetch an environment by id. */
  async get(id: string): Promise<Environment> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/environments/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, `Environment '${id}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplNotFoundError(`Environment with id '${id}' not found`);
    return envFromResource(data.data, this);
  }

  /** Delete an environment by id. */
  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/environments/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204)
        await checkError(result.response, `Failed to delete environment '${id}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal — called by Environment.save() for new resources. */
  async _create(env: Environment): Promise<Environment> {
    const body = {
      data: {
        id: env.id,
        type: "environment" as const,
        attributes: {
          name: env.name,
          color: env.color,
          classification: env.classification,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.POST("/api/v1/environments", { body });
      if (!result.response.ok) await checkError(result.response, "Failed to create environment");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplValidationError("Failed to create environment");
    return envFromResource(data.data, this);
  }

  /** @internal — called by Environment.save() for existing resources. */
  async _update(env: Environment): Promise<Environment> {
    if (!env.id) throw new Error("Cannot update an Environment with no id");
    const body = {
      data: {
        id: env.id,
        type: "environment" as const,
        attributes: {
          name: env.name,
          color: env.color,
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
      if (!result.response.ok)
        await checkError(result.response, `Failed to update environment ${env.id}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplValidationError(`Failed to update environment ${env.id}`);
    return envFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// ContextTypesClient
// ---------------------------------------------------------------------------

/**
 * CRUD client for context types.
 *
 * Accessed via `client.management.context_types`.
 */
export class ContextTypesClient {
  /** @internal */
  constructor(private readonly _http: AppClient) {}

  /**
   * Return an unsaved `ContextType`. Call `.save()` to persist.
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

  /** List all context types. */
  async list(): Promise<ContextType[]> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/context_types", {});
      if (!result.response.ok) await checkError(result.response, "Failed to list context types");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => ctFromResource(r, this));
  }

  /** Fetch a context type by id. */
  async get(id: string): Promise<ContextType> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/context_types/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok)
        await checkError(result.response, `ContextType '${id}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplNotFoundError(`ContextType with id '${id}' not found`);
    return ctFromResource(data.data, this);
  }

  /** Delete a context type by id. */
  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/context_types/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204)
        await checkError(result.response, `Failed to delete context type '${id}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal — called by ContextType.save() for new resources. */
  async _create(ct: ContextType): Promise<ContextType> {
    const body = {
      data: {
        id: ct.id,
        type: "context_type" as const,
        attributes: {
          id: ct.id,
          name: ct.name,
          attributes: ct.attributes,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.POST("/api/v1/context_types", { body });
      if (!result.response.ok) await checkError(result.response, "Failed to create context type");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplValidationError("Failed to create context type");
    return ctFromResource(data.data, this);
  }

  /** @internal — called by ContextType.save() for existing resources. */
  async _update(ct: ContextType): Promise<ContextType> {
    if (!ct.id) throw new Error("Cannot update a ContextType with no id");
    const body = {
      data: {
        id: ct.id,
        type: "context_type" as const,
        attributes: {
          id: ct.id,
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
      if (!result.response.ok)
        await checkError(result.response, `Failed to update context type ${ct.id}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplValidationError(`Failed to update context type ${ct.id}`);
    return ctFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// ContextsClient
// ---------------------------------------------------------------------------

/**
 * Context registration + read/delete client.
 *
 * Accessed via `client.management.contexts`.
 */
export class ContextsClient {
  /** @internal */
  constructor(
    private readonly _http: AppClient,
    private readonly _buffer: ContextRegistrationBuffer,
  ) {}

  /**
   * Buffer context(s) for registration; optionally flush immediately.
   *
   * When `flush` is false (default), contexts are queued for the SDK's
   * background flush — right for high-frequency observation from a live
   * request handler. When `flush` is true the call awaits the round-trip
   * — right for IaC scripts.
   */
  async register(items: Context | Context[], options: { flush?: boolean } = {}): Promise<void> {
    const batch = Array.isArray(items) ? items : [items];
    this._buffer.observe(batch);
    if (options.flush) {
      await this.flush();
    }
  }

  /** Send any pending context observations to the server. */
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
      if (!result.response.ok) await checkError(result.response, "Failed to flush contexts");
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** List all contexts of a given type. */
  async list(type: string): Promise<ContextEntity[]> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/contexts", {
        params: { query: { "filter[context_type]": type } },
      });
      if (!result.response.ok) await checkError(result.response, "Failed to list contexts");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map(ctxEntityFromResource);
  }

  /** Fetch a context by composite id (`"type:key"`) or by separate type and key. */
  async get(idOrType: string, key?: string): Promise<ContextEntity> {
    const [ctxType, ctxKey] = splitContextId(idOrType, key);
    const composite = `${ctxType}:${ctxKey}`;
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/contexts/{id}", {
        params: { path: { id: composite } },
      });
      if (!result.response.ok) await checkError(result.response, `Context '${composite}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplNotFoundError(`Context with id '${composite}' not found`);
    return ctxEntityFromResource(data.data);
  }

  /** Delete a context by composite id (`"type:key"`) or by separate type and key. */
  async delete(idOrType: string, key?: string): Promise<void> {
    const [ctxType, ctxKey] = splitContextId(idOrType, key);
    const composite = `${ctxType}:${ctxKey}`;
    try {
      const result = await this._http.DELETE("/api/v1/contexts/{id}", {
        params: { path: { id: composite } },
      });
      if (!result.response.ok && result.response.status !== 204)
        await checkError(result.response, `Failed to delete context '${composite}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// AccountSettingsClient
// ---------------------------------------------------------------------------

/**
 * Account-settings get/save client.
 *
 * The settings endpoint is not JSON:API — body is a raw JSON object — so
 * we use fetch directly rather than the typed openapi-fetch client.
 *
 * Accessed via `client.management.account_settings`.
 */
export class AccountSettingsClient {
  private readonly _headers: Record<string, string>;

  /** @internal */
  constructor(
    private readonly _appBaseUrl: string,
    apiKey: string,
  ) {
    this._headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /** Fetch the current account settings. */
  async get(): Promise<AccountSettings> {
    const url = `${this._appBaseUrl}/api/v1/accounts/current/settings`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers: this._headers });
    } catch (err) {
      throw new SmplConnectionError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throwForStatus(resp.status, body);
    }
    const data = await resp.json();
    return new AccountSettings(this, data ?? {});
  }

  /** @internal — called by AccountSettings.save(). */
  async _save(data: Record<string, any>): Promise<AccountSettings> {
    const url = `${this._appBaseUrl}/api/v1/accounts/current/settings`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "PUT",
        headers: this._headers,
        body: JSON.stringify(data),
      });
    } catch (err) {
      throw new SmplConnectionError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throwForStatus(resp.status, body);
    }
    const saved = await resp.json();
    return new AccountSettings(this, saved ?? {});
  }
}

// ---------------------------------------------------------------------------
// ManagementClient
// ---------------------------------------------------------------------------

/**
 * Top-level management namespace.
 *
 * Accessed via `client.management`.
 */
export class ManagementClient {
  /** CRUD for environments. */
  readonly environments: EnvironmentsClient;
  /** Registration, list, get, and delete for context instances. */
  readonly contexts: ContextsClient;
  /** CRUD for context types (entity schemas). */
  readonly context_types: ContextTypesClient;
  /** Get/save for account-level settings. */
  readonly account_settings: AccountSettingsClient;

  /** @internal */
  constructor(options: {
    appBaseUrl: string;
    apiKey: string;
    buffer: ContextRegistrationBuffer;
  }) {
    const http = createClient<import("../generated/app.d.ts").paths>({
      baseUrl: options.appBaseUrl,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: "application/json",
      },
    });
    this.environments = new EnvironmentsClient(http);
    this.contexts = new ContextsClient(http, options.buffer);
    this.context_types = new ContextTypesClient(http);
    this.account_settings = new AccountSettingsClient(options.appBaseUrl, options.apiKey);
  }
}
