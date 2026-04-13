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
import type { LoggerChangeEvent } from "./types.js";
import type { LoggingAdapter } from "./adapters/base.js";
import type { MetricsReporter } from "../_metrics.js";
import { keyToDisplayName } from "../helpers.js";
import type { SharedWebSocket } from "../ws.js";

const LOGGING_BASE_URL = "https://logging.smplkit.com";

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
  readonly _baseUrl: string = LOGGING_BASE_URL;

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

  /** @internal */
  constructor(apiKey: string, ensureWs: () => SharedWebSocket, timeout?: number) {
    this._apiKey = apiKey;
    this._ensureWs = ensureWs;
    const ms = timeout ?? 30_000;

    this._http = createClient<import("../generated/logging.d.ts").paths>({
      baseUrl: LOGGING_BASE_URL,
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
    const groups = await this.management.listGroups();
    const match = groups.find((g) => g.id === id);
    if (!match) {
      throw new SmplNotFoundError(`LogGroup with id '${id}' not found`);
    }
    return match;
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

  /** @internal — POST or PUT a logger. */
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

    if (logger.createdAt === null) {
      // POST — create
      let data: components["schemas"]["LoggerResponse"] | undefined;
      try {
        const result = await this._http.POST("/api/v1/loggers", { body });
        if (result.error !== undefined)
          await checkError(result.response, "Failed to create logger");
        data = result.data;
      } catch (err) {
        wrapFetchError(err);
      }
      if (!data || !data.data) throw new SmplValidationError("Failed to create logger");
      return this._loggerToModel(data.data);
    } else {
      // PUT — update
      let data: components["schemas"]["LoggerResponse"] | undefined;
      try {
        const result = await this._http.PUT("/api/v1/loggers/{id}", {
          params: { path: { id: logger.id! } },
          body,
        });
        if (result.error !== undefined)
          await checkError(result.response, `Failed to update logger ${logger.id}`);
        data = result.data;
      } catch (err) {
        wrapFetchError(err);
      }
      if (!data || !data.data)
        throw new SmplValidationError(`Failed to update logger ${logger.id}`);
      return this._loggerToModel(data.data);
    }
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

    // 1. Auto-load adapters if none registered explicitly
    if (!this._explicitAdapters) {
      this._adapters = this._autoLoadAdapters();
    }

    // 2. Discover existing loggers from each adapter
    const discovered: Array<{ name: string; level: string }> = [];
    for (const adapter of this._adapters) {
      try {
        const loggers = adapter.discover();
        discovered.push(...loggers);
      } catch {
        // ignore adapter discovery errors
      }
    }

    // 3. Install hooks on each adapter for new logger creation
    for (const adapter of this._adapters) {
      try {
        adapter.installHook((name: string, level: string) => {
          this._onAdapterNewLogger(name, level);
        });
      } catch {
        // ignore hook installation errors
      }
    }

    // 4. Record discovery metric
    if (discovered.length > 0) {
      const metrics = this._parent?._metrics;
      if (metrics) {
        metrics.record("logging.loggers_discovered", discovered.length, "loggers");
      }
    }

    // 5. Bulk-register discovered loggers with the server
    if (discovered.length > 0) {
      const service = this._parent?._service ?? null;
      const environment = this._parent?._environment ?? null;
      const loggers: components["schemas"]["LoggerBulkItem"][] = discovered.map(
        ({ name, level }) => ({
          id: name,
          // For Winston/Pino there is no inherited-null distinction — both fields carry the same value.
          level: level,
          resolved_level: level,
          service: service ?? undefined,
          environment: environment ?? undefined,
        }),
      );
      try {
        const result = await this._http.POST("/api/v1/loggers/bulk", {
          body: { loggers },
        });
        if (result.error !== undefined) await checkError(result.response, "Failed to bulk-register loggers");
      } catch (err: unknown) {
        console.warn(
          `[smplkit] Failed to bulk-register loggers: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 5. Fetch all loggers and groups from the server, resolve levels
    try {
      const [serverLoggers] = await Promise.all([
        this.management.list(),
        this.management.listGroups(),
      ]);

      // 6. Apply levels from server to adapters
      this._applyLevels(serverLoggers);
    } catch {
      // Server may be unreachable — continue with WebSocket wiring
    }

    // 7. Wire WebSocket for logger_changed events
    this._wsManager = this._ensureWs();
    this._wsManager.on("logger_changed", this._handleLoggerChanged);

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

      const metrics = this._parent?._metrics;
      if (metrics) {
        metrics.record("logging.level_changes", 1, "changes", { logger: logger.id! });
      }

      for (const adapter of this._adapters) {
        try {
          adapter.applyLevel(logger.id!, effectiveLevel);
        } catch {
          // ignore adapter errors
        }
      }
    }
  }

  /** Called by adapter hooks when a new logger is created in the framework. */
  private _onAdapterNewLogger(_name: string, _level: string): void {
    // Register with server asynchronously — fire-and-forget.
    // Errors are swallowed to avoid breaking the framework's logger creation.
    const logger = this.management.new(_name, { managed: true });
    logger.setLevel(_level as any);
    logger.save().catch(() => {
      // ignore — logger may already exist
    });
  }

  // ------------------------------------------------------------------
  // Internal: WebSocket handler
  // ------------------------------------------------------------------

  private _handleLoggerChanged = (data: Record<string, any>): void => {
    const id = data.id as string | undefined;
    if (id) {
      const level = data.level ?? null;
      const event: LoggerChangeEvent = {
        id,
        level,
        source: "websocket",
      };
      // Global listeners first
      for (const cb of this._globalListeners) {
        try {
          cb(event);
        } catch {
          // ignore listener errors
        }
      }
      // Id-scoped listeners
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
    }
  };

  // ------------------------------------------------------------------
  // Internal: model conversion
  // ------------------------------------------------------------------

  private _loggerToModel(resource: LoggerResource): Logger {
    const attrs = resource.attributes;
    return new Logger(this, {
      id: resource.id ?? null,
      name: attrs.name,
      level: attrs.level ?? null,
      group: attrs.group ?? null,
      managed: attrs.managed ?? false,
      sources: (attrs.sources ?? []) as Array<Record<string, any>>,
      environments: (attrs.environments ?? {}) as Record<string, any>,
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }

  private _groupToModel(resource: LogGroupResource): LogGroup {
    const attrs = resource.attributes;
    return new LogGroup(this, {
      id: resource.id ?? null,
      name: attrs.name,
      level: attrs.level ?? null,
      group: attrs.group ?? null,
      environments: (attrs.environments ?? {}) as Record<string, any>,
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }
}
