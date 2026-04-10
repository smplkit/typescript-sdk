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
  _parent: { readonly _environment: string; readonly _service: string | null } | null = null;

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
  // Management: Logger factory
  // ------------------------------------------------------------------

  /** Create an unsaved logger. Call `.save()` to persist. */
  new(key: string, options?: { name?: string; managed?: boolean }): Logger {
    return new Logger(this, {
      id: null,
      key,
      name: options?.name ?? keyToDisplayName(key),
      level: null,
      group: null,
      managed: options?.managed ?? false,
      sources: [],
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  // ------------------------------------------------------------------
  // Management: Logger CRUD
  // ------------------------------------------------------------------

  /** Fetch a logger by key. */
  async get(key: string): Promise<Logger> {
    let data: components["schemas"]["LoggerListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/loggers", {
        params: { query: { "filter[key]": key } },
      });
      if (result.error !== undefined)
        await checkError(result.response, `Logger with key '${key}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data || data.data.length === 0) {
      throw new SmplNotFoundError(`Logger with key '${key}' not found`);
    }
    return this._loggerToModel(data.data[0]);
  }

  /** List all loggers. */
  async list(): Promise<Logger[]> {
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

  /** Delete a logger by key. */
  async delete(key: string): Promise<void> {
    const logger = await this.get(key);
    try {
      const result = await this._http.DELETE("/api/v1/loggers/{id}", {
        params: { path: { id: logger.id! } },
      });
      if (result.error !== undefined && result.response.status !== 204)
        await checkError(result.response, `Failed to delete logger '${key}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  // ------------------------------------------------------------------
  // Management: LogGroup factory
  // ------------------------------------------------------------------

  /** Create an unsaved log group. Call `.save()` to persist. */
  newGroup(key: string, options?: { name?: string; group?: string }): LogGroup {
    return new LogGroup(this, {
      id: null,
      key,
      name: options?.name ?? keyToDisplayName(key),
      level: null,
      group: options?.group ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  // ------------------------------------------------------------------
  // Management: LogGroup CRUD
  // ------------------------------------------------------------------

  /** Fetch a log group by key. */
  async getGroup(key: string): Promise<LogGroup> {
    // The logging API doesn't have a filter[key] on groups in the generated spec,
    // so we list all and filter client-side.
    const groups = await this.listGroups();
    const match = groups.find((g) => g.key === key);
    if (!match) {
      throw new SmplNotFoundError(`LogGroup with key '${key}' not found`);
    }
    return match;
  }

  /** List all log groups. */
  async listGroups(): Promise<LogGroup[]> {
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

  /** Delete a log group by key. */
  async deleteGroup(key: string): Promise<void> {
    const group = await this.getGroup(key);
    try {
      const result = await this._http.DELETE("/api/v1/log_groups/{id}", {
        params: { path: { id: group.id! } },
      });
      if (result.error !== undefined && result.response.status !== 204)
        await checkError(result.response, `Failed to delete log group '${key}'`);
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
        type: "logger" as const,
        attributes: {
          key: logger.key,
          name: logger.name,
          level: logger.level,
          group: logger.group,
          managed: logger.managed,
          environments: logger.environments,
        },
      },
    };

    if (logger.id === null) {
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
          params: { path: { id: logger.id } },
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
        type: "log_group" as const,
        attributes: {
          key: group.key,
          name: group.name,
          level: group.level,
          group: group.group,
          environments: group.environments,
        },
      },
    };

    if (group.id === null) {
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
          params: { path: { id: group.id } },
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

    // 4. Bulk-register discovered loggers with the server
    for (const { name, level } of discovered) {
      try {
        const logger = this.new(name, { managed: true });
        logger.setLevel(level as any);
        await logger.save();
      } catch {
        // Logger may already exist — ignore
      }
    }

    // 5. Fetch all loggers and groups from the server, resolve levels
    try {
      const [serverLoggers] = await Promise.all([this.list(), this.listGroups()]);

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
   * - `onChange(key, callback)` — fires only for the specified logger key.
   */
  onChange(
    callbackOrKey: string | ((event: LoggerChangeEvent) => void),
    callback?: (event: LoggerChangeEvent) => void,
  ): void {
    if (typeof callbackOrKey === "function") {
      this._globalListeners.push(callbackOrKey);
    } else {
      const key = callbackOrKey;
      if (!callback) {
        throw new SmplError("onChange(key, callback) requires a callback function.");
      }
      if (!this._keyListeners.has(key)) {
        this._keyListeners.set(key, []);
      }
      this._keyListeners.get(key)!.push(callback);
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

      for (const adapter of this._adapters) {
        try {
          adapter.applyLevel(logger.key, effectiveLevel);
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
    const logger = this.new(_name, { managed: true });
    logger.setLevel(_level as any);
    logger.save().catch(() => {
      // ignore — logger may already exist
    });
  }

  // ------------------------------------------------------------------
  // Internal: WebSocket handler
  // ------------------------------------------------------------------

  private _handleLoggerChanged = (data: Record<string, any>): void => {
    const key = data.key as string | undefined;
    if (key) {
      const level = data.level ?? null;
      const event: LoggerChangeEvent = {
        key,
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
      // Key-scoped listeners
      const keyCallbacks = this._keyListeners.get(key);
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
  };

  // ------------------------------------------------------------------
  // Internal: model conversion
  // ------------------------------------------------------------------

  private _loggerToModel(resource: LoggerResource): Logger {
    const attrs = resource.attributes;
    return new Logger(this, {
      id: resource.id ?? null,
      key: attrs.key ?? "",
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
      key: attrs.key ?? "",
      name: attrs.name,
      level: attrs.level ?? null,
      group: attrs.group ?? null,
      environments: (attrs.environments ?? {}) as Record<string, any>,
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }
}
