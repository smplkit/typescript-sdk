/**
 * Management sub-clients: `mgmt.loggers.*` and `mgmt.logGroups.*`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/logging.d.ts";
import {
  SmplkitError,
  SmplkitConflictError,
  SmplkitConnectionError,
  SmplkitNotFoundError,
  SmplkitValidationError,
  throwForStatus,
} from "../errors.js";
import { Logger, LogGroup } from "../logging/models.js";
import { LogLevel, LoggerSource, loggerEnvironmentsToWire } from "../logging/types.js";

type LoggingHttp = ReturnType<typeof createClient<import("../generated/logging.d.ts").paths>>;

const LOGGER_REGISTRATION_FLUSH_SIZE = 50;

/** @internal */
async function checkError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
  throwForStatus(response.status, body);
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
  const wire = loggerEnvironmentsToWire(logger._environmentsDirect);
  if (Object.keys(wire).length > 0) {
    attrs.environments = wire as typeof attrs.environments;
  }
  return {
    data: { id: logger.id, type: "logger", attributes: attrs },
  };
}

/** @internal */
function groupToBody(group: LogGroup): {
  data: { id: string | null; type: "log_group"; attributes: components["schemas"]["LogGroup"] };
} {
  const attrs: components["schemas"]["LogGroup"] = {
    name: group.name,
  };
  if (group.level !== null) attrs.level = group.level;
  if (group.group !== null) (attrs as Record<string, unknown>).parent_id = group.group;
  const wire = loggerEnvironmentsToWire(group._environmentsDirect);
  if (Object.keys(wire).length > 0) {
    attrs.environments = wire as typeof attrs.environments;
  }
  return {
    data: { id: group.id, type: "log_group", attributes: attrs },
  };
}

/** Buffer pending logger sources for bulk registration. @internal */
export class LoggerRegistrationBuffer {
  private _seen = new Set<string>();
  private _pending: Array<components["schemas"]["LoggerBulkItem"]> = [];

  add(source: LoggerSource): void {
    if (this._seen.has(source.name)) return;
    this._seen.add(source.name);
    this._pending.push({
      id: source.name,
      resolved_level: source.resolvedLevel,
      ...(source.level !== null ? { level: source.level } : {}),
      ...(source.service !== null ? { service: source.service } : {}),
      ...(source.environment !== null ? { environment: source.environment } : {}),
    });
  }

  drain(): Array<components["schemas"]["LoggerBulkItem"]> {
    const batch = this._pending;
    this._pending = [];
    return batch;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

/**
 * `mgmt.loggers.*` — CRUD client for individual loggers + bulk registration.
 */
export class LoggersClient {
  /** @internal */
  readonly _buffer = new LoggerRegistrationBuffer();

  /** @internal */
  constructor(private readonly _http: LoggingHttp) {}

  /**
   * Construct an unsaved {@link Logger}. Call `.save()` to persist.
   *
   * The id doubles as the display name. `managed` defaults to `true`
   * (every customer using the management API is doing so to manage it).
   */
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

  async list(): Promise<Logger[]> {
    let data: components["schemas"]["LoggerListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/loggers", {});
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToLogger(r, this));
  }

  async get(id: string): Promise<Logger> {
    let data: components["schemas"]["LoggerResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/loggers/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitNotFoundError(`Logger with id ${JSON.stringify(id)} not found`);
    }
    return resourceToLogger(data.data, this);
  }

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
        await checkError(result.response);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * Queue logger source(s) for bulk registration; optionally flush.
   */
  async register(
    items: LoggerSource | LoggerSource[],
    options: { flush?: boolean } = {},
  ): Promise<void> {
    const arr = Array.isArray(items) ? items : [items];
    for (const src of arr) this._buffer.add(src);
    if (options.flush) {
      await this.flush();
      return;
    }
    if (this._buffer.pendingCount >= LOGGER_REGISTRATION_FLUSH_SIZE) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    const batch = this._buffer.drain();
    if (batch.length === 0) return;
    try {
      await this._http.POST("/api/v1/loggers/bulk", { body: { loggers: batch } });
    } catch {
      // ignore — periodic flush will retry
    }
  }

  get pendingCount(): number {
    return this._buffer.pendingCount;
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
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplkitValidationError("Failed to save logger");
    return resourceToLogger(data.data, this);
  }
}

/**
 * `mgmt.logGroups.*` — CRUD client for log groups.
 */
export class LogGroupsClient {
  /** @internal */
  constructor(private readonly _http: LoggingHttp) {}

  /** Construct an unsaved {@link LogGroup}. Call `.save()` to persist. */
  new(id: string, options: { name?: string; group?: string } = {}): LogGroup {
    return new LogGroup(this, {
      id,
      name: options.name ?? id,
      group: options.group ?? null,
      level: null,
      environments: null,
      createdAt: null,
      updatedAt: null,
    });
  }

  async list(): Promise<LogGroup[]> {
    let data: components["schemas"]["LogGroupListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/log_groups", {});
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToLogGroup(r, this));
  }

  async get(id: string): Promise<LogGroup> {
    let data: components["schemas"]["LogGroupResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/log_groups/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitNotFoundError(`LogGroup with id ${JSON.stringify(id)} not found`);
    }
    return resourceToLogGroup(data.data, this);
  }

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
        await checkError(result.response);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal — called by `LogGroup.save()`. PUT /log_groups/{id} is upsert. */
  async _saveGroup(group: LogGroup): Promise<LogGroup> {
    if (group.id === null) throw new Error("Cannot save a LogGroup with no id");
    const body = groupToBody(group);
    let data: components["schemas"]["LogGroupResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/log_groups/{id}", {
        params: { path: { id: group.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplkitValidationError("Failed to save log group");
    return resourceToLogGroup(data.data, this);
  }
}
