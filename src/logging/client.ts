/**
 * LoggingClient — runtime client for Smpl Logging (level resolution, adapter
 * integration, live-updates). Management/CRUD lives on `mgmt.loggers.*` and
 * `mgmt.logGroups.*`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/logging.d.ts";
import { SmplError, SmplTimeoutError } from "../errors.js";
import { Logger, LogGroup } from "./models.js";
import { LogLevel, LoggerChangeEvent } from "./types.js";
import type { LoggingAdapter } from "./adapters/base.js";
import type { MetricsReporter } from "../_metrics.js";
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

/**
 * Runtime client for the smplkit Logging service.
 *
 * Obtained via `SmplClient.logging`. Provides adapter integration, level
 * resolution, and live-updates for logger/group changes. Management/CRUD
 * lives on `SmplClient.manage.loggers` / `SmplClient.manage.logGroups` (or
 * use a standalone {@link SmplManagementClient}).
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

  /** @internal — resolves the management plane sub-clients used by install/refresh. */
  _resolveManagement?: () => import("../management/client.js").SmplManagementClient;

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
  // Internal: management-plane delegation (with HTTP fallback)
  // ------------------------------------------------------------------

  /**
   * @internal — fetch the full logger list. Prefers the management plane
   * (set via `_resolveManagement`); falls back to a direct GET when running
   * without `SmplClient` bootstrap (e.g. unit tests that construct
   * `LoggingClient` directly).
   */
  private async _listLoggers(): Promise<Logger[]> {
    if (this._resolveManagement) {
      return this._resolveManagement().loggers.list();
    }
    const result = await this._http.GET("/api/v1/loggers", {});
    if (result.error !== undefined) {
      throw new SmplError(`Failed to list loggers: ${result.response.status}`);
    }
    if (!result.data) return [];
    return result.data.data.map((r) => this._loggerToModel(r));
  }

  /** @internal — see {@link _listLoggers}. */
  private async _listLogGroups(): Promise<LogGroup[]> {
    if (this._resolveManagement) {
      return this._resolveManagement().logGroups.list();
    }
    const result = await this._http.GET("/api/v1/log_groups", {});
    if (result.error !== undefined) {
      throw new SmplError(`Failed to list log groups: ${result.response.status}`);
    }
    if (!result.data) return [];
    return result.data.data.map((r) => this._groupToModel(r));
  }

  // ------------------------------------------------------------------
  // Runtime: install
  // ------------------------------------------------------------------

  /**
   * Install the smplkit logging integration into the running process.
   *
   * Loads any adapters that haven't been registered explicitly, discovers
   * existing loggers from each adapter, hooks new-logger creation, and
   * subscribes to live level updates over the shared WebSocket. Idempotent —
   * safe to call multiple times. Management methods work without calling
   * `install()`.
   *
   * Mirrors Python's `client.logging.install()`. There is no `stop()`.
   */
  async install(): Promise<void> {
    return this._installInternal();
  }

  /**
   * @deprecated Use {@link LoggingClient.install}. Retained as a backwards-
   * compatible alias.
   */
  async start(): Promise<void> {
    return this._installInternal();
  }

  /** @internal — shared body of install()/start(). */
  async _installInternal(): Promise<void> {
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
        this._listLoggers(),
        this._listLogGroups(),
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
        const event = new LoggerChangeEvent({
          id,
          level: newLevel as LogLevel | null,
          source: "websocket",
        });
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
    const event = new LoggerChangeEvent({
      id,
      level: null,
      source: "websocket",
      deleted: true,
    });
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
        void this._listLoggers()
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
    const event = new LoggerChangeEvent({
      id,
      level: null,
      source: "websocket",
      deleted: true,
    });
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
    void Promise.all([this._listLoggers(), this._listLogGroups()])
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
        const globalEvent = new LoggerChangeEvent({
          id: firstKey,
          level: (firstLogger?.level ?? null) as LogLevel | null,
          source: "websocket",
        });
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
            const keyEvent = new LoggerChangeEvent({
              id: key,
              level: (l?.level ?? null) as LogLevel | null,
              source: "websocket",
            });
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

  /** @internal — runtime models are read-only (no save/delete). */
  private _loggerToModel(resource: LoggerResource): Logger {
    const attrs = resource.attributes;
    const rawLevel = attrs.level ?? null;
    return new Logger(null, {
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

  /** @internal — runtime models are read-only (no save/delete). */
  private _groupToModel(resource: LogGroupResource): LogGroup {
    const attrs = resource.attributes;
    const rawLevel = attrs.level ?? null;
    return new LogGroup(null, {
      id: resource.id ?? null,
      name: attrs.name,
      level: rawLevel as LogLevel | null,
      group: attrs.parent_id ?? null,
      environments: (attrs.environments ?? {}) as Record<string, any>,
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }
}
