/**
 * SmplManagementClient + sub-clients for app-plane resources.
 *
 * The management client has zero construction side effects:
 *   - no service registration
 *   - no metrics thread
 *   - no WebSocket
 *   - no logger discovery
 *
 * Right for setup scripts, CI, admin tooling, and one-off CRUD.
 *
 * Eight flat namespaces:
 *   - mgmt.contexts
 *   - mgmt.contextTypes
 *   - mgmt.environments
 *   - mgmt.accountSettings
 *   - mgmt.config           (singular — matches runtime client.config)
 *   - mgmt.flags
 *   - mgmt.loggers
 *   - mgmt.logGroups
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
import { Color, EnvironmentClassification, coerceColor } from "./types.js";
import { Environment, ContextType, AccountSettings } from "./models.js";
import { Context } from "../flags/types.js";
import { ManagementConfigClient } from "./config.js";
import { ManagementFlagsClient } from "./flags.js";
import { LoggersClient, LogGroupsClient } from "./logging.js";
import { resolveManagementConfig, serviceUrl } from "../config.js";
import type { ResolvedManagementConfig } from "../config.js";

type AppHttp = ReturnType<typeof createClient<import("../generated/app.d.ts").paths>>;
type ConfigHttp = ReturnType<typeof createClient<import("../generated/config.d.ts").paths>>;
type FlagsHttp = ReturnType<typeof createClient<import("../generated/flags.d.ts").paths>>;
type LoggingHttp = ReturnType<typeof createClient<import("../generated/logging.d.ts").paths>>;

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

async function checkError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
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
// EnvironmentsClient
// ---------------------------------------------------------------------------

/** `mgmt.environments.*` — CRUD for environments. */
export class EnvironmentsClient {
  /** @internal */
  constructor(private readonly _http: AppHttp) {}

  /**
   * Construct an unsaved {@link Environment}. Call `.save()` to persist.
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

  async list(): Promise<Environment[]> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/environments", {});
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => envFromResource(r, this));
  }

  async get(id: string): Promise<Environment> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/environments/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data)
      throw new SmplkitNotFoundError(`Environment with id ${JSON.stringify(id)} not found`);
    return envFromResource(data.data, this);
  }

  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/environments/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal */
  async _create(env: Environment): Promise<Environment> {
    const body = {
      data: {
        id: env.id,
        type: "environment" as const,
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
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError("Failed to create environment");
    return envFromResource(data.data, this);
  }

  /** @internal */
  async _update(env: Environment): Promise<Environment> {
    if (!env.id) throw new Error("Cannot update an Environment with no id");
    const body = {
      data: {
        id: env.id,
        type: "environment" as const,
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
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError(`Failed to update environment ${env.id}`);
    return envFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// ContextTypesClient
// ---------------------------------------------------------------------------

/** `mgmt.contextTypes.*` — CRUD for context types. */
export class ContextTypesClient {
  /** @internal */
  constructor(private readonly _http: AppHttp) {}

  /**
   * Construct an unsaved {@link ContextType}. Call `.save()` to persist.
   *
   * `name` defaults to the id when omitted.
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

  async list(): Promise<ContextType[]> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/context_types", {});
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => ctFromResource(r, this));
  }

  async get(id: string): Promise<ContextType> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/context_types/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data)
      throw new SmplkitNotFoundError(`ContextType with id ${JSON.stringify(id)} not found`);
    return ctFromResource(data.data, this);
  }

  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/context_types/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal */
  async _create(ct: ContextType): Promise<ContextType> {
    const body = {
      data: {
        id: ct.id,
        type: "context_type" as const,
        attributes: {
          name: ct.name,
          attributes: ct.attributes,
        },
      },
    };
    let data: any;
    try {
      const result = await this._http.POST("/api/v1/context_types", { body });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError("Failed to create context type");
    return ctFromResource(data.data, this);
  }

  /** @internal */
  async _update(ct: ContextType): Promise<ContextType> {
    if (!ct.id) throw new Error("Cannot update a ContextType with no id");
    const body = {
      data: {
        id: ct.id,
        type: "context_type" as const,
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
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError(`Failed to update context type ${ct.id}`);
    return ctFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// ContextsClient (with bulk register/flush)
// ---------------------------------------------------------------------------

const CONTEXT_BATCH_FLUSH_SIZE = 100;
const CONTEXT_REGISTRATION_LRU_SIZE = 10_000;

/**
 * Buffer pending context observations for bulk registration.
 *
 * Backed by an LRU of size {@link CONTEXT_REGISTRATION_LRU_SIZE} so the
 * dedup window doesn't grow unbounded for long-lived processes.
 * @internal
 */
export class ContextRegistrationBuffer {
  private _seen = new Map<string, Record<string, unknown>>();
  private _pending: Array<{ type: string; key: string; attributes: Record<string, unknown> }> = [];

  observe(contexts: Context[]): void {
    for (const ctx of contexts) {
      const cacheKey = `${ctx.type}:${ctx.key}`;
      if (!this._seen.has(cacheKey)) {
        if (this._seen.size >= CONTEXT_REGISTRATION_LRU_SIZE) {
          const firstKey = this._seen.keys().next().value;
          /* v8 ignore next */
          if (firstKey !== undefined) this._seen.delete(firstKey);
        }
        this._seen.set(cacheKey, ctx.attributes);
        this._pending.push({
          type: ctx.type,
          key: ctx.key,
          attributes: { ...ctx.attributes },
        });
      }
    }
  }

  drain(): Array<{ type: string; key: string; attributes: Record<string, unknown> }> {
    const batch = this._pending;
    this._pending = [];
    return batch;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

/** `mgmt.contexts.*` — register/list/get/delete for context instances. */
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
   * Buffer context(s) for registration; optionally flush immediately.
   *
   * When `flush` is false (default), contexts are queued for the SDK's
   * background flush. When `flush` is true the call awaits the round-trip.
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
      if (!result.response.ok) await checkError(result.response);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** Number of contexts awaiting flush. */
  get pendingCount(): number {
    return this._buffer.pendingCount;
  }

  /** List all contexts of a given type. */
  async list(type: string): Promise<Context[]> {
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/contexts", {
        params: { query: { "filter[context_type]": type } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    const items: any[] = data?.data ?? [];
    return items.map((r) => ctxFromResource(r, this));
  }

  /** Fetch a context by composite id (`"type:key"`) or by separate type and key. */
  async get(idOrType: string, key?: string): Promise<Context> {
    const [ctxType, ctxKey] = splitContextId(idOrType, key);
    const composite = `${ctxType}:${ctxKey}`;
    let data: any;
    try {
      const result = await this._http.GET("/api/v1/contexts/{id}", {
        params: { path: { id: composite } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data)
      throw new SmplkitNotFoundError(`Context with id ${JSON.stringify(composite)} not found`);
    return ctxFromResource(data.data, this);
  }

  /** Delete a context by composite id (`"type:key"`) or by separate type and key. */
  async delete(idOrType: string, key?: string): Promise<void> {
    const [ctxType, ctxKey] = splitContextId(idOrType, key);
    const composite = `${ctxType}:${ctxKey}`;
    try {
      const result = await this._http.DELETE("/api/v1/contexts/{id}", {
        params: { path: { id: composite } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal — called by `Context.save()`. */
  async _saveContext(ctx: Context): Promise<Context> {
    let data: any;
    try {
      if (ctx.createdAt === null) {
        // New contexts go through the bulk endpoint (no individual POST).
        await this.register([ctx], { flush: true });
        const fetched = await this.get(ctx.type, ctx.key);
        return fetched;
      }
      const body = {
        data: {
          id: ctx.id,
          type: "context" as const,
          attributes: {
            name: ctx.name ?? null,
            context_type: ctx.type,
            attributes: ctx.attributes,
          },
        },
      };
      const result = await this._http.PUT("/api/v1/contexts/{id}", {
        params: { path: { id: ctx.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data?.data) throw new SmplkitValidationError(`Failed to save context ${ctx.id}`);
    return ctxFromResource(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// AccountSettingsClient
// ---------------------------------------------------------------------------

/** `mgmt.accountSettings.*` — get/save for account-level settings. */
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

  async get(): Promise<AccountSettings> {
    const url = `${this._appBaseUrl}/api/v1/accounts/current/settings`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers: this._headers });
    } catch (err) {
      throw new SmplkitConnectionError(
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

  /** @internal */
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
      throw new SmplkitConnectionError(
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
// SmplManagementClient — top-level standalone management entry point
// ---------------------------------------------------------------------------

/** Configuration options for the {@link SmplManagementClient}. */
export interface SmplManagementClientOptions {
  /** API key. Resolves from `SMPLKIT_API_KEY` / `~/.smplkit` if omitted. */
  apiKey?: string;
  /** Configuration profile to use from `~/.smplkit`. Default `"default"`. */
  profile?: string;
  /** Base domain for service URLs. Default `"smplkit.com"`. */
  baseDomain?: string;
  /** URL scheme. Default `"https"`. */
  scheme?: string;
  /** Enable debug logging to stderr. */
  debug?: boolean;
}

/**
 * Standalone management/CRUD entry point — zero construction side effects.
 *
 * Construction does **not**:
 *   - register the service or environment as context instances
 *   - start a metrics thread
 *   - open the WebSocket
 *   - install logger discovery
 *
 * Use this for setup scripts, CI, admin tooling, and one-off CRUD.
 *
 * @example
 * ```typescript
 * import { SmplManagementClient } from "@smplkit/sdk";
 *
 * const mgmt = new SmplManagementClient();
 * const env = mgmt.environments.new("production", { name: "Production" });
 * await env.save();
 * await mgmt.close();
 * ```
 */
export class SmplManagementClient {
  /** Context entity CRUD. */
  readonly contexts: ContextsClient;
  /** Context-type schemas. */
  readonly contextTypes: ContextTypesClient;
  /** Environment CRUD. */
  readonly environments: EnvironmentsClient;
  /** Account-level settings. */
  readonly accountSettings: AccountSettingsClient;
  /** Config CRUD (singular — matches runtime `client.config`). */
  readonly config: ManagementConfigClient;
  /** Flag CRUD + bulk registration. */
  readonly flags: ManagementFlagsClient;
  /** Logger CRUD + bulk registration. */
  readonly loggers: LoggersClient;
  /** Log group CRUD. */
  readonly logGroups: LogGroupsClient;

  /** @internal — shared HTTP transports (so SmplClient can alias them). */
  readonly _appHttp: AppHttp;
  /** @internal */
  readonly _configHttp: ConfigHttp;
  /** @internal */
  readonly _flagsHttp: FlagsHttp;
  /** @internal */
  readonly _loggingHttp: LoggingHttp;

  constructor(options: SmplManagementClientOptions = {}) {
    const cfg = resolveManagementConfig(options);
    this._init(cfg);
    // Construct namespaces (assigned in _init via helper)
    this.contexts = this._contextsRef;
    this.contextTypes = this._contextTypesRef;
    this.environments = this._environmentsRef;
    this.accountSettings = this._accountSettingsRef;
    this.config = this._configRef;
    this.flags = this._flagsRef;
    this.loggers = this._loggersRef;
    this.logGroups = this._logGroupsRef;
    this._appHttp = this._appHttpRef;
    this._configHttp = this._configHttpRef;
    this._flagsHttp = this._flagsHttpRef;
    this._loggingHttp = this._loggingHttpRef;
  }

  // The fields below are populated in _init and then captured into readonly
  // properties on the constructor. This keeps the class shape simple.

  private _contextsRef!: ContextsClient;
  private _contextTypesRef!: ContextTypesClient;
  private _environmentsRef!: EnvironmentsClient;
  private _accountSettingsRef!: AccountSettingsClient;
  private _configRef!: ManagementConfigClient;
  private _flagsRef!: ManagementFlagsClient;
  private _loggersRef!: LoggersClient;
  private _logGroupsRef!: LogGroupsClient;
  private _appHttpRef!: AppHttp;
  private _configHttpRef!: ConfigHttp;
  private _flagsHttpRef!: FlagsHttp;
  private _loggingHttpRef!: LoggingHttp;
  private _sharedContextBuffer!: ContextRegistrationBuffer;

  private _init(cfg: ResolvedManagementConfig): void {
    const appBaseUrl = serviceUrl(cfg.scheme, "app", cfg.baseDomain);
    const configBaseUrl = serviceUrl(cfg.scheme, "config", cfg.baseDomain);
    const flagsBaseUrl = serviceUrl(cfg.scheme, "flags", cfg.baseDomain);
    const loggingBaseUrl = serviceUrl(cfg.scheme, "logging", cfg.baseDomain);

    const headers = {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
    };

    this._appHttpRef = createClient<import("../generated/app.d.ts").paths>({
      baseUrl: appBaseUrl,
      headers,
    });
    this._configHttpRef = createClient<import("../generated/config.d.ts").paths>({
      baseUrl: configBaseUrl,
      headers,
    });
    this._flagsHttpRef = createClient<import("../generated/flags.d.ts").paths>({
      baseUrl: flagsBaseUrl,
      headers,
    });
    this._loggingHttpRef = createClient<import("../generated/logging.d.ts").paths>({
      baseUrl: loggingBaseUrl,
      headers,
    });

    this._sharedContextBuffer = new ContextRegistrationBuffer();

    this._environmentsRef = new EnvironmentsClient(this._appHttpRef);
    this._contextTypesRef = new ContextTypesClient(this._appHttpRef);
    this._contextsRef = new ContextsClient(this._appHttpRef, this._sharedContextBuffer);
    this._accountSettingsRef = new AccountSettingsClient(appBaseUrl, cfg.apiKey);
    this._configRef = new ManagementConfigClient(this._configHttpRef);
    this._flagsRef = new ManagementFlagsClient(this._flagsHttpRef);
    this._loggersRef = new LoggersClient(this._loggingHttpRef);
    this._logGroupsRef = new LogGroupsClient(this._loggingHttpRef);
  }

  /** @internal — used by SmplClient to share the buffer. */
  get _contextBuffer(): ContextRegistrationBuffer {
    return this._sharedContextBuffer;
  }

  /** Release resources. Drains pending bulk registrations one last time. */
  async close(): Promise<void> {
    try {
      await this.contexts.flush();
      await this.flags.flush();
      await this.loggers.flush();
    } catch {
      // Final flush best-effort.
    }
  }
}
