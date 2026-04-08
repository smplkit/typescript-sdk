/**
 * LoggingClient — management plane + scaffolded runtime for Smpl Logging.
 *
 * Uses the generated OpenAPI types (`src/generated/logging.d.ts`) via
 * `openapi-fetch` for all HTTP calls.
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
 * Client for the smplkit Logging API — management plane + scaffolded runtime.
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
   * Fetches existing loggers/groups and wires WebSocket listeners for
   * live updates. Idempotent — safe to call multiple times.
   *
   * Note: Node.js auto-discovery (equivalent to Python's logging module
   * monkey-patching) is deferred. Management methods work without start().
   */
  async start(): Promise<void> {
    if (this._started) return;

    // Wire WebSocket for logger_changed events
    this._wsManager = this._ensureWs();
    this._wsManager.on("logger_changed", this._handleLoggerChanged);

    this._started = true;
  }

  // ------------------------------------------------------------------
  // Runtime: change listeners (dual-mode)
  // ------------------------------------------------------------------

  /**
   * Register a change listener.
   *
   * - `onChange(callback)` — fires for any logger change (global).
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
    if (this._wsManager !== null) {
      this._wsManager.off("logger_changed", this._handleLoggerChanged);
      this._wsManager = null;
    }
    this._started = false;
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
