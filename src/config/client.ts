/**
 * The Smpl Config client — one unified `ConfigClient`.
 *
 * Smpl Config has two surfaces on a single client, mirroring how the audit
 * and jobs clients expose their full surface from one class:
 *
 * - **Management surface** — pure CRUD, no live connection: `new` / `get`
 *   / `list` / `delete` and the discovery buffer (`registerConfig` /
 *   `registerConfigItem` / `flush` / `pendingCount`). The client owns the
 *   discovery buffer directly.
 * - **Live surface** — lazily connects to your running service on first use:
 *   `subscribe` (a live dict-like {@link LiveConfigProxy}), `getValue` (an
 *   ad-hoc resolved read), `bind` (a live object binding), `onChange`, and
 *   `refresh`. The first live call transparently flushes discovery, fetches
 *   and resolves every config into the local cache, and opens the
 *   live-updates WebSocket — no explicit install step.
 *
 * The client supports two construction shapes:
 *
 * - **Wired** into {@link SmplClient} — borrows the parent's config transport
 *   for both runtime fetch and CRUD and the parent's shared WebSocket for the
 *   live channel. This is the common path.
 * - **Standalone** — `new ConfigClient({ apiKey, baseUrl, ... })` builds and
 *   owns its own config transport, and on first live use opens and owns its
 *   own WebSocket. `close()` tears down only the owned transport and owned
 *   WebSocket.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/config.d.ts";
import {
  SmplkitError,
  SmplkitConflictError,
  SmplkitConnectionError,
  SmplkitNotFoundError,
  SmplkitTimeoutError,
  SmplkitValidationError,
  throwForStatus,
} from "../errors.js";
import { resolveManagementConfig, serviceUrl } from "../config.js";
import { resolveChain } from "./resolve.js";
import { Config, ConfigEnvironment, environmentsToWire } from "./types.js";
import { LiveConfigProxy } from "./proxy.js";
import { keyToDisplayName } from "../helpers.js";
import type { MetricsReporter } from "../_metrics.js";
import { SharedWebSocket } from "../ws.js";
import { debug } from "../_debug.js";

type ConfigHttp = ReturnType<typeof createClient<import("../generated/config.d.ts").paths>>;

/** @internal — the owning {@link SmplClient} interface the wired client borrows. */
export interface ConfigParent {
  readonly _environment: string;
  readonly _service: string | null;
  _ensureStarted(): void;
  _ensureWs(): SharedWebSocket;
}

const BASE_URL = "https://config.smplkit.com";

/** Flush the discovery buffer once it reaches this many pending configs. */
const CONFIG_BATCH_FLUSH_SIZE = 50;

/** Sentinel that distinguishes "default not supplied" from "default is undefined"
 *  in the three-arg {@link ConfigClient.getValue} form. @internal */
const MISSING: unique symbol = Symbol("smplkit.config.getValue.MISSING");

/**
 * Describes a single config value change.
 *
 * Frozen — fields are set at construction and cannot be mutated afterward.
 */
export class ConfigChangeEvent {
  /** The config id that changed. */
  readonly configId: string;
  /** The item key within the config that changed. */
  readonly itemKey: string;
  /** The previous value. */
  readonly oldValue: unknown;
  /** The updated value. */
  readonly newValue: unknown;
  /** How the change was delivered (`"websocket"` or `"manual"`). */
  readonly source: "websocket" | "manual";

  constructor(fields: {
    configId: string;
    itemKey: string;
    oldValue: unknown;
    newValue: unknown;
    source: "websocket" | "manual";
  }) {
    this.configId = fields.configId;
    this.itemKey = fields.itemKey;
    this.oldValue = fields.oldValue;
    this.newValue = fields.newValue;
    this.source = fields.source;
    Object.freeze(this);
  }
}

/** @internal */
interface ChangeListener {
  callback: (event: ConfigChangeEvent) => void;
  configId: string | null;
  itemKey: string | null;
}

interface ConfigBufferEntry {
  id: string;
  items: Record<string, { value: unknown; type: string; description?: string }>;
  service?: string;
  environment?: string;
  parent?: string;
  name?: string;
  description?: string;
}

interface ConfigBufferMeta {
  service: string | null;
  environment: string | null;
  parent: string | null;
  name: string | null;
  description: string | null;
}

/**
 * Buffer pending config declarations for bulk registration. @internal
 *
 * Configs differ from flags because each entry carries a nested `items`
 * dict that grows incrementally as typed getters fire. We store per-config
 * metadata permanently so post-flush deltas re-attribute correctly, and
 * dedupe items per `(configId, itemKey)` so an already-sent item never
 * re-sends. Mirrors Python's `_ConfigRegistrationBuffer`.
 */
export class ConfigRegistrationBuffer {
  private _pending = new Map<string, ConfigBufferEntry>();
  private _meta = new Map<string, ConfigBufferMeta>();
  private _sentItems = new Set<string>();

  declare(configId: string, meta: ConfigBufferMeta): void {
    if (this._meta.has(configId)) return;
    this._meta.set(configId, meta);
    this._pending.set(configId, this._buildEntry(configId, {}));
  }

  addItem(
    configId: string,
    itemKey: string,
    itemType: string,
    defaultValue: unknown,
    description: string | null,
  ): void {
    if (!this._meta.has(configId)) return;
    const sentKey = `${configId}::${itemKey}`;
    if (this._sentItems.has(sentKey)) return;
    let entry = this._pending.get(configId);
    if (!entry) {
      entry = this._buildEntry(configId, {});
      this._pending.set(configId, entry);
    }
    if (itemKey in entry.items) return;
    const def: ConfigBufferEntry["items"][string] = { value: defaultValue, type: itemType };
    if (description !== null) def.description = description;
    entry.items[itemKey] = def;
  }

  private _buildEntry(configId: string, items: ConfigBufferEntry["items"]): ConfigBufferEntry {
    const meta = this._meta.get(configId)!;
    const entry: ConfigBufferEntry = { id: configId, items };
    if (meta.service !== null) entry.service = meta.service;
    if (meta.environment !== null) entry.environment = meta.environment;
    if (meta.parent !== null) entry.parent = meta.parent;
    if (meta.name !== null) entry.name = meta.name;
    if (meta.description !== null) entry.description = meta.description;
    return entry;
  }

  /** Destructive drain — records sent items so they aren't re-queued. */
  drain(): ConfigBufferEntry[] {
    const batch = Array.from(this._pending.values());
    for (const entry of batch) {
      for (const itemKey of Object.keys(entry.items)) {
        this._sentItems.add(`${entry.id}::${itemKey}`);
      }
    }
    this._pending.clear();
    return batch;
  }

  get pendingCount(): number {
    return this._pending.size;
  }
}

/** @internal */
function wrapFetchError(err: unknown): never {
  if (
    err instanceof SmplkitNotFoundError ||
    err instanceof SmplkitConflictError ||
    err instanceof SmplkitValidationError ||
    err instanceof SmplkitError
  ) {
    throw err;
  }
  if (err instanceof TypeError) {
    throw new SmplkitConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplkitConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

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

/** Shared attribute builder for create + update. @internal */
function buildAttrs(config: Config): components["schemas"]["Config"] {
  const attrs: components["schemas"]["Config"] = { name: config.name };
  if (config.description !== null) attrs.description = config.description;
  if (config.parent !== null) attrs.parent = config.parent;
  attrs.items = config._itemsRawDirect as typeof attrs.items;
  attrs.environments = environmentsToWire(config._environmentsDirect) as typeof attrs.environments;
  return attrs;
}

/** @internal */
function buildCreateBody(config: Config): components["schemas"]["ConfigCreateRequest"] {
  /* v8 ignore start — defensive guard: `Config.id` is always set by the
     `config.new(id, ...)` factory, the only public path that reaches
     `_createConfig`. Spec narrowing requires a non-null `data.id`. */
  if (config.id === null) {
    throw new SmplkitValidationError("Cannot create a Config without an id");
  }
  /* v8 ignore stop */
  return {
    data: {
      id: config.id,
      type: "config",
      attributes: buildAttrs(config),
    },
  };
}

/** @internal */
function buildUpdateBody(config: Config): components["schemas"]["ConfigRequest"] {
  return {
    data: {
      id: config.id ?? null,
      type: "config",
      attributes: buildAttrs(config),
    },
  };
}

/**
 * Map a runtime value (bind value or getValue default) to a Config item type.
 *
 * `boolean` is checked before `number` because `typeof true === "boolean"`
 * already disambiguates them — we follow the same ordering as the Python SDK
 * for symmetry.
 * @internal
 */
function valueToItemType(value: unknown): string {
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "number") return "NUMBER";
  if (typeof value === "string") return "STRING";
  return "STRING";
}

/**
 * Plain "object literal" predicate — a record whose prototype is either
 * `Object.prototype` or `null`. Distinguishes the dict-bind path (plain
 * objects) from the class-instance-bind path (anything else).
 * @internal
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk a bound object and yield `[key, type, value]` triples flattened to
 * dot-notation. Nested plain objects are descended into; class instances
 * and arrays are treated as opaque leaves.
 * @internal
 */
function iterObjectItems(
  obj: Record<string, unknown>,
  prefix: string = "",
): Array<[string, string, unknown]> {
  const out: Array<[string, string, unknown]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = `${prefix}${key}`;
    if (isPlainObject(value)) {
      out.push(...iterObjectItems(value, `${flatKey}.`));
      continue;
    }
    out.push([flatKey, valueToItemType(value), value]);
  }
  return out;
}

/**
 * Apply a server-pushed value to a bound target in place. Walks the dotted
 * key path to the leaf's parent, then assigns the value. Bails silently if
 * any intermediate is missing or non-object.
 * @internal
 */
function applyChangeToTarget(target: object, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split(".");
  let current: any = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current === null || typeof current !== "object" || !(part in current)) return;
    current = current[part];
  }
  if (current === null || typeof current !== "object") return;
  current[parts[parts.length - 1]] = value;
}

/** Flatten a bound object to `{dottedKey: value}` (mirrors the discovery walk). @internal */
function boundItemsToFlat(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, , value] of iterObjectItems(obj as Record<string, unknown>)) {
    out[key] = value;
  }
  return out;
}

/**
 * Construct a typed {@link Config} from a wire resource. A `null` client
 * yields a read-only model for the resolver cache; passing the client yields
 * an editable model with `.save()` / `.delete()`.
 * @internal
 */
function resourceToConfig(
  client: ConfigClient | null,
  resource: components["schemas"]["ConfigResource"],
): Config {
  const attrs = resource.attributes;
  return new Config(client, {
    id: resource.id ?? null,
    name: attrs.name,
    description: attrs.description ?? null,
    parent: attrs.parent ?? null,
    items: attrs.items as Record<string, unknown> | null,
    environments: attrs.environments as Record<string, unknown> | null,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

/** Configuration options for the {@link ConfigClient}. */
export interface ConfigClientOptions {
  /** API key. When omitted, resolved from `SMPLKIT_API_KEY` or `~/.smplkit`. */
  apiKey?: string;
  /**
   * Deployment environment used to resolve runtime config values and to
   * scope discovery declarations. Optional.
   */
  environment?: string;
  /**
   * Full config-service base URL. Usually resolved from `baseDomain`/`scheme`;
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
  /** Request timeout in milliseconds (default 30000). */
  timeout?: number;
  /**
   * Internal — the owning {@link SmplClient}. Not for direct use.
   * @internal
   */
  parent?: ConfigParent;
  /**
   * Internal — a pre-built config transport supplied by a top-level client so
   * the config surface shares one connection pool. Not for direct use.
   * @internal
   */
  transport?: ConfigHttp;
  /**
   * Internal — the parent's metrics reporter.
   * @internal
   */
  metrics?: MetricsReporter | null;
}

/**
 * The Smpl Config client.
 *
 * One client exposes the full surface, reachable as `client.config`
 * ({@link SmplClient}) or constructed directly:
 *
 * @example
 * ```typescript
 * import { ConfigClient } from "@smplkit/sdk";
 *
 * const config = new ConfigClient({ environment: "production" });
 * const billing = config.new("billing", { name: "Billing" });
 * billing.setNumber("max_seats", 50);
 * await billing.save();
 * const proxy = await config.subscribe("billing");
 * console.log(proxy["max_seats"]);
 * ```
 *
 * The management surface (`new` / `get` / `list` / `delete` and discovery) is
 * pure CRUD. The live surface (`subscribe` / `getValue` / `bind` / `onChange`
 * / `refresh`) connects lazily on first use — the first call flushes
 * discovery, fetches and resolves all configs into the local cache, and opens
 * the live-updates WebSocket. No explicit install step is required.
 */
export class ConfigClient {
  /** @internal */
  private readonly _http: ConfigHttp;
  /** @internal */
  private readonly _parent: ConfigParent | null;
  /** @internal */
  private readonly _metrics: MetricsReporter | null;
  /** @internal */
  private readonly _environment: string;
  /** @internal */
  private readonly _service: string | null;

  /** @internal — owned discovery buffer (no management delegation). */
  readonly _buffer = new ConfigRegistrationBuffer();

  // Standalone-only WebSocket state.
  private readonly _appBaseUrl: string | null;
  private readonly _standaloneApiKey: string | null;
  private _wsManager: SharedWebSocket | null = null;
  private _ownsWs = false;

  // Live-surface state.
  private _configCache: Record<string, Record<string, unknown>> = {};
  private _rawConfigCache: Record<string, Config> = {};
  private _proxies: Record<string, LiveConfigProxy> = {};
  private _bindings: Map<string, object> = new Map();
  private _boundParents: Map<string, string | null> = new Map();
  private _connected = false;
  private _listeners: ChangeListener[] = [];

  constructor(options: ConfigClientOptions = {}) {
    this._parent = options.parent ?? null;
    this._metrics = options.metrics ?? null;
    this._environment = options.parent?._environment ?? options.environment ?? "";
    this._service = options.parent?._service ?? null;

    if (options.transport !== undefined) {
      this._http = options.transport;
      this._appBaseUrl = null;
      this._standaloneApiKey = null;
    } else {
      const cfg = resolveManagementConfig(options);
      const configUrl =
        options.baseUrl ?? serviceUrl(cfg.scheme, "config", cfg.baseDomain) ?? BASE_URL;
      this._appBaseUrl = serviceUrl(cfg.scheme, "app", cfg.baseDomain);
      this._standaloneApiKey = options.apiKey ?? cfg.apiKey;
      const ms = options.timeout ?? 30_000;
      this._http = createClient<import("../generated/config.d.ts").paths>({
        baseUrl: configUrl.replace(/\/+$/, ""),
        headers: {
          ...(options.extraHeaders ?? {}),
          Authorization: `Bearer ${this._standaloneApiKey}`,
          Accept: "application/json",
        },
        fetch: async (request: Request): Promise<Response> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), ms);
          try {
            return await fetch(new Request(request, { signal: controller.signal }));
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
    }
  }

  // ------------------------------------------------------------------
  // Management surface: CRUD (no live connection)
  // ------------------------------------------------------------------

  /**
   * Return a new unsaved {@link Config}. Call {@link Config.save} to persist.
   *
   * `parent` accepts either a config id (string) or an existing {@link Config}
   * instance — passing the instance lets you skip naming the id explicitly
   * when you already have the parent in scope.
   */
  new(
    id: string,
    options: { name?: string; description?: string; parent?: string | Config | null } = {},
  ): Config {
    const parent = options.parent;
    const parentId =
      typeof parent === "string" ? parent : parent instanceof Config ? parent.id : null;
    return new Config(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      description: options.description ?? null,
      parent: parentId,
      items: null,
      environments: null,
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * Fetch the editable {@link Config} resource by id.
   *
   * Throws {@link SmplkitNotFoundError} if no config with that id exists.
   */
  async get(id: string): Promise<Config> {
    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitNotFoundError(`Config with id '${id}' not found`);
    }
    return resourceToConfig(this, data.data);
  }

  /** List configs for the authenticated account. */
  async list(params: { pageNumber?: number; pageSize?: number } = {}): Promise<Config[]> {
    const query: Record<string, number> = {};
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    let data: components["schemas"]["ConfigListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToConfig(this, r));
  }

  /** Delete a config by id. */
  async delete(id: string): Promise<void> {
    return this._deleteConfig(id);
  }

  /** @internal — called by `Config.delete()`. */
  async _deleteConfig(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/configs/{id}", {
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

  /** @internal — called by `Config._buildChain` to resolve parents. */
  async _fetchConfig(id: string): Promise<Config> {
    return this.get(id);
  }

  /** @internal — called by `Config.save()` for new resources. */
  async _createConfig(config: Config): Promise<Config> {
    const body = buildCreateBody(config);
    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/configs", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplkitValidationError("Failed to create config");
    return resourceToConfig(this, data.data);
  }

  /** @internal — called by `Config.save()` for existing resources. */
  async _updateConfig(config: Config): Promise<Config> {
    if (config.id === null) throw new Error("Cannot update a Config with no id");
    const body = buildUpdateBody(config);
    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/configs/{id}", {
        params: { path: { id: config.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitValidationError(`Failed to update config ${config.id}`);
    }
    return resourceToConfig(this, data.data);
  }

  // ------------------------------------------------------------------
  // Management surface: discovery buffer (owned directly)
  // ------------------------------------------------------------------

  /** Queue a configuration declaration for bulk-discovery upload. */
  registerConfig(
    configId: string,
    meta: {
      service: string | null;
      environment: string | null;
      parent?: string | null;
      name?: string | null;
      description?: string | null;
    },
  ): void {
    this._buffer.declare(configId, {
      service: meta.service,
      environment: meta.environment,
      parent: meta.parent ?? null,
      name: meta.name ?? null,
      description: meta.description ?? null,
    });
    if (this._buffer.pendingCount >= CONFIG_BATCH_FLUSH_SIZE) {
      void this._thresholdFlush();
    }
  }

  /** Queue a config item declaration. `registerConfig` must run first. */
  registerConfigItem(
    configId: string,
    itemKey: string,
    itemType: string,
    defaultValue: unknown,
    description: string | null = null,
  ): void {
    this._buffer.addItem(configId, itemKey, itemType, defaultValue, description);
    if (this._buffer.pendingCount >= CONFIG_BATCH_FLUSH_SIZE) {
      void this._thresholdFlush();
    }
  }

  /** @internal */
  private async _thresholdFlush(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      debug(
        "config",
        `Config registration flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * POST pending declarations to `/api/v1/configs/bulk`.
   *
   * Per ADR-024 §2.9, bulk registration always lands rows as `managed=false`
   * and is plan-limit-exempt — failures here never propagate to customer
   * code. Drained entries are not requeued; the SDK will re-observe on the
   * next process start.
   */
  async flush(): Promise<void> {
    const batch = this._buffer.drain();
    if (batch.length === 0) return;
    try {
      const result = await this._http.POST("/api/v1/configs/bulk", {
        body: { configs: batch } as never,
      });
      if (!result.response.ok) {
        // Fire-and-forget: drained entries are not requeued.
      }
    } catch {
      // Fire-and-forget.
    }
  }

  /** Number of pending config declarations awaiting flush. */
  get pendingCount(): number {
    return this._buffer.pendingCount;
  }

  // ------------------------------------------------------------------
  // Live surface: lazy connect + transport / WebSocket helpers
  // ------------------------------------------------------------------

  /** Return the shared WebSocket — the parent's when wired, else our own. @internal */
  private _ensureWs(): SharedWebSocket {
    if (this._parent !== null) {
      return this._parent._ensureWs();
    }
    if (this._wsManager === null) {
      this._wsManager = new SharedWebSocket(
        this._appBaseUrl!,
        this._standaloneApiKey!,
        this._metrics,
      );
      this._wsManager.start();
      this._ownsWs = true;
    }
    return this._wsManager;
  }

  /**
   * Open the live connection to the running Smpl Config service.
   *
   * Flushes any buffered discovery declarations, fetches and resolves every
   * config for the configured environment into the local cache, opens the
   * shared WebSocket, and subscribes to `config_changed` / `config_deleted` /
   * `configs_changed` events.
   *
   * Idempotent and internal — every live method calls it on first use, so the
   * live surface auto-connects with no explicit step.
   * @internal
   */
  async _ensureConnected(): Promise<void> {
    if (this._parent !== null) {
      this._parent._ensureStarted();
    }
    if (this._connected) return;

    // Flush any buffered discovery declarations BEFORE the initial fetch, so
    // newly-discovered configs appear in the cache on first read.
    try {
      await this.flush();
    } catch (err) {
      debug(
        "config",
        `Config discovery flush before connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this._doRefresh("initial");
    this._connected = true;

    const ws = this._ensureWs();
    ws.on("config_changed", this._handleConfigChanged);
    ws.on("config_deleted", this._handleConfigDeleted);
    ws.on("configs_changed", this._handleConfigsChanged);
  }

  /** List all configs directly from the API for the runtime cache. @internal */
  private async _fetchAllConfigs(): Promise<Config[]> {
    const PAGE_SIZE = 1000;
    const all: Config[] = [];
    let page = 1;
    let lastPageWasFull = true;
    while (lastPageWasFull) {
      let rows: Config[];
      try {
        const result = await this._http.GET("/api/v1/configs", {
          params: {
            query: { "page[number]": page, "page[size]": PAGE_SIZE } as unknown as Record<
              string,
              never
            >,
          },
        });
        if (!result.response.ok) await checkError(result.response, result.error);
        rows = result.data ? result.data.data.map((r) => resourceToConfig(this, r)) : [];
      } catch (err) {
        wrapFetchError(err);
      }
      all.push(...rows);
      lastPageWasFull = rows.length === PAGE_SIZE;
      page++;
    }
    return all;
  }

  /** Fetch a single config from the API. Returns `null` on missing data. @internal */
  private async _fetchSingleConfig(id: string): Promise<Config | null> {
    try {
      const result = await this._http.GET("/api/v1/configs/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) return null;
      if (!result.data?.data) return null;
      // Carry a client reference so the resolver can fetch a parent that is
      // not yet in the local raw cache (e.g. a config whose parent was created
      // via discovery after the initial connect and never broadcast a create
      // event). Without this the WS rebuild can't resolve the inheritance
      // chain and the bound object never sees the live update.
      return resourceToConfig(this, result.data.data);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Live surface: bind, subscribe, getValue
  // ------------------------------------------------------------------

  /**
   * Bind an object to a config id; return it live.
   *
   * Declarative, code-first API. The object's keys are the schema; its values
   * are the in-code defaults. On first boot the schema and values are
   * registered with the server. The local cache is then seeded so reads work
   * immediately: if the config already exists server-side (fetched on connect)
   * its values are authoritative and synced onto the bound object; if it is
   * brand-new, the cache entry is seeded in-memory from the bound object's
   * values resolved through its bound parent chain (no network round-trip). On
   * every WebSocket-delivered change thereafter the bound object is mutated in
   * place. Readers always see the current resolved value with no proxy
   * indirection.
   *
   * Idempotent. Repeated calls with the same `id` return the originally-bound
   * object; the new `config` argument is ignored.
   *
   * Connects lazily on first use — no explicit install step.
   *
   * **Plain object literals vs. class instances.** Plain object literals are
   * the recommended input shape — their keys are the explicit override set,
   * and omitted keys inherit from `parent`. Class instances are also accepted,
   * but every enumerable property is registered as an explicit override (there
   * is no JS equivalent of Python's `model_fields_set`).
   *
   * @param id - The config id to register under.
   * @param config - A plain object literal (recommended) or class instance
   *   carrying the in-code defaults.
   * @param options - Optional `parent`: another object previously returned
   *   from a {@link bind} call. Activates parent-chain inheritance for keys
   *   the caller omitted.
   * @returns The same `config` object, registered and live.
   * @throws TypeError if `config` is not an object.
   * @throws Error if `parent` was not previously bound via {@link bind}.
   */
  async bind<T extends object>(
    id: string,
    config: T,
    options: { parent?: object | null } = {},
  ): Promise<T> {
    await this._ensureConnected();
    if (config === null || typeof config !== "object") {
      throw new TypeError(`bind() requires an object; got ${typeof config}`);
    }

    const existing = this._bindings.get(id);
    if (existing !== undefined) {
      return existing as T;
    }

    const parentId = this._registerBindingDeclaration(id, config, options.parent ?? null);

    // Register the binding BEFORE seeding so WebSocket dispatch finds it.
    this._bindings.set(id, config);
    this._boundParents.set(id, parentId);
    this._seedOrSyncBinding(id, config);
    return config;
  }

  /**
   * Return a live, dict-like {@link LiveConfigProxy} for a config id.
   *
   * The proxy always reflects the latest resolved values; reads happen through
   * it (`proxy["key"]`, `proxy.get("key", default)`). Subscribing registers
   * the config declaration for code-first observability so the reference
   * appears in the smplkit console.
   *
   * Connects lazily on first use — no explicit install step. Throws
   * {@link SmplkitNotFoundError} if the config is unknown.
   */
  async subscribe(id: string): Promise<LiveConfigProxy> {
    await this._ensureConnected();
    this._observeConfigDeclaration(id, null, null, null);
    if (!(id in this._configCache)) {
      throw new SmplkitNotFoundError(`Config with id '${id}' not found`);
    }
    const metrics = this._metrics;
    if (metrics) {
      metrics.record("config.resolutions", 1, "resolutions", { config: id });
    }
    return this._cachedProxy(id);
  }

  /**
   * Read a single resolved config value (inheritance-aware).
   *
   * The value comes from the locally-cached resolved chain, so parent configs
   * are already folded in.
   *
   * Two forms:
   *
   * - `getValue(id, key)` returns the resolved value. Throws
   *   {@link SmplkitNotFoundError} if the config or the key is missing.
   * - `getValue(id, key, defaultValue)` returns the resolved value, falling
   *   back to `defaultValue` if the config or key is missing. Never throws.
   *   **Registers** the config (if new) and the key (inferred type,
   *   `defaultValue` as default) for code-first observability, so the
   *   reference appears in the smplkit console.
   *
   * For a live dict-like view use {@link subscribe}; for typed access use
   * {@link bind}. Connects lazily on first use — no explicit install step.
   */
  async getValue(id: string, key: string): Promise<unknown>;
  async getValue<V>(id: string, key: string, defaultValue: V): Promise<V | unknown>;
  async getValue(id: string, key: string, defaultValue: unknown = MISSING): Promise<unknown> {
    await this._ensureConnected();
    const hasDefault = defaultValue !== MISSING;
    if (hasDefault) {
      // Register the config + key so the reference shows up in the console
      // even if it's never been declared via bind(). The buffer is idempotent
      // at the (configId, itemKey) level.
      this._observeConfigDeclaration(id, null, null, null);
      this._observeItemDeclaration(id, key, valueToItemType(defaultValue), defaultValue, null);
    }

    if (!(id in this._configCache)) {
      if (hasDefault) return defaultValue;
      throw new SmplkitNotFoundError(`Config with id '${id}' not found`);
    }
    const values = this._configCache[id];
    if (!(key in values)) {
      if (hasDefault) return defaultValue;
      throw new SmplkitNotFoundError(`Config item '${key}' not found in config '${id}'`);
    }
    return values[key];
  }

  // ------------------------------------------------------------------
  // Internal: binding helpers
  // ------------------------------------------------------------------

  /** @internal */
  private _registerBindingDeclaration(
    id: string,
    config: object,
    parent: object | null,
  ): string | null {
    let parentId: string | null = null;
    if (parent !== null) {
      parentId = this._configIdFor(parent);
      if (parentId === null) {
        throw new Error(
          "bind(): parent must be an object previously returned from client.config.bind(). " +
            "Bind the parent first.",
        );
      }
    }

    // Derive a console display name from the class (for class instances) or
    // leave null (plain object literals have no class to introspect).
    const ctor = (config as any).constructor;
    const className =
      typeof ctor === "function" && ctor !== Object && typeof ctor.name === "string" && ctor.name
        ? (ctor.name as string)
        : null;

    this._observeConfigDeclaration(id, parentId, className, null);

    for (const [itemKey, itemType, value] of iterObjectItems(config as Record<string, unknown>)) {
      this._observeItemDeclaration(id, itemKey, itemType, value, null);
    }
    return parentId;
  }

  /** @internal — return the config_id this object was bound under, or null. */
  private _configIdFor(target: object): string | null {
    for (const [cid, bound] of this._bindings) {
      if (bound === target) return cid;
    }
    return null;
  }

  /** @internal — apply current cached values to a freshly-bound target. */
  private _syncTargetFromCache(target: object, configId: string): void {
    const cache = this._configCache[configId];
    if (!cache) return;
    for (const [dottedKey, value] of Object.entries(cache)) {
      applyChangeToTarget(target, dottedKey, value);
    }
  }

  /**
   * Seed the resolved cache for a freshly-bound config, or sync from it.
   *
   * If `configId` is already in the resolved cache it existed server-side
   * (fetched on connect), so server values are authoritative — sync them onto
   * the bound object. Otherwise the config is brand-new: seed the cache
   * in-memory by resolving this object's values through its bound parent
   * chain, so `subscribe` / `getValue` work immediately with no flush or
   * refresh. Pure in-memory — no network.
   * @internal
   */
  private _seedOrSyncBinding(configId: string, target: object): void {
    if (configId in this._configCache) {
      this._syncTargetFromCache(target, configId);
      return;
    }
    this._configCache[configId] = this._resolveBoundChain(configId);
  }

  /**
   * Resolve a bound config's values through its bound parent chain. Walks
   * `_boundParents` from the child up through already-bound ancestors,
   * flattening each bound object's in-code values, then runs the same
   * deep-merge resolver used everywhere else (child wins over parent).
   * @internal
   */
  private _resolveBoundChain(configId: string): Record<string, unknown> {
    const chain: Array<{
      id: string | null;
      items: Record<string, unknown>;
      environments: Record<string, unknown>;
    }> = [];
    let current: string | null = configId;
    const seen = new Set<string>();
    while (current !== null && this._bindings.has(current) && !seen.has(current)) {
      seen.add(current);
      const items = boundItemsToFlat(this._bindings.get(current)!);
      chain.push({ id: current, items, environments: {} });
      current = this._boundParents.get(current) ?? null;
    }
    return resolveChain(chain, this._environment);
  }

  /** @internal — return (and cache) the canonical proxy for a config id. */
  _cachedProxy(id: string): LiveConfigProxy {
    let proxy = this._proxies[id];
    if (!proxy) {
      proxy = new LiveConfigProxy(this, id);
      this._proxies[id] = proxy;
    }
    return proxy;
  }

  /** @internal — get resolved config from cache. Used by LiveConfigProxy. */
  _getCachedConfig(key: string): Record<string, unknown> | undefined {
    return this._configCache[key];
  }

  /** @internal — queue a config declaration with the owned discovery buffer. */
  _observeConfigDeclaration(
    configId: string,
    parent: string | null,
    name: string | null,
    description: string | null,
  ): void {
    this.registerConfig(configId, {
      service: this._service,
      environment: this._environment || null,
      parent,
      name,
      description,
    });
  }

  /** @internal — queue a config item declaration with the owned discovery buffer. */
  _observeItemDeclaration(
    configId: string,
    itemKey: string,
    itemType: string,
    defaultValue: unknown,
    description: string | null,
  ): void {
    this.registerConfigItem(configId, itemKey, itemType, defaultValue, description);
  }

  // ------------------------------------------------------------------
  // Live surface: refresh / change listeners
  // ------------------------------------------------------------------

  /**
   * Re-fetch all configs and update resolved values.
   *
   * Fires change listeners for any values that differ from the previous state.
   * Connects lazily on first use — no explicit install step.
   */
  async refresh(): Promise<void> {
    await this._ensureConnected();
    await this._doRefresh("manual");
  }

  /**
   * Register a change listener.
   *
   * - `onChange(callback)` — global listener.
   * - `onChange(configId, callback)` — config-scoped listener.
   * - `onChange(configId, itemKey, callback)` — item-scoped.
   */
  onChange(
    callbackOrConfigId: string | ((event: ConfigChangeEvent) => void),
    callbackOrItemKey?: string | ((event: ConfigChangeEvent) => void),
    callback?: (event: ConfigChangeEvent) => void,
  ): void {
    if (typeof callbackOrConfigId === "function") {
      this._listeners.push({ callback: callbackOrConfigId, configId: null, itemKey: null });
    } else if (typeof callbackOrItemKey === "function") {
      this._listeners.push({
        callback: callbackOrItemKey,
        configId: callbackOrConfigId,
        itemKey: null,
      });
    } else if (typeof callbackOrItemKey === "string" && callback) {
      this._listeners.push({ callback, configId: callbackOrConfigId, itemKey: callbackOrItemKey });
    }
  }

  /** @internal — re-apply in-memory seeds for bound configs not yet present server-side. */
  private _mergePendingSeeds(newCache: Record<string, Record<string, unknown>>): void {
    for (const boundId of this._bindings.keys()) {
      if (!(boundId in newCache)) {
        newCache[boundId] = this._resolveBoundChain(boundId);
      }
    }
  }

  /** @internal */
  private async _doRefresh(source: "websocket" | "manual" | "initial"): Promise<void> {
    const configs = await this._fetchAllConfigs();
    const newCache: Record<string, Record<string, unknown>> = {};
    for (const cfg of configs) {
      const chain = await cfg._buildChain(configs);
      newCache[cfg.id!] = resolveChain(chain, this._environment);
    }
    this._mergePendingSeeds(newCache);
    const oldCache = this._configCache;
    this._configCache = newCache;
    this._rawConfigCache = {};
    for (const cfg of configs) this._rawConfigCache[cfg.id!] = cfg;
    this._fireChangeListeners(oldCache, newCache, source === "initial" ? "manual" : source);
  }

  /** @internal — re-resolve every config in `rawCache` and fire change listeners. */
  private async _rebuildResolvedCache(
    rawCache: Record<string, Config>,
    source: "websocket" | "manual",
  ): Promise<void> {
    const rawList = Object.values(rawCache);
    const newCache: Record<string, Record<string, unknown>> = {};
    for (const [cfgId, cfg] of Object.entries(rawCache)) {
      const chain = await cfg._buildChain(rawList);
      newCache[cfgId] = resolveChain(chain, this._environment);
    }
    this._mergePendingSeeds(newCache);
    const oldCache = this._configCache;
    this._configCache = newCache;
    this._rawConfigCache = rawCache;
    this._fireChangeListeners(oldCache, newCache, source);
  }

  /** @internal */
  private _fireChangeListeners(
    oldCache: Record<string, Record<string, unknown>>,
    newCache: Record<string, Record<string, unknown>>,
    source: "websocket" | "manual",
  ): void {
    const allConfigKeys = new Set([...Object.keys(oldCache), ...Object.keys(newCache)]);
    for (const cfgKey of allConfigKeys) {
      const oldItems = oldCache[cfgKey] ?? {};
      const newItems = newCache[cfgKey] ?? {};
      const allItemKeys = new Set([...Object.keys(oldItems), ...Object.keys(newItems)]);
      const target = this._bindings.get(cfgKey);
      for (const iKey of allItemKeys) {
        const oldVal = iKey in oldItems ? oldItems[iKey] : null;
        const newVal = iKey in newItems ? newItems[iKey] : null;
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          // Apply to bound target first so listeners reading the object see
          // the new value.
          if (target !== undefined) {
            applyChangeToTarget(target, iKey, newVal);
          }
          const metrics = this._metrics;
          if (metrics) {
            metrics.record("config.changes", 1, "changes", { config: cfgKey });
          }
          const event = new ConfigChangeEvent({
            configId: cfgKey,
            itemKey: iKey,
            oldValue: oldVal,
            newValue: newVal,
            source,
          });
          for (const listener of this._listeners) {
            if (listener.configId !== null && listener.configId !== cfgKey) continue;
            if (listener.itemKey !== null && listener.itemKey !== iKey) continue;
            try {
              listener.callback(event);
            } catch {
              // ignore listener errors
            }
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal: event handlers (called by SharedWebSocket)
  // ------------------------------------------------------------------

  private _handleConfigChanged = (data: Record<string, any>): void => {
    debug("websocket", `config_changed event received: ${JSON.stringify(data)}`);
    const key = data.id as string | undefined;
    if (!key) {
      this._handleConfigsChanged(data);
      return;
    }
    const rawCache = { ...this._rawConfigCache };
    void this._fetchSingleConfig(key)
      .then((cfg) => {
        if (cfg === null) return;
        rawCache[key] = cfg;
        return this._rebuildResolvedCache(rawCache, "websocket");
      })
      .catch((err: unknown) => {
        debug(
          "websocket",
          `config_changed handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  private _handleConfigDeleted = (data: Record<string, any>): void => {
    debug("websocket", `config_deleted event received: ${JSON.stringify(data)}`);
    const key = data.id as string | undefined;
    if (!key) {
      this._handleConfigsChanged(data);
      return;
    }
    if (!(key in this._rawConfigCache)) return;
    const rawCache = { ...this._rawConfigCache };
    delete rawCache[key];
    void this._rebuildResolvedCache(rawCache, "websocket").catch((err: unknown) => {
      debug(
        "websocket",
        `config_deleted handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  private _handleConfigsChanged = (_data: Record<string, any>): void => {
    debug("websocket", `configs_changed event received`);
    void this._doRefresh("websocket").catch(() => {
      // ignore refresh errors from WebSocket events
    });
  };

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Release resources — only those this client owns.
   *
   * Tears down the owned WebSocket (opened by a standalone client on first
   * live use). A wired client borrows the parent's transport and WebSocket and
   * closes neither.
   */
  close(): void {
    if (this._ownsWs && this._wsManager !== null) {
      this._wsManager.stop();
      this._wsManager = null;
      this._ownsWs = false;
    }
  }
}

// Referenced for behavior parity; not otherwise used in this module.
void ConfigEnvironment;
