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
import { resolveLevel, type GroupCacheEntry, type LoggerCacheEntry } from "./_resolution.js";
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

  /** @internal */
  constructor(
    apiKey: string,
    ensureWs: () => SharedWebSocket,
    timeout?: number,
    baseUrl?: string,
    extraHeaders?: Record<string, string>,
  ) {
    this._apiKey = apiKey;
    this._ensureWs = ensureWs;
    const resolvedBaseUrl = baseUrl ?? LOGGING_BASE_URL;
    this._baseUrl = resolvedBaseUrl;
    const ms = timeout ?? 30_000;

    this._http = createClient<import("../generated/logging.d.ts").paths>({
      baseUrl: resolvedBaseUrl,
      headers: {
        ...(extraHeaders ?? {}),
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
      let rows: Logger[];
      if (this._resolveManagement) {
        rows = await this._resolveManagement().loggers.list({
          pageNumber: page,
          pageSize: PAGE_SIZE,
        });
      } else {
        const result = await this._http.GET("/api/v1/loggers", {
          params: {
            query: {
              "page[number]": page,
              "page[size]": PAGE_SIZE,
            } as unknown as Record<string, never>,
          },
        });
        if (result.error !== undefined) {
          throw new SmplError(`Failed to list loggers: ${result.response.status}`);
        }
        rows = result.data ? result.data.data.map((r) => this._loggerToModel(r)) : [];
      }
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
      let rows: LogGroup[];
      if (this._resolveManagement) {
        rows = await this._resolveManagement().logGroups.list({
          pageNumber: page,
          pageSize: PAGE_SIZE,
        });
      } else {
        const result = await this._http.GET("/api/v1/log_groups", {
          params: {
            query: {
              "page[number]": page,
              "page[size]": PAGE_SIZE,
            } as unknown as Record<string, never>,
          },
        });
        if (result.error !== undefined) {
          throw new SmplError(`Failed to list log groups: ${result.response.status}`);
        }
        rows = result.data ? result.data.data.map((r) => this._groupToModel(r)) : [];
      }
      all.push(...rows);
      lastPageWasFull = rows.length === PAGE_SIZE;
      page++;
    }
    return all;
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
   *
   * Adapter coverage:
   * - **winston**: pre-existing named loggers (`winston.loggers.*`) and the
   *   default logger are auto-discovered.
   * - **pino**: pino has no global registry, so only loggers created
   *   through `pino()` / `logger.child()` *after* `install()` runs are
   *   tracked. To bring pre-existing pino loggers under management, recreate
   *   them after install or register them explicitly via
   *   `client.manage.loggers.register([...])`.
   *
   * After the initial pass, call {@link refresh} to re-fetch managed levels
   * from the server and re-apply them onto the native loggers (e.g. after
   * suspecting drift, or to force a manual sync outside the WebSocket).
   */
  async install(): Promise<void> {
    return this._installInternal();
  }

  /**
   * Re-fetch logger and group levels from the server and re-apply them
   * onto the registered adapters.
   *
   * Diff-based: change listeners only fire for loggers whose level
   * actually changed (added, removed, or different level), with
   * `source: "manual"`. Mirrors Python's `client.logging.refresh()`.
   *
   * @throws SmplError if `install()` has not been called.
   */
  async refresh(): Promise<void> {
    if (!this._started) {
      throw new SmplError("Logging not installed. Call install() first.");
    }
    await this._resolveAndFire("manual");
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
          this._knownLoggerNames.add(name);
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

      // 6. Replace caches and apply resolved levels.
      this._loggersCache = this._buildLoggersCache(serverLoggers);
      this._groupsCache = this._buildGroupsCache(serverGroups);
      this._applyLevels();
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
    //    (unref so it doesn't pin the event loop).
    this._loggerFlushTimer = setInterval(() => {
      void this._flushLoggerBuffer();
    }, 30_000);
    if (typeof this._loggerFlushTimer === "object" && "unref" in this._loggerFlushTimer) {
      (this._loggerFlushTimer as NodeJS.Timeout).unref();
    }

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

  /**
   * Refresh resolved levels and apply them to adapter-known loggers.
   *
   * Computes a resolved level (via {@link resolveLevel}) for every entry
   * currently in `_loggersCache` *and* every adapter-known logger name —
   * even loggers whose own `level` is `null`, because they may inherit
   * via group chain or dot-notation ancestry.
   *
   * The full resolved-level snapshot is stored in `_resolvedLevelStore`
   * so callers can diff pre-vs-post and fire change listeners on actual
   * effective-level deltas (group-driven changes included). Adapter pushes
   * only happen for adapter-known names where `managed !== false`.
   * @internal
   */
  private _applyLevels(): void {
    const environment = this._parent?._environment ?? "";
    const newResolved: Record<string, string> = {};

    // Resolve for every logger in the cache. This captures server-side
    // loggers that no local adapter has discovered — change listeners
    // still need to fire for them.
    for (const id of Object.keys(this._loggersCache)) {
      newResolved[id] = resolveLevel(id, environment, this._loggersCache, this._groupsCache);
    }
    // Resolve for adapter-known names that may not yet be in the cache.
    for (const name of this._knownLoggerNames) {
      if (!(name in newResolved)) {
        newResolved[name] = resolveLevel(name, environment, this._loggersCache, this._groupsCache);
      }
    }
    this._resolvedLevelStore = newResolved;

    // Push resolved levels to every adapter for each adapter-known name.
    for (const name of this._knownLoggerNames) {
      const resolved = newResolved[name]!;

      const metrics = this._parent?._metrics;
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

  /** Called by adapter hooks when a new logger is created in the framework. */
  private _onAdapterNewLogger(name: string, level: string): void {
    debug("discovery", `new logger intercepted at runtime: ${name}`);
    const service = this._parent?._service ?? null;
    const environment = this._parent?._environment ?? null;
    this._loggerBuffer.add(name, level, level, service, environment);
    this._knownLoggerNames.add(name);

    if (this._loggerBuffer.pendingCount >= 50) {
      void this._flushLoggerBuffer();
    }

    // If we're already started, apply an immediate resolved level for this
    // newly-discovered name. Without this, the framework's local default
    // would persist until the next refresh / ws event.
    if (this._started) {
      const resolved = resolveLevel(
        name,
        this._parent?._environment ?? "",
        this._loggersCache,
        this._groupsCache,
      );
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
    // Always emit a deleted event for the specific id (preserves the
    // explicit notification contract). Exclude it from the delta pass so
    // listeners don't fire twice.
    this._emitDeletedEvent(id, "websocket");
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
    // Always emit a deleted event on the group id so listeners scoped to
    // the group id hear about it, even when no dependent logger's resolved
    // level actually changed.
    this._emitDeletedEvent(id, "websocket");
    this._fireDeltas(preResolved, this._resolvedLevelStore, "websocket", new Set([id]));
  };

  /**
   * @internal Fire change listeners for every logger whose resolved level
   * changed between `pre` and `post`. Stores resolved levels, not raw
   * `logger.level`, so a group-driven change actually fires. Keys that
   * disappeared from `post` are emitted with `deleted: true`.
   */
  private _fireDeltas(
    pre: Record<string, string>,
    post: Record<string, string>,
    source: "websocket" | "manual",
    excludeIds?: Set<string>,
  ): void {
    const changed: string[] = [];
    const allKeys = new Set([...Object.keys(pre), ...Object.keys(post)]);
    for (const k of allKeys) {
      if (excludeIds?.has(k)) continue;
      if (pre[k] !== post[k]) changed.push(k);
    }
    if (changed.length === 0) return;
    const buildEvent = (id: string): LoggerChangeEvent => {
      const isDeletion = id in pre && !(id in post);
      const fields: ConstructorParameters<typeof LoggerChangeEvent>[0] = {
        id,
        source,
        level: (post[id] ?? null) as LogLevel | null,
      };
      if (isDeletion) fields.deleted = true;
      return new LoggerChangeEvent(fields);
    };
    const firstKey = changed[0]!;
    const globalEvent = buildEvent(firstKey);
    for (const cb of this._globalListeners) {
      try {
        cb(globalEvent);
      } catch {
        // ignore listener errors
      }
    }
    for (const k of changed) {
      const keyCallbacks = this._keyListeners.get(k);
      if (keyCallbacks) {
        const event = buildEvent(k);
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
   * @internal Always emit a deleted event for `id` on global and per-key
   * listeners. Used by `logger_deleted` / `group_deleted` handlers to
   * preserve the explicit notification contract even when nothing in the
   * resolved-level store changed (e.g. server removed an unknown logger).
   */
  private _emitDeletedEvent(id: string, source: "websocket" | "manual"): void {
    const event = new LoggerChangeEvent({
      id,
      level: null,
      source,
      deleted: true,
    });
    for (const cb of this._globalListeners) {
      try {
        cb(event);
      } catch (err) {
        debug(
          "websocket",
          `deleted listener error: ${err instanceof Error ? err.message : String(err)}`,
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
            `deleted key listener error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  private _handleLoggersChanged = (_data: Record<string, any>): void => {
    debug("websocket", `loggers_changed event received`);
    void this._resolveAndFire("websocket").catch(() => {
      // ignore refresh errors from WebSocket events
    });
  };

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
