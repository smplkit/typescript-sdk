/**
 * LoggingClient — management and runtime for Smpl Logging.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/logging.d.ts";
import {
  SmplConflictError,
  SmplNotFoundError,
  SmplValidationError,
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  throwForStatus,
} from "../errors.js";
import { Logger, LogGroup } from "./models.js";
import { LogLevel, LoggerSource, type LoggerChangeEvent } from "./types.js";
import type { LoggingAdapter } from "./adapters/base.js";
import type { MetricsReporter } from "../_metrics.js";
import { keyToDisplayName } from "../helpers.js";
import type { SharedWebSocket } from "../ws.js";
import { debug } from "../_debug.js";

const LOGGING_BASE_URL = "https://logging.smplkit.com";

/** @internal — deduplicates and batches logger registrations for bulk upload. */
export class LoggerRegistrationBuffer {
  private _seen = new Set<string>();
  private _pending: Array<{
    id: string;
    level: string;
    resolved_level: string;
    service?: string;
    environment?: string;
  }> = [];

  add(
    id: string,
    level: string,
    resolvedLevel: string,
    service: string | null,
    environment: string | null,
  ): void {
    if (this._seen.has(id)) return;
    this._seen.add(id);
    const item: {
      id: string;
      level: string;
      resolved_level: string;
      service?: string;
      environment?: string;
    } = { id, level, resolved_level: resolvedLevel };
    if (service) item.service = service;
    if (environment) item.environment = environment;
    this._pending.push(item);
  }

  drain(): Array<{
    id: string;
    level: string;
    resolved_level: string;
    service?: string;
    environment?: string;
  }> {
    const batch = this._pending;
    this._pending = [];
    return batch;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

type LoggerResource = components["schemas"]["LoggerResource"];
type LogGroupResource = components["schemas"]["LogGroupResource"];

/** @internal */
async function checkError(response: Response, _context: string): Promise<never> {
  const body = await response.text().catch(() => "");
  throwForStatus(response.status, body);
}

/** @internal */
function wrapFetchError(err: unknown): never {
  if (
    err instanceof SmplNotFoundError ||
    err instanceof SmplConflictError ||
    err instanceof SmplValidationError ||
    err instanceof SmplError
  ) {
    throw err;
  }
  if (err instanceof TypeError) {
    throw new SmplConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * Management API for smplkit Logging — CRUD operations on Logger and LogGroup models.
 *
 * Access via `SmplClient.logging.management`.
 */
export class LoggingManagement {
  constructor(private readonly _client: LoggingClient) {}

  /** Create an unsaved logger. Call `.save()` to persist. */
  new(id: string, options?: { name?: string; managed?: boolean }): Logger {
    return this._client._mgNew(id, options);
  }

  /** Fetch a logger by id. */
  async get(id: string): Promise<Logger> {
    return this._client._mgGet(id);
  }

  /** List all loggers. */
  async list(): Promise<Logger[]> {
    return this._client._mgList();
  }

  /** Delete a logger by id. */
  async delete(id: string): Promise<void> {
    return this._client._mgDelete(id);
  }

  /** Create an unsaved log group. Call `.save()` to persist. */
  newGroup(id: string, options?: { name?: string; group?: string }): LogGroup {
    return this._client._mgNewGroup(id, options);
  }

  /** Fetch a log group by id. */
  async getGroup(id: string): Promise<LogGroup> {
    return this._client._mgGetGroup(id);
  }

  /** List all log groups. */
  async listGroups(): Promise<LogGroup[]> {
    return this._client._mgListGroups();
  }

  /** Delete a log group by id. */
  async deleteGroup(id: string): Promise<void> {
    return this._client._mgDeleteGroup(id);
  }

  /**
   * Bulk-register explicit logger sources with the logging service.
   *
   * Unlike `start()`, which auto-discovers loggers from the current
   * process, this method accepts explicit `service` and `environment`
   * overrides — useful for sample-data seeding and test fixtures.
   */
  async registerSources(sources: LoggerSource[]): Promise<void> {
    return this._client._mgRegisterSources(sources);
  }
}

/**
 * Client for the smplkit Logging API.
 *
 * Obtained via `SmplClient.logging`.
 */
export class LoggingClient {
  /** @internal */
  readonly _apiKey: string;
  /** @internal */
  readonly _baseUrl: string;

  /** @internal */
  private readonly _http: ReturnType<
    typeof createClient<import("../generated/logging.d.ts").paths>
  >;

  /** @internal — set by SmplClient after construction. */
  _parent: {
    readonly _environment: string;
    readonly _service: string | null;
    readonly _metrics: MetricsReporter | null;
  } | null = null;

  /** Management API — CRUD operations on Logger and LogGroup models. */
  readonly management: LoggingManagement;

  private readonly _ensureWs: () => SharedWebSocket;
  private _wsManager: SharedWebSocket | null = null;
  private _started = false;
  private _globalListeners: Array<(event: LoggerChangeEvent) => void> = [];
  private _keyListeners: Map<string, Array<(event: LoggerChangeEvent) => void>> = new Map();

  private _adapters: LoggingAdapter[] = [];
  private _explicitAdapters = false;
  private _loggerBuffer = new LoggerRegistrationBuffer();
  private _loggerFlushTimer: ReturnType<typeof setInterval> | null = null;

  // Local stores for diff-based listener firing
  private _loggerStore: Record<string, string | null> = {}; // key -> level
  private _groupStore: Record<string, string | null> = {}; // key -> level

  /** @internal */
  constructor(apiKey: string, ensureWs: () => SharedWebSocket, timeout?: number, baseUrl?: string) {
    this._apiKey = apiKey;
    this._ensureWs = ensureWs;
    const resolvedBaseUrl = baseUrl ?? LOGGING_BASE_URL;
    this._baseUrl = resolvedBaseUrl;
    const ms = timeout ?? 30_000;

    this._http = createClient<import("../generated/logging.d.ts").paths>({
      baseUrl: resolvedBaseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      fetch: async (request: Request): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
          return await fetch(new Request(request, { signal: controller.signal }));
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw new SmplTimeoutError(`Request timed out after ${ms}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    });
    this.management = new LoggingManagement(this);
  }

  // ------------------------------------------------------------------
  // Adapter registration
  // ------------------------------------------------------------------

  /**
   * Register a logging framework adapter.
   *
   * Must be called before `start()`. When called, only explicitly
   * registered adapters will be used.
   */
  registerAdapter(adapter: LoggingAdapter): void {
    if (this._started) {
      throw new Error("Cannot register adapters after start()");
    }
    this._explicitAdapters = true;
    this._adapters.push(adapter);
  }

  // ------------------------------------------------------------------
  // Management: internal implementations (delegated from LoggingManagement)
  // ------------------------------------------------------------------

  /** @internal */
  _mgNew(id: string, options?: { name?: string; managed?: boolean }): Logger {
    return new Logger(this, {
      id,
      name: options?.name ?? keyToDisplayName(id),
      level: null,
      group: null,
      managed: options?.managed ?? false,
      sources: [],
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @internal */
  async _mgGet(id: string): Promise<Logger> {
    let data: components["schemas"]["LoggerResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/loggers/{id}", {
        params: { path: { id } },
      });
      if (result.error !== undefined)
        await checkError(result.response, `Logger with id '${id}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplNotFoundError(`Logger with id '${id}' not found`);
    }
    return this._loggerToModel(data.data);
  }

  /** @internal */
  async _mgList(): Promise<Logger[]> {
    let data: components["schemas"]["LoggerListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/loggers", {});
      if (result.error !== undefined) await checkError(result.response, "Failed to list loggers");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => this._loggerToModel(r));
  }

  /** @internal */
  async _mgDelete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/loggers/{id}", {
        params: { path: { id } },
      });
      if (result.error !== undefined && result.response.status !== 204)
        await checkError(result.response, `Failed to delete logger '${id}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal */
  _mgNewGroup(id: string, options?: { name?: string; group?: string }): LogGroup {
    return new LogGroup(this, {
      id,
      key: null,
      name: options?.name ?? keyToDisplayName(id),
      level: null,
      group: options?.group ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @internal */
  async _mgGetGroup(id: string): Promise<LogGroup> {
    let data: components["schemas"]["LogGroupResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/log_groups/{id}", {
        params: { path: { id } },
      });
      if (result.error !== undefined)
        await checkError(result.response, `LogGroup with id '${id}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplNotFoundError(`LogGroup with id '${id}' not found`);
    }
    return this._groupToModel(data.data);
  }

  /** @internal */
  async _mgListGroups(): Promise<LogGroup[]> {
    let data: components["schemas"]["LogGroupListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/log_groups", {});
      if (result.error !== undefined)
        await checkError(result.response, "Failed to list log groups");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => this._groupToModel(r));
  }

  /** @internal */
  async _mgRegisterSources(sources: LoggerSource[]): Promise<void> {
    if (sources.length === 0) return;
    const loggers = sources.map((src) => ({
      id: src.name,
      level: src.level ?? undefined,
      resolved_level: src.resolvedLevel,
      service: src.service,
      environment: src.environment,
    }));
    try {
      const result = await this._http.POST("/api/v1/loggers/bulk", {
        body: { loggers },
      });
      if (result.error !== undefined)
        await checkError(result.response, "Failed to register sources");
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal */
  async _mgDeleteGroup(id: string): Promise<void> {
    const group = await this.management.getGroup(id);
    try {
      const result = await this._http.DELETE("/api/v1/log_groups/{id}", {
        params: { path: { id: group.id! } },
      });
      if (result.error !== undefined && result.response.status !== 204)
        await checkError(result.response, `Failed to delete log group '${id}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  // ------------------------------------------------------------------
  // Management: internal save methods
  // ------------------------------------------------------------------

  /** @internal — PUT a logger (upsert: server creates if not found). */
  async _saveLogger(logger: Logger): Promise<Logger> {
    const body = {
      data: {
        id: logger.id,
        type: "logger" as const,
        attributes: {
          name: logger.name,
          level: logger.level,
          group: logger.group,
          managed: logger.managed,
          environments: logger.environments,
        },
      },
    };

    let data: components["schemas"]["LoggerResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/loggers/{id}", {
        params: { path: { id: logger.id! } },
        body,
      });
      if (result.error !== undefined)
        await checkError(result.response, `Failed to save logger ${logger.id}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError(`Failed to save logger ${logger.id}`);
    return this._loggerToModel(data.data);
  }

  /** @internal — POST or PUT a log group. */
  async _saveLogGroup(group: LogGroup): Promise<LogGroup> {
    const body = {
      data: {
        id: group.id,
        type: "log_group" as const,
        attributes: {
          name: group.name,
          level: group.level,
          group: group.group,
          environments: group.environments,
        },
      },
    };

    if (group.createdAt === null) {
      // POST — create
      let data: components["schemas"]["LogGroupResponse"] | undefined;
      try {
        const result = await this._http.POST("/api/v1/log_groups", { body });
        if (result.error !== undefined)
          await checkError(result.response, "Failed to create log group");
        data = result.data;
      } catch (err) {
        wrapFetchError(err);
      }
      if (!data || !data.data) throw new SmplValidationError("Failed to create log group");
      return this._groupToModel(data.data);
    } else {
      // PUT — update
      let data: components["schemas"]["LogGroupResponse"] | undefined;
      try {
        const result = await this._http.PUT("/api/v1/log_groups/{id}", {
          params: { path: { id: group.id! } },
          body,
        });
        if (result.error !== undefined)
          await checkError(result.response, `Failed to update log group ${group.id}`);
        data = result.data;
      } catch (err) {
        wrapFetchError(err);
      }
      if (!data || !data.data)
        throw new SmplValidationError(`Failed to update log group ${group.id}`);
      return this._groupToModel(data.data);
    }
  }

  // ------------------------------------------------------------------
  // Runtime: start (scaffolded)
  // ------------------------------------------------------------------

  /**
   * Start the logging runtime.
   *
   * Synchronizes loggers with the server and subscribes to live level
   * updates. Idempotent — safe to call multiple times.
   * Management methods work without calling `start()`.
   */
  async start(): Promise<void> {
    if (this._started) return;
    debug("lifecycle", "LoggingClient.start() called");

    // 1. Auto-load adapters if none registered explicitly
    if (!this._explicitAdapters) {
      this._adapters = this._autoLoadAdapters();
    }

    // 2. Discover existing loggers from each adapter and add to buffer
    const service = this._parent?._service ?? null;
    const environment = this._parent?._environment ?? null;
    let discoveredCount = 0;
    for (const adapter of this._adapters) {
      try {
        const loggers = adapter.discover();
        for (const { name, level } of loggers) {
          this._loggerBuffer.add(name, level, level, service, environment);
          discoveredCount++;
        }
      } catch {
        // ignore adapter discovery errors
      }
    }
    debug("discovery", `discovered ${discoveredCount} logger(s) from adapters`);

    // 3. Install hooks on each adapter for new logger creation
    for (const adapter of this._adapters) {
      try {
        adapter.installHook((name: string, level: string) => {
          this._onAdapterNewLogger(name, level);
        });
        debug("discovery", `hook installed on adapter`);
      } catch {
        // ignore hook installation errors
      }
    }

    // 4. Record discovery metric
    if (discoveredCount > 0) {
      const metrics = this._parent?._metrics;
      if (metrics) {
        metrics.record("logging.loggers_discovered", discoveredCount, "loggers");
      }
    }

    // 5. Flush discovered loggers to the bulk-register endpoint
    await this._flushLoggerBuffer();

    // 5. Fetch all loggers and groups from the server, resolve levels
    debug("resolution", `starting resolution pass (trigger: start())`);
    try {
      const [serverLoggers, serverGroups] = await Promise.all([
        this.management.list(),
        this.management.listGroups(),
      ]);
      debug(
        "api",
        `fetched ${serverLoggers.length} logger(s) and ${serverGroups.length} group(s) from server`,
      );

      // 6. Apply levels from server to adapters and populate stores
      this._applyLevels(serverLoggers);
      for (const l of serverLoggers) {
        this._loggerStore[l.id!] = l.level;
      }
      for (const g of serverGroups) {
        this._groupStore[g.id!] = g.level;
      }
    } catch {
      // Server may be unreachable — continue with WebSocket wiring
    }

    // 7. Wire WebSocket for logger change/delete and group change/delete events
    this._wsManager = this._ensureWs();
    this._wsManager.on("logger_changed", this._handleLoggerChanged);
    this._wsManager.on("logger_deleted", this._handleLoggerDeleted);
    this._wsManager.on("group_changed", this._handleGroupChanged);
    this._wsManager.on("group_deleted", this._handleGroupDeleted);
    this._wsManager.on("loggers_changed", this._handleLoggersChanged);

    // 8. Start periodic flush timer for post-startup logger discovery
    this._loggerFlushTimer = setInterval(() => {
      void this._flushLoggerBuffer();
    }, 30_000);

    this._started = true;
  }

  // ------------------------------------------------------------------
  // Runtime: change listeners
  // ------------------------------------------------------------------

  /**
   * Register a change listener.
   *
   * - `onChange(callback)` — fires for any logger change.
   * - `onChange(id, callback)` — fires only for the specified logger id.
   */
  onChange(
    callbackOrId: string | ((event: LoggerChangeEvent) => void),
    callback?: (event: LoggerChangeEvent) => void,
  ): void {
    if (typeof callbackOrId === "function") {
      this._globalListeners.push(callbackOrId);
    } else {
      const id = callbackOrId;
      if (!callback) {
        throw new SmplError("onChange(id, callback) requires a callback function.");
      }
      if (!this._keyListeners.has(id)) {
        this._keyListeners.set(id, []);
      }
      this._keyListeners.get(id)!.push(callback);
    }
  }

  // ------------------------------------------------------------------
  // Internal: close
  // ------------------------------------------------------------------

  /** @internal */
  _close(): void {
    debug("lifecycle", "LoggingClient._close() called");

    // Cancel the periodic flush timer
    if (this._loggerFlushTimer !== null) {
      clearInterval(this._loggerFlushTimer);
      this._loggerFlushTimer = null;
    }

    // Uninstall adapter hooks
    for (const adapter of this._adapters) {
      try {
        adapter.uninstallHook();
        debug("adapter", "applying-guard OFF — adapter hook uninstalled");
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
      this._wsManager = null;
    }
    this._started = false;
  }

  // ------------------------------------------------------------------
  // Internal: adapter helpers
  // ------------------------------------------------------------------

  /** Auto-load built-in adapters by attempting to require each framework. */
  private _autoLoadAdapters(): LoggingAdapter[] {
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

  /** Apply resolved levels from server loggers to all adapters. */
  private _applyLevels(serverLoggers: Logger[]): void {
    for (const logger of serverLoggers) {
      if (!logger.level) continue;

      // Resolve environment-specific level if available
      const env = this._parent?._environment;
      let effectiveLevel = logger.level;
      if (env && logger.environments) {
        const envOverride = (logger.environments as Record<string, any>)[env];
        if (envOverride?.level) {
          effectiveLevel = envOverride.level;
        }
      }

      debug("resolution", `${logger.id} -> ${effectiveLevel}`);

      const metrics = this._parent?._metrics;
      if (metrics) {
        metrics.record("logging.level_changes", 1, "changes", { logger: logger.id! });
      }

      for (const adapter of this._adapters) {
        try {
          debug("adapter", `setLevel(${logger.id}, ${effectiveLevel})`);
          adapter.applyLevel(logger.id!, effectiveLevel);
        } catch {
          // ignore adapter errors
        }
      }
    }
  }

  /** Called by adapter hooks when a new logger is created in the framework. */
  private _onAdapterNewLogger(name: string, level: string): void {
    debug("discovery", `new logger intercepted at runtime: ${name}`);
    const service = this._parent?._service ?? null;
    const environment = this._parent?._environment ?? null;
    this._loggerBuffer.add(name, level, level, service, environment);

    if (this._loggerBuffer.pendingCount >= 50) {
      void this._flushLoggerBuffer();
    }
  }

  /** Flush buffered loggers to the bulk-register endpoint. */
  private async _flushLoggerBuffer(): Promise<void> {
    const batch = this._loggerBuffer.drain();
    if (batch.length === 0) return;
    debug("registration", `flushing ${batch.length} logger(s) to bulk-register endpoint`);
    try {
      const result = await this._http.POST("/api/v1/loggers/bulk", {
        body: { loggers: batch },
      });
      if (result.error !== undefined) {
        console.warn("[smplkit] Logger bulk registration failed");
        debug("registration", "logger bulk-register returned an error response");
      } else {
        debug("registration", `bulk-register complete (${batch.length} logger(s))`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[smplkit] Logger bulk registration failed: ${msg}`);
      debug(
        "registration",
        `logger bulk-register error: ${err instanceof Error ? (err.stack ?? msg) : msg}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Internal: WebSocket handler
  // ------------------------------------------------------------------

  private _handleLoggerChanged = (data: Record<string, any>): void => {
    debug("websocket", `logger_changed event received: ${JSON.stringify(data)}`);
    const id = data.id as string | undefined;
    if (!id) return;
    // Scoped fetch: GET /loggers/{key}
    void this._fetchSingleLogger(id)
      .then((logger) => {
        const oldLevel = this._loggerStore[id] ?? null;
        const newLevel = logger?.level ?? null;
        if (oldLevel === newLevel) return; // no change
        this._loggerStore[id] = newLevel;
        if (logger) {
          this._applyLevels([logger]);
        }
        const event: LoggerChangeEvent = {
          id,
          level: newLevel as LogLevel | null,
          source: "websocket",
        };
        for (const cb of this._globalListeners) {
          try {
            cb(event);
          } catch {
            // ignore listener errors
          }
        }
        const idCallbacks = this._keyListeners.get(id);
        if (idCallbacks) {
          for (const cb of idCallbacks) {
            try {
              cb(event);
            } catch {
              // ignore listener errors
            }
          }
        }
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
    // Remove from store — no HTTP fetch
    delete this._loggerStore[id];
    const event: LoggerChangeEvent & { deleted: true } = {
      id,
      level: null,
      source: "websocket",
      deleted: true,
    };
    for (const cb of this._globalListeners) {
      try {
        cb(event);
      } catch (err) {
        debug(
          "websocket",
          `logger_deleted listener error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const idCallbacks = this._keyListeners.get(id);
    if (idCallbacks) {
      for (const cb of idCallbacks) {
        try {
          cb(event);
        } catch (err) {
          debug(
            "websocket",
            `logger_deleted key listener error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  };

  private _handleGroupChanged = (data: Record<string, any>): void => {
    debug("websocket", `group_changed event received: ${JSON.stringify(data)}`);
    const id = data.id as string | undefined;
    if (!id) return;
    // Scoped fetch: GET /log_groups/{key}
    void this._fetchSingleGroup(id)
      .then((group) => {
        const oldLevel = this._groupStore[id] ?? null;
        const newLevel = group?.level ?? null;
        if (oldLevel === newLevel) return; // no change
        this._groupStore[id] = newLevel;
        // Group level change means re-apply to all loggers in this group
        void this.management
          .list()
          .then((loggers) => {
            this._applyLevels(loggers);
          })
          .catch(() => {});
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
    // Remove from store — no HTTP fetch
    delete this._groupStore[id];
    const event: LoggerChangeEvent & { deleted: true } = {
      id,
      level: null,
      source: "websocket",
      deleted: true,
    };
    for (const cb of this._globalListeners) {
      try {
        cb(event);
      } catch (err) {
        debug(
          "websocket",
          `group_deleted listener error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const idCallbacks = this._keyListeners.get(id);
    if (idCallbacks) {
      for (const cb of idCallbacks) {
        try {
          cb(event);
        } catch (err) {
          debug(
            "websocket",
            `group_deleted key listener error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  };

  private _handleLoggersChanged = (_data: Record<string, any>): void => {
    debug("websocket", `loggers_changed event received`);
    // Full refetch of both loggers AND log_groups, diff-based firing
    void Promise.all([this.management.list(), this.management.listGroups()])
      .then(([serverLoggers, serverGroups]) => {
        debug("resolution", `resolution pass (trigger: loggers_changed event)`);
        // Diff loggers
        const changedLoggerIds = new Set<string>();
        const newLoggerKeys = new Set(serverLoggers.map((l) => l.id!));
        // Check new/changed loggers
        for (const logger of serverLoggers) {
          const key = logger.id!;
          const oldLevel = this._loggerStore[key] ?? null;
          const newLevel = logger.level ?? null;
          if (oldLevel !== newLevel || !(key in this._loggerStore)) {
            changedLoggerIds.add(key);
            this._loggerStore[key] = newLevel;
          }
        }
        // Check deleted loggers
        for (const key of Object.keys(this._loggerStore)) {
          if (!newLoggerKeys.has(key)) {
            changedLoggerIds.add(key);
            delete this._loggerStore[key];
          }
        }
        // Update group store
        for (const group of serverGroups) {
          this._groupStore[group.id!] = group.level ?? null;
        }
        // Apply levels
        this._applyLevels(serverLoggers);
        if (changedLoggerIds.size === 0) return;
        // Fire global listener ONCE
        const [firstKey] = changedLoggerIds;
        const firstLogger = serverLoggers.find((l) => l.id === firstKey);
        const globalEvent: LoggerChangeEvent = {
          id: firstKey,
          level: (firstLogger?.level ?? null) as LogLevel | null,
          source: "websocket",
        };
        for (const cb of this._globalListeners) {
          try {
            cb(globalEvent);
          } catch {
            // ignore listener errors
          }
        }
        // Fire per-key listeners for each changed key
        for (const key of changedLoggerIds) {
          const keyCallbacks = this._keyListeners.get(key);
          if (keyCallbacks) {
            const l = serverLoggers.find((x) => x.id === key);
            const keyEvent: LoggerChangeEvent = {
              id: key,
              level: (l?.level ?? null) as LogLevel | null,
              source: "websocket",
            };
            for (const cb of keyCallbacks) {
              try {
                cb(keyEvent);
              } catch {
                // ignore listener errors
              }
            }
          }
        }
      })
      .catch(() => {
        // ignore refresh errors
      });
  };

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
      return this._loggerToModel(result.data.data);
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
      return this._groupToModel(result.data.data);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Internal: model conversion
  // ------------------------------------------------------------------

  private _loggerToModel(resource: LoggerResource): Logger {
    const attrs = resource.attributes;
    const rawLevel = attrs.level ?? null;
    return new Logger(this, {
      id: resource.id ?? null,
      name: attrs.name,
      level: rawLevel as LogLevel | null,
      group: attrs.group ?? null,
      managed: attrs.managed ?? false,
      sources: [],
      environments: (attrs.environments ?? {}) as Record<string, any>,
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }

  private _groupToModel(resource: LogGroupResource): LogGroup {
    const attrs = resource.attributes;
    const rawLevel = attrs.level ?? null;
    return new LogGroup(this, {
      id: resource.id ?? null,
      key: resource.id ?? null,
      name: attrs.name,
      level: rawLevel as LogLevel | null,
      group: attrs.parent_id ?? null,
      environments: (attrs.environments ?? {}) as Record<string, any>,
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }
}
