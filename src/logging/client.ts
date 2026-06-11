/**
 * The Smpl Logging client — one unified `LoggingClient`.
 *
 * Smpl Logging has two surfaces on a single client, mirroring how the config,
 * flags, audit, and jobs clients expose their full surface from one class:
 *
 * - **Management surface** — works immediately, no {@link LoggingClient.install}
 *   required. Two sub-clients (the audit pattern):
 *
 *   - `client.logging.loggers` — logger CRUD + discovery: `new` / `list` /
 *     `get` / `delete` plus `register` / `flush` / `pendingCount`.
 *   - `client.logging.logGroups` — log-group CRUD: `new` / `list` / `get` /
 *     `delete`.
 *
 *   The fused client owns the logger-discovery buffer directly; the `loggers`
 *   sub-client shares that same buffer so discovery and explicit registration
 *   drain through one queue.
 *
 * - **Live surface** — directly on the client. {@link LoggingClient.registerAdapter}
 *   is a PRE-install configuration call (allowed before
 *   {@link LoggingClient.install}). {@link LoggingClient.install} opens the live
 *   connection (monkey-patches the app's logging framework, discovers loggers,
 *   fetches + applies levels, opens the shared WebSocket). `onChange` /
 *   `refresh` require {@link LoggingClient.install} first; calling them earlier
 *   throws {@link SmplNotInstalledError}.
 *
 * The client supports two construction shapes:
 *
 * - **Wired** into {@link SmplClient} — borrows the parent's logging transport
 *   for both runtime fetch and CRUD and the parent's shared WebSocket for the
 *   live channel. This is the common path.
 * - **Standalone** — `new LoggingClient({ apiKey, baseUrl, ... })` builds and
 *   owns its own logging transport (the WebSocket gateway lives on the app
 *   service), and on {@link LoggingClient.install} opens and owns its own
 *   WebSocket. `close()` tears down only the owned transport and owned
 *   WebSocket.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/logging.d.ts";
import {
  SmplkitError,
  SmplkitConflictError,
  SmplkitConnectionError,
  SmplkitNotFoundError,
  SmplkitNotInstalledError,
  SmplkitTimeoutError,
  SmplkitValidationError,
  throwForStatus,
} from "../errors.js";
import { resolveManagementConfig, serviceUrl } from "../config.js";
import { Logger, LogGroup } from "./models.js";
import { LogLevel, LoggerChangeEvent, LoggerSource, loggerEnvironmentsToWire } from "./types.js";
import { resolveLevel, type GroupCacheEntry, type LoggerCacheEntry } from "./_resolution.js";
import type { LoggingAdapter } from "./adapters/base.js";
import type { MetricsReporter } from "../_metrics.js";
import { SharedWebSocket } from "../ws.js";
import { debug } from "../_debug.js";
import { keyToDisplayName } from "../helpers.js";

type LoggingHttp = ReturnType<typeof createClient<import("../generated/logging.d.ts").paths>>;

/** @internal — the owning {@link SmplClient} interface the wired client borrows. */
export interface LoggingParent {
  readonly _environment: string;
  readonly _service: string | null;
  _ensureStarted(): void;
  _ensureWs(): SharedWebSocket;
}

const DEFAULT_LOGGING_BASE_URL = "https://logging.smplkit.com";

/** Flush the discovery buffer once it reaches this many pending loggers. */
const LOGGER_BATCH_FLUSH_SIZE = 50;

const NOT_INSTALLED_MESSAGE =
  "Smpl Logging live operations require install() first — this opens a live " +
  "connection to your running service and hooks into your application's " +
  "logging framework. Call client.logging.install() before onChange()/refresh().";

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

// ---------------------------------------------------------------------------
// Resource → model conversion (shared by management sub-clients)
// ---------------------------------------------------------------------------

/** @internal */
function resourceToLogger(
  resource: components["schemas"]["LoggerResource"],
  client: LoggersClient,
): Logger {
  const attrs = resource.attributes;
  const sources = Array.isArray(attrs.sources) ? (attrs.sources as Array<Record<string, any>>) : [];
  return new Logger(client, {
    id: resource.id ?? null,
    name: attrs.name ?? "",
    level: (attrs.level as LogLevel | null) ?? null,
    group: attrs.group ?? null,
    managed: attrs.managed ?? null,
    sources,
    environments: attrs.environments as Record<string, unknown> | null,
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

/** @internal */
function resourceToLogGroup(
  resource: components["schemas"]["LogGroupResource"],
  client: LogGroupsClient,
): LogGroup {
  const attrs = resource.attributes as Record<string, unknown>;
  return new LogGroup(client, {
    id: resource.id ?? null,
    name: (attrs.name as string | undefined) ?? "",
    level: ((attrs.level as string) || null) as LogLevel | null,
    group: (attrs.parent_id as string | null | undefined) ?? null,
    environments: attrs.environments as Record<string, unknown> | null,
    createdAt: (attrs.created_at as string | null | undefined) ?? null,
    updatedAt: (attrs.updated_at as string | null | undefined) ?? null,
  });
}

/** @internal */
function loggerToBody(logger: Logger): {
  data: { id: string | null; type: "logger"; attributes: components["schemas"]["Logger"] };
} {
  const attrs: components["schemas"]["Logger"] = {
    name: logger.name,
  };
  if (logger.level !== null) attrs.level = logger.level;
  if (logger.group !== null) attrs.group = logger.group;
  if (logger.managed !== null) attrs.managed = logger.managed;
  // Always send `environments` — even when empty — so a clearLevel
  // that drains the last override actually reaches the server. Omitting
  // the field is interpreted by the JSON:API put as "no change," which
  // strands the local clear in client memory only.
  attrs.environments = loggerEnvironmentsToWire(
    logger._environmentsDirect,
  ) as typeof attrs.environments;
  return {
    data: { id: logger.id, type: "logger", attributes: attrs },
  };
}

/** @internal Shared attribute payload for create + update. */
function groupAttrs(group: LogGroup): components["schemas"]["LogGroup"] {
  const attrs: components["schemas"]["LogGroup"] = {
    name: group.name,
  };
  if (group.level !== null) attrs.level = group.level;
  if (group.group !== null) (attrs as Record<string, unknown>).parent_id = group.group;
  const wire = loggerEnvironmentsToWire(group._environmentsDirect);
  if (Object.keys(wire).length > 0) {
    attrs.environments = wire as typeof attrs.environments;
  }
  return attrs;
}

/**
 * Build the JSON:API request body for `POST /api/v1/log_groups` (create).
 *
 * The create envelope requires `data.id` to be a non-null string — the
 * log-group key is caller-supplied. Update has its own builder because
 * the update envelope keeps `id` optional/nullable.
 * @internal
 */
function groupToCreateBody(group: LogGroup): components["schemas"]["LogGroupCreateRequest"] {
  /* v8 ignore start — defensive guard: `LogGroup.id` is always set by the
     `logGroups.new(id, ...)` factory, the only public path that reaches
     `_createGroup`. Spec narrowing requires a non-null `data.id`. */
  if (group.id === null) {
    throw new SmplkitValidationError("Cannot create a LogGroup without an id");
  }
  /* v8 ignore stop */
  return {
    data: { id: group.id, type: "log_group", attributes: groupAttrs(group) },
  };
}

/** @internal Build the JSON:API request body for `PUT /api/v1/log_groups/{id}` (update). */
function groupToUpdateBody(group: LogGroup): components["schemas"]["LogGroupRequest"] {
  return {
    data: { id: group.id ?? null, type: "log_group", attributes: groupAttrs(group) },
  };
}

// ---------------------------------------------------------------------------
// Logger-discovery buffer (owned by the fused client, shared with `loggers`)
// ---------------------------------------------------------------------------

interface LoggerBufferEntry {
  id: string;
  level: string;
  resolved_level: string;
  service?: string;
  environment?: string;
}

/** @internal — deduplicates and batches logger registrations for bulk upload. */
export class LoggerRegistrationBuffer {
  private _seen = new Set<string>();
  private _pending: LoggerBufferEntry[] = [];

  add(
    id: string,
    level: string,
    resolvedLevel: string,
    service: string | null,
    environment: string | null,
  ): void {
    if (this._seen.has(id)) return;
    this._seen.add(id);
    const item: LoggerBufferEntry = { id, level, resolved_level: resolvedLevel };
    if (service) item.service = service;
    if (environment) item.environment = environment;
    this._pending.push(item);
  }

  drain(): LoggerBufferEntry[] {
    const batch = this._pending;
    this._pending = [];
    return batch;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

// ---------------------------------------------------------------------------
// Adapter auto-loading
// ---------------------------------------------------------------------------

/** Auto-load built-in adapters by attempting to require each framework. @internal */
function autoLoadAdapters(): LoggingAdapter[] {
  const adapters: LoggingAdapter[] = [];
  const builtins = [
    { module: "./adapters/winston.js", className: "WinstonAdapter" },
    { module: "./adapters/pino.js", className: "PinoAdapter" },
  ];
  for (const { module: mod, className } of builtins) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require(mod);
      const AdapterClass = m[className];
      adapters.push(new AdapterClass());
    } catch {
      // Dependency not installed — skip
    }
  }
  if (adapters.length === 0) {
    console.warn(
      "[smplkit] No logging framework detected. Runtime logging control requires a supported framework (winston, pino).",
    );
  }
  return adapters;
}

// ---------------------------------------------------------------------------
// Management sub-client: loggers
// ---------------------------------------------------------------------------

/**
 * Surface for `client.logging.loggers.*`.
 *
 * Logger CRUD plus the discovery buffer. The buffer is owned by the fused
 * {@link LoggingClient} and shared here so discovery (driven by
 * {@link LoggingClient.install}) and explicit {@link register} drain through
 * one queue.
 */
export class LoggersClient {
  /** @internal */
  constructor(
    private readonly _http: LoggingHttp,
    private readonly _buffer: LoggerRegistrationBuffer,
  ) {}

  /** Buffer logger sources for registration; optionally flush immediately. */
  async register(
    items: LoggerSource | LoggerSource[],
    options: { flush?: boolean } = {},
  ): Promise<void> {
    const batch = Array.isArray(items) ? items : [items];
    for (const src of batch) {
      this._buffer.add(
        src.name,
        src.level ?? src.resolvedLevel,
        src.resolvedLevel,
        src.service,
        src.environment,
      );
    }
    if (options.flush) {
      await this.flush();
      return;
    }
    if (this._buffer.pendingCount >= LOGGER_BATCH_FLUSH_SIZE) {
      void this.flush();
    }
  }

  /** Drain the buffer and POST pending logger sources to the bulk endpoint. */
  async flush(): Promise<void> {
    const batch = this._buffer.drain();
    if (batch.length === 0) return;
    try {
      await this._http.POST("/api/v1/loggers/bulk", { body: { loggers: batch } });
    } catch {
      // ignore — periodic flush will retry
    }
  }

  /** Number of sources queued and awaiting flush. */
  get pendingCount(): number {
    return this._buffer.pendingCount;
  }

  /** Return a new unsaved {@link Logger}. Call {@link Logger.save} to persist. */
  new(id: string, options: { managed?: boolean } = {}): Logger {
    return new Logger(this, {
      id,
      name: id,
      level: null,
      group: null,
      managed: options.managed ?? true,
      sources: [],
      environments: null,
      createdAt: null,
      updatedAt: null,
    });
  }

  /** List loggers for the authenticated account. */
  async list(params: { pageNumber?: number; pageSize?: number } = {}): Promise<Logger[]> {
    const query: Record<string, number> = {};
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    let data: components["schemas"]["LoggerListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/loggers", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToLogger(r, this));
  }

  /** Fetch the editable {@link Logger} resource by id. */
  async get(id: string): Promise<Logger> {
    let data: components["schemas"]["LoggerResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/loggers/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitNotFoundError(`Logger with id ${JSON.stringify(id)} not found`);
    }
    return resourceToLogger(data.data, this);
  }

  /** Delete a logger by id. */
  async delete(id: string): Promise<void> {
    return this._deleteLogger(id);
  }

  /** @internal — called by `Logger.delete()`. */
  async _deleteLogger(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/loggers/{id}", {
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

  /** @internal — called by `Logger.save()`. PUT /loggers/{id} is upsert. */
  async _saveLogger(logger: Logger): Promise<Logger> {
    if (logger.id === null) throw new Error("Cannot save a Logger with no id");
    const body = loggerToBody(logger);
    let data: components["schemas"]["LoggerResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/loggers/{id}", {
        params: { path: { id: logger.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplkitValidationError("Failed to save logger");
    return resourceToLogger(data.data, this);
  }
}

// ---------------------------------------------------------------------------
// Management sub-client: log groups
// ---------------------------------------------------------------------------

/** Surface for `client.logging.logGroups.*`. */
export class LogGroupsClient {
  /** @internal */
  constructor(private readonly _http: LoggingHttp) {}

  /** Return a new unsaved {@link LogGroup}. Call {@link LogGroup.save} to persist. */
  new(id: string, options: { name?: string; group?: string } = {}): LogGroup {
    return new LogGroup(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      group: options.group ?? null,
      level: null,
      environments: null,
      createdAt: null,
      updatedAt: null,
    });
  }

  /** List log groups for the authenticated account. */
  async list(params: { pageNumber?: number; pageSize?: number } = {}): Promise<LogGroup[]> {
    const query: Record<string, number> = {};
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    let data: components["schemas"]["LogGroupListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/log_groups", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToLogGroup(r, this));
  }

  /** Fetch the editable {@link LogGroup} resource by id. */
  async get(id: string): Promise<LogGroup> {
    let data: components["schemas"]["LogGroupResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/log_groups/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitNotFoundError(`LogGroup with id ${JSON.stringify(id)} not found`);
    }
    return resourceToLogGroup(data.data, this);
  }

  /** Delete a log group by id. */
  async delete(id: string): Promise<void> {
    return this._deleteGroup(id);
  }

  /** @internal — called by `LogGroup.delete()`. */
  async _deleteGroup(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/log_groups/{id}", {
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

  /**
   * @internal — called by `LogGroup.save()` for new groups.
   * POST /api/v1/log_groups creates a new log group. The {id} PUT endpoint
   * is update-only on the server and returns 404 for non-existent ids,
   * so create and update have to dispatch to different endpoints.
   */
  async _createGroup(group: LogGroup): Promise<LogGroup> {
    const body = groupToCreateBody(group);
    let data: components["schemas"]["LogGroupResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/log_groups", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplkitValidationError("Failed to create log group");
    return resourceToLogGroup(data.data, this);
  }

  /** @internal — called by `LogGroup.save()` for existing groups. */
  async _updateGroup(group: LogGroup): Promise<LogGroup> {
    if (group.id === null) throw new Error("Cannot update a LogGroup with no id");
    const body = groupToUpdateBody(group);
    let data: components["schemas"]["LogGroupResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/log_groups/{id}", {
        params: { path: { id: group.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitValidationError(`Failed to update log group ${group.id}`);
    }
    return resourceToLogGroup(data.data, this);
  }
}

/** Configuration options for the {@link LoggingClient}. */
export interface LoggingClientOptions {
  /** API key. When omitted, resolved from `SMPLKIT_API_KEY` or `~/.smplkit`. */
  apiKey?: string;
  /**
   * Deployment environment used to resolve runtime levels and to scope
   * discovery declarations. Optional.
   */
  environment?: string;
  /**
   * Full logging-service base URL. Usually resolved from `baseDomain`/`scheme`;
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
  parent?: LoggingParent;
  /**
   * Internal — a pre-built logging transport supplied by a top-level client so
   * the logging surface shares one connection pool. Not for direct use.
   * @internal
   */
  transport?: LoggingHttp;
  /**
   * Internal — the parent's metrics reporter.
   * @internal
   */
  metrics?: MetricsReporter | null;
}

/**
 * The Smpl Logging client.
 *
 * One client exposes the full surface, reachable as `client.logging`
 * ({@link SmplClient}) or constructed directly:
 *
 * @example
 * ```typescript
 * import { LoggingClient } from "@smplkit/sdk";
 *
 * const logging = new LoggingClient({ environment: "production" });
 * await logging.loggers.new("sqlalchemy.engine").save();
 * await logging.install();
 * ```
 *
 * The management surface (`loggers` / `logGroups` sub-clients) works
 * immediately. {@link registerAdapter} is a pre-install configuration call.
 * The live surface (`install` / `onChange` / `refresh`) requires
 * {@link install} first; calling `onChange` / `refresh` earlier throws
 * {@link SmplNotInstalledError}.
 */
export class LoggingClient {
  loggers: LoggersClient;
  logGroups: LogGroupsClient;

  /** @internal */
  private readonly _http: LoggingHttp;
  /** @internal */
  private readonly _loggingBaseUrl: string;
  /** @internal */
  private readonly _parent: LoggingParent | null;
  /** @internal */
  private readonly _metrics: MetricsReporter | null;
  /** @internal */
  private readonly _environment: string;
  /** @internal */
  private readonly _service: string | null;

  /** @internal — owned discovery buffer (no management delegation). */
  readonly _buffer = new LoggerRegistrationBuffer();

  // Standalone-only WebSocket state.
  private readonly _appBaseUrl: string | null;
  private readonly _standaloneApiKey: string | null;
  private _wsManager: SharedWebSocket | null = null;
  private _ownsWs = false;

  // Live-surface state.
  private _connected = false;
  private _globalListeners: Array<(event: LoggerChangeEvent) => void> = [];
  private _keyListeners: Map<string, Array<(event: LoggerChangeEvent) => void>> = new Map();
  private _adapters: LoggingAdapter[] = [];
  private _loggerFlushTimer: ReturnType<typeof setInterval> | null = null;

  // Caches consulted by the resolution algorithm. The runtime client mutates
  // these from install(), refresh(), and the WebSocket handlers; resolveLevel
  // reads them on every apply.
  private _loggersCache: Record<string, LoggerCacheEntry> = {};
  private _groupsCache: Record<string, GroupCacheEntry> = {};
  // Resolved-level snapshot, used to decide whether to fire change listeners.
  // Keyed by logger id; storing the *resolved* level (not raw `logger.level`)
  // means a group-driven level shift fires listeners even when the logger's
  // own level is untouched.
  private _resolvedLevelStore: Record<string, string> = {};
  // Adapter-known logger names. The adapter knows loggers by their original
  // name (e.g. `com.acme.payments`); the cache is keyed by the same string
  // since the TypeScript SDK does not normalize.
  private _knownLoggerNames = new Set<string>();

  constructor(options: LoggingClientOptions = {}) {
    this._parent = options.parent ?? null;
    this._metrics = options.metrics ?? null;
    this._environment = options.parent?._environment ?? options.environment ?? "";
    this._service = options.parent?._service ?? null;

    if (options.transport !== undefined) {
      this._http = options.transport;
      this._loggingBaseUrl = DEFAULT_LOGGING_BASE_URL;
      this._appBaseUrl = null;
      this._standaloneApiKey = null;
    } else {
      const cfg = resolveManagementConfig(options);
      const loggingUrl =
        options.baseUrl ??
        serviceUrl(cfg.scheme, "logging", cfg.baseDomain) ??
        DEFAULT_LOGGING_BASE_URL;
      this._loggingBaseUrl = loggingUrl.replace(/\/+$/, "");
      this._appBaseUrl = serviceUrl(cfg.scheme, "app", cfg.baseDomain);
      this._standaloneApiKey = options.apiKey ?? cfg.apiKey;
      const ms = options.timeout ?? 30_000;
      this._http = createClient<import("../generated/logging.d.ts").paths>({
        baseUrl: this._loggingBaseUrl,
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

    // Discovery buffer is owned by this client; the loggers sub-client shares
    // it so discovery and explicit registration drain together.
    this.loggers = new LoggersClient(this._http, this._buffer);
    this.logGroups = new LogGroupsClient(this._http);
  }

  // ------------------------------------------------------------------
  // Adapter registration (pre-install, ungated)
  // ------------------------------------------------------------------

  /**
   * Register a logging adapter. Must be called before install().
   *
   * If called at least once, auto-loading is disabled — only explicitly
   * registered adapters are used. This is a pre-install configuration call:
   * it is intentionally NOT gated by {@link install}.
   */
  registerAdapter(adapter: LoggingAdapter): void {
    if (this._connected) {
      throw new Error("Cannot register adapters after install()");
    }
    this._adapters.push(adapter);
  }

  // ------------------------------------------------------------------
  // Live surface: install (gate) + transport / WebSocket helpers
  // ------------------------------------------------------------------

  /** @internal */
  private _requireInstalled(): void {
    if (!this._connected) {
      throw new SmplkitNotInstalledError(NOT_INSTALLED_MESSAGE);
    }
  }

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
   * Hook smplkit into the application's logging machinery.
   *
   * Loads adapters, scans existing loggers, applies levels from the smplkit
   * server, and wires WebSocket handlers for live updates. This IS the
   * explicit consent gate — {@link onChange} / {@link refresh} require it
   * first.
   *
   * Idempotent — safe to call multiple times.
   */
  async install(): Promise<void> {
    debug("lifecycle", "LoggingClient.install() called");
    if (this._parent !== null) {
      this._parent._ensureStarted();
    }
    if (this._connected) return;

    // 0. Load adapters
    if (this._adapters.length === 0) {
      this._adapters = autoLoadAdapters();
    }

    // 1. Discover existing loggers from all adapters
    let discoveredCount = 0;
    for (const adapter of this._adapters) {
      try {
        const existing = adapter.discover();
        debug(
          "discovery",
          `adapter '${adapter.name}' discovered ${existing.length} existing loggers`,
        );
        for (const { name, level } of existing) {
          this._knownLoggerNames.add(name);
          await this.loggers.register(this._loggerSourceFor(name, level, level));
          discoveredCount++;
        }
      } catch {
        // ignore adapter discovery errors
      }
    }

    // 2. Install continuous discovery hooks
    for (const adapter of this._adapters) {
      try {
        adapter.installHook((name: string, level: string) => {
          this._onNewLogger(name, level);
        });
      } catch {
        // ignore hook installation errors
      }
    }

    // Record discovery metric
    if (discoveredCount > 0) {
      const metrics = this._metrics;
      if (metrics) {
        metrics.record("logging.loggers_discovered", discoveredCount, "loggers");
      }
    }

    // 3. Flush initial batch
    await this.loggers.flush();

    // 4-6. Fetch, resolve, apply
    try {
      const [serverLoggers, serverGroups] = await Promise.all([
        this._listLoggers(),
        this._listLogGroups(),
      ]);
      this._loggersCache = this._buildLoggersCache(serverLoggers);
      this._groupsCache = this._buildGroupsCache(serverGroups);
      this._applyLevels();
    } catch {
      // Server may be unreachable — continue with WebSocket wiring
    }

    // 7. Register WebSocket event handlers for real-time level updates
    this._wsManager = this._ensureWs();
    this._wsManager.on("logger_changed", this._handleLoggerChanged);
    this._wsManager.on("logger_deleted", this._handleLoggerDeleted);
    this._wsManager.on("group_changed", this._handleGroupChanged);
    this._wsManager.on("group_deleted", this._handleGroupDeleted);
    this._wsManager.on("loggers_changed", this._handleLoggersChanged);

    // 8. Start periodic flush timer for post-startup logger discovery
    //    (unref so it doesn't pin the event loop).
    this._loggerFlushTimer = setInterval(() => {
      void this.loggers.flush();
    }, 30_000);
    if (typeof this._loggerFlushTimer === "object" && "unref" in this._loggerFlushTimer) {
      (this._loggerFlushTimer as NodeJS.Timeout).unref();
    }

    this._connected = true;
  }

  // ------------------------------------------------------------------
  // Live surface: change listeners
  // ------------------------------------------------------------------

  /**
   * Register a change listener.
   *
   * - `onChange(callback)` — registers a global listener.
   * - `onChange("sqlalchemy.engine", callback)` — registers a key-scoped listener.
   *
   * Requires {@link install} first; throws {@link SmplNotInstalledError}
   * otherwise.
   */
  onChange(
    callbackOrKey: string | ((event: LoggerChangeEvent) => void),
    callback?: (event: LoggerChangeEvent) => void,
  ): void {
    this._requireInstalled();
    if (typeof callbackOrKey === "function") {
      this._globalListeners.push(callbackOrKey);
    } else {
      const key = callbackOrKey;
      if (!callback) {
        throw new SmplkitError("onChange(key, callback) requires a callback function.");
      }
      if (!this._keyListeners.has(key)) {
        this._keyListeners.set(key, []);
      }
      this._keyListeners.get(key)!.push(callback);
    }
  }

  /**
   * Re-fetch all loggers and groups and fire listener events for any deltas.
   *
   * Requires {@link install} first; throws {@link SmplNotInstalledError}
   * otherwise.
   */
  async refresh(): Promise<void> {
    this._requireInstalled();
    debug("resolution", "refresh() called, triggering full resolution pass");
    await this._resolveAndFire("manual");
  }

  // ------------------------------------------------------------------
  // Internal: management-plane delegation (paged list helpers)
  // ------------------------------------------------------------------

  /**
   * @internal — fetch the full logger list.
   *
   * Pages through the server until a short page (less than the requested
   * size) is returned — accounts with more than 1000 loggers would
   * otherwise silently lose everything past page one.
   */
  private async _listLoggers(): Promise<Logger[]> {
    const PAGE_SIZE = 1000;
    const all: Logger[] = [];
    let page = 1;
    let lastPageWasFull = true;
    while (lastPageWasFull) {
      const rows = await this.loggers.list({ pageNumber: page, pageSize: PAGE_SIZE });
      all.push(...rows);
      lastPageWasFull = rows.length === PAGE_SIZE;
      page++;
    }
    return all;
  }

  /** @internal — see {@link _listLoggers}. */
  private async _listLogGroups(): Promise<LogGroup[]> {
    const PAGE_SIZE = 1000;
    const all: LogGroup[] = [];
    let page = 1;
    let lastPageWasFull = true;
    while (lastPageWasFull) {
      const rows = await this.logGroups.list({ pageNumber: page, pageSize: PAGE_SIZE });
      all.push(...rows);
      lastPageWasFull = rows.length === PAGE_SIZE;
      page++;
    }
    return all;
  }

  // ------------------------------------------------------------------
  // Internal: adapter helpers
  // ------------------------------------------------------------------

  /**
   * Refresh resolved levels and apply them to adapter-known loggers.
   *
   * Walks every adapter-known logger name through {@link resolveLevel}
   * (env override → base → group chain → dot-notation ancestry → fallback)
   * and pushes the result to every registered adapter. Loggers whose own
   * `level` is `null` are still applied — that's the whole point of group
   * inheritance and dot-notation ancestry.
   *
   * The resolved-level snapshot lives in `_resolvedLevelStore` so callers
   * can diff pre-vs-post and fire change listeners on actual effective-
   * level deltas. The store is scoped to adapter-known names: listener
   * fanout pairs 1:1 with `adapter.applyLevel` calls, so a logger that
   * the adapter doesn't know about has no apply and no listener fire.
   * @internal
   */
  private _applyLevels(): void {
    const environment = this._environment;
    const newResolved: Record<string, string> = {};

    for (const name of this._knownLoggerNames) {
      newResolved[name] = resolveLevel(name, environment, this._loggersCache, this._groupsCache);
    }
    this._resolvedLevelStore = newResolved;

    for (const name of this._knownLoggerNames) {
      const resolved = newResolved[name]!;

      const metrics = this._metrics;
      if (metrics) {
        metrics.record("logging.level_changes", 1, "changes", { logger: name });
      }

      for (const adapter of this._adapters) {
        try {
          debug("adapter", `setLevel(${name}, ${resolved})`);
          adapter.applyLevel(name, resolved);
        } catch {
          // ignore adapter errors
        }
      }
    }
  }

  /** @internal Convert a server Logger list into the resolution cache. */
  private _buildLoggersCache(loggers: Logger[]): Record<string, LoggerCacheEntry> {
    const out: Record<string, LoggerCacheEntry> = {};
    for (const l of loggers) {
      if (l.id === null) continue;
      out[l.id] = this._loggerToCacheEntry(l);
    }
    return out;
  }

  /** @internal Convert a server LogGroup list into the resolution cache. */
  private _buildGroupsCache(groups: LogGroup[]): Record<string, GroupCacheEntry> {
    const out: Record<string, GroupCacheEntry> = {};
    for (const g of groups) {
      if (g.id === null) continue;
      out[g.id] = this._groupToCacheEntry(g);
    }
    return out;
  }

  /** @internal */
  private _loggerToCacheEntry(l: Logger): LoggerCacheEntry {
    return {
      level: l.level ?? null,
      group: l.group ?? null,
      managed: l.managed ?? null,
      environments: (l.environments ?? null) as LoggerCacheEntry["environments"],
    };
  }

  /** @internal */
  private _groupToCacheEntry(g: LogGroup): GroupCacheEntry {
    return {
      level: g.level ?? null,
      group: g.group ?? null,
      environments: (g.environments ?? null) as GroupCacheEntry["environments"],
    };
  }

  /** Build a LoggerSource from an adapter's (name, level, resolved) discovery tuple. @internal */
  private _loggerSourceFor(name: string, level: string, resolved: string): LoggerSource {
    return new LoggerSource(name, {
      resolvedLevel: resolved as LogLevel,
      level: level as LogLevel,
      service: this._service,
      environment: this._environment || null,
    });
  }

  /** Called by adapter hooks when a new logger is created in the framework. @internal */
  private _onNewLogger(name: string, level: string): void {
    debug("discovery", `new logger intercepted at runtime: ${name}`);
    this._buffer.add(name, level, level, this._service, this._environment || null);
    this._knownLoggerNames.add(name);

    if (this._buffer.pendingCount >= LOGGER_BATCH_FLUSH_SIZE) {
      void this.loggers.flush();
    }

    // If we're already started, apply an immediate resolved level for this
    // newly-discovered name. Without this, the framework's local default
    // would persist until the next refresh / ws event.
    if (this._connected) {
      const resolved = resolveLevel(name, this._environment, this._loggersCache, this._groupsCache);
      this._resolvedLevelStore[name] = resolved;
      for (const adapter of this._adapters) {
        try {
          adapter.applyLevel(name, resolved);
        } catch {
          // ignore adapter errors
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal: WebSocket handlers (called by SharedWebSocket)
  // ------------------------------------------------------------------

  private _handleLoggerChanged = (data: Record<string, any>): void => {
    debug("websocket", `logger_changed event received: ${JSON.stringify(data)}`);
    const id = data.id as string | undefined;
    if (!id) return;
    // Scoped fetch: GET /loggers/{key}
    void this._fetchSingleLogger(id)
      .then((logger) => {
        const preResolved = { ...this._resolvedLevelStore };
        if (logger !== null) {
          this._loggersCache[id] = this._loggerToCacheEntry(logger);
        } else {
          delete this._loggersCache[id];
        }
        this._applyLevels();
        this._fireDeltas(preResolved, this._resolvedLevelStore, "websocket");
      })
      .catch((err: unknown) => {
        debug(
          "websocket",
          `logger_changed handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  private _handleLoggerDeleted = (data: Record<string, any>): void => {
    debug("websocket", `logger_deleted event received: ${JSON.stringify(data)}`);
    const id = data.id as string | undefined;
    if (!id) return;
    delete this._loggersCache[id];
    const preResolved = { ...this._resolvedLevelStore };
    this._applyLevels();
    // Pure cache eviction for the deleted id; dependent loggers that
    // re-resolve fire through the normal apply path. The deleted id
    // itself fires nothing, even if it was adapter-known and its
    // resolved level moved (e.g. fell back to INFO).
    this._fireDeltas(preResolved, this._resolvedLevelStore, "websocket", new Set([id]));
  };

  private _handleGroupChanged = (data: Record<string, any>): void => {
    debug("websocket", `group_changed event received: ${JSON.stringify(data)}`);
    const id = data.id as string | undefined;
    if (!id) return;
    // Scoped fetch: GET /log_groups/{key}
    void this._fetchSingleGroup(id)
      .then((group) => {
        const preResolved = { ...this._resolvedLevelStore };
        if (group !== null) {
          this._groupsCache[id] = this._groupToCacheEntry(group);
        } else {
          delete this._groupsCache[id];
        }
        // Re-resolve every adapter-known logger; some may now inherit from
        // this group via direct membership or through a parent group chain.
        this._applyLevels();
        this._fireDeltas(preResolved, this._resolvedLevelStore, "websocket");
      })
      .catch((err: unknown) => {
        debug(
          "websocket",
          `group_changed handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  private _handleGroupDeleted = (data: Record<string, any>): void => {
    debug("websocket", `group_deleted event received: ${JSON.stringify(data)}`);
    const id = data.id as string | undefined;
    if (!id) return;
    delete this._groupsCache[id];
    const preResolved = { ...this._resolvedLevelStore };
    this._applyLevels();
    // Pure cache eviction for the group id; dependent loggers that
    // re-resolve to a different effective level fire through the normal
    // apply path. The deleted id itself fires nothing.
    this._fireDeltas(preResolved, this._resolvedLevelStore, "websocket", new Set([id]));
  };

  private _handleLoggersChanged = (_data: Record<string, any>): void => {
    debug("websocket", `loggers_changed event received`);
    void this._resolveAndFire("websocket").catch(() => {
      // ignore refresh errors from WebSocket events
    });
  };

  /**
   * @internal Fire change listeners for every logger whose effective level
   * changed between `pre` and `post`.
   *
   * Contract:
   *   - Iterates loggers present in `post` (the post-apply resolved store).
   *     A key in `pre` but not in `post` is a cache eviction — that key
   *     itself fires nothing. Dependents that re-resolved to a new value
   *     are still in `post` and fire normally.
   *   - For every changed logger, fires every global listener once with
   *     that logger's own payload (no "summary" event), then fires every
   *     key-scoped listener registered for that id.
   *   - One adapter.applyLevel call ↔ one listener notification per
   *     subscriber. A trigger that moves N loggers fires the global
   *     listener N times, not once.
   *   - `suppressIds` is the deletion-event escape hatch: a deleted id
   *     fires nothing for itself even when its adapter-known resolved
   *     level moved (e.g. fell back to INFO).
   */
  private _fireDeltas(
    pre: Record<string, string>,
    post: Record<string, string>,
    source: "websocket" | "manual",
    suppressIds?: Set<string>,
  ): void {
    for (const id of Object.keys(post)) {
      if (suppressIds?.has(id)) continue;
      const next = post[id]!;
      if (pre[id] === next) continue;
      const event = new LoggerChangeEvent({ id, source, level: next as LogLevel });
      for (const cb of this._globalListeners) {
        try {
          cb(event);
        } catch {
          // ignore listener errors
        }
      }
      const keyCallbacks = this._keyListeners.get(id);
      if (keyCallbacks) {
        for (const cb of keyCallbacks) {
          try {
            cb(event);
          } catch {
            // ignore listener errors
          }
        }
      }
    }
  }

  /**
   * Full refetch of loggers + log_groups, rebuild the caches, re-resolve
   * every adapter-known logger, and fire change listeners on resolved-level
   * deltas. Shared between the `loggers_changed` WS handler and the
   * public `refresh()` method.
   * @internal
   */
  private async _resolveAndFire(source: "websocket" | "manual"): Promise<void> {
    const [serverLoggers, serverGroups] = await Promise.all([
      this._listLoggers(),
      this._listLogGroups(),
    ]);
    debug("resolution", `resolution pass (trigger: ${source})`);
    const preResolved = { ...this._resolvedLevelStore };
    this._loggersCache = this._buildLoggersCache(serverLoggers);
    this._groupsCache = this._buildGroupsCache(serverGroups);
    // Re-resolve from scratch. Drop any prior resolved levels — `_applyLevels`
    // only repopulates entries for the currently-known adapter logger names.
    this._resolvedLevelStore = {};
    this._applyLevels();
    this._fireDeltas(preResolved, this._resolvedLevelStore, source);
  }

  // ------------------------------------------------------------------
  // Internal: single-resource fetchers
  // ------------------------------------------------------------------

  /** Fetch a single logger by key. Returns null if not found. @internal */
  private async _fetchSingleLogger(key: string): Promise<Logger | null> {
    debug("api", `GET /api/v1/loggers/${key}`);
    try {
      const result = await this._http.GET("/api/v1/loggers/{id}", {
        params: { path: { id: key } },
      });
      if (result.error !== undefined) return null;
      if (!result.data?.data) return null;
      return resourceToLogger(result.data.data, this.loggers);
    } catch {
      return null;
    }
  }

  /** Fetch a single log group by key. Returns null if not found. @internal */
  private async _fetchSingleGroup(key: string): Promise<LogGroup | null> {
    debug("api", `GET /api/v1/log_groups/${key}`);
    try {
      const result = await this._http.GET("/api/v1/log_groups/{id}", {
        params: { path: { id: key } },
      });
      if (result.error !== undefined) return null;
      if (!result.data?.data) return null;
      return resourceToLogGroup(result.data.data, this.logGroups);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Release resources — only those this client owns.
   *
   * Uninstalls the adapter hooks, unsubscribes from the WebSocket, and tears
   * down the owned WebSocket (opened by a standalone client on install). A
   * wired client borrows the parent's transport and WebSocket and closes
   * neither.
   */
  close(): void {
    debug("lifecycle", "LoggingClient.close() called");

    // Cancel the periodic flush timer
    if (this._loggerFlushTimer !== null) {
      clearInterval(this._loggerFlushTimer);
      this._loggerFlushTimer = null;
    }

    // Uninstall adapter hooks
    for (const adapter of this._adapters) {
      try {
        adapter.uninstallHook();
      } catch {
        // ignore cleanup errors
      }
    }

    if (this._wsManager !== null) {
      this._wsManager.off("logger_changed", this._handleLoggerChanged);
      this._wsManager.off("logger_deleted", this._handleLoggerDeleted);
      this._wsManager.off("group_changed", this._handleGroupChanged);
      this._wsManager.off("group_deleted", this._handleGroupDeleted);
      this._wsManager.off("loggers_changed", this._handleLoggersChanged);
      if (this._ownsWs) {
        this._wsManager.stop();
        this._ownsWs = false;
      }
      this._wsManager = null;
    }
    this._connected = false;
  }
}

// Referenced for behavior parity; not otherwise used in this module.
void LogLevel;
