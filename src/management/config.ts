/**
 * Management sub-client: `mgmt.config.*` — CRUD on Config resources.
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
import { Config, ConfigEnvironment, environmentsToWire } from "../config/types.js";
import { keyToDisplayName } from "../helpers.js";

type ConfigHttp = ReturnType<typeof createClient<import("../generated/config.d.ts").paths>>;

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
    } catch {
      // leave body empty; throwForStatus tolerates an empty payload
    }
  }
  if (!body) {
    body = await response.text().catch(() => "");
  }
  throwForStatus(response.status, body);
}

/** Build the JSON:API request body for create/update. @internal */
function buildBody(config: Config): {
  data: {
    id: string | null;
    type: "config";
    attributes: components["schemas"]["Config"];
  };
} {
  const attrs: components["schemas"]["Config"] = { name: config.name };
  if (config.description !== null) attrs.description = config.description;
  if (config.parent !== null) attrs.parent = config.parent;
  // Items: send the full typed dict as-is (already wire-shaped).
  attrs.items = config._itemsRawDirect as typeof attrs.items;
  attrs.environments = environmentsToWire(config._environmentsDirect) as typeof attrs.environments;
  return {
    data: {
      id: config.id ?? null,
      type: "config",
      attributes: attrs,
    },
  };
}

/** @internal */
function resourceToConfig(
  resource: components["schemas"]["ConfigResource"],
  client: ManagementConfigClient,
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

const CONFIG_REGISTRATION_FLUSH_SIZE = 50;

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

/**
 * `mgmt.config.*` — CRUD client for configs + bulk registration buffer.
 */
export class ManagementConfigClient {
  /** @internal */
  readonly _buffer = new ConfigRegistrationBuffer();

  /** @internal */
  constructor(private readonly _http: ConfigHttp) {}

  /** @internal — queue a configuration declaration for bulk-discovery upload. */
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
    if (this._buffer.pendingCount >= CONFIG_REGISTRATION_FLUSH_SIZE) {
      void this.flush();
    }
  }

  /** @internal — queue a config item declaration. */
  registerConfigItem(
    configId: string,
    itemKey: string,
    itemType: string,
    defaultValue: unknown,
    description: string | null,
  ): void {
    this._buffer.addItem(configId, itemKey, itemType, defaultValue, description);
    if (this._buffer.pendingCount >= CONFIG_REGISTRATION_FLUSH_SIZE) {
      void this.flush();
    }
  }

  /** Send any pending config declarations to `POST /api/v1/configs/bulk`. */
  async flush(): Promise<void> {
    const batch = this._buffer.drain();
    if (batch.length === 0) return;
    try {
      const result = await this._http.POST("/api/v1/configs/bulk", {
        body: { configs: batch } as never,
      });
      if (!result.response.ok) {
        // Per ADR-024 §2.9 bulk is plan-limit-exempt, but a transient
        // failure shouldn't crash customer code. Drained entries are
        // not requeued — the SDK will re-observe on the next process
        // start. Mirrors Python's fire-and-forget behavior.
      }
    } catch {
      // Fire-and-forget.
    }
  }

  /** Number of pending config declarations awaiting flush. */
  get pendingCount(): number {
    return this._buffer.pendingCount;
  }

  /** Construct an unsaved {@link Config}. Call `.save()` to persist. */
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
   * List configs.
   *
   * Server defaults are `pageNumber=1`, `pageSize=1000` (capped at 1000).
   * Omit both to fetch the first page; pass them through to walk further
   * pages. The wrapper does not loop on the customer's behalf — the
   * customer chooses how to paginate.
   */
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
    return data.data.map((r) => resourceToConfig(r, this));
  }

  /** Fetch a config by id. */
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
      throw new SmplkitNotFoundError(`Config with id ${JSON.stringify(id)} not found`);
    }
    return resourceToConfig(data.data, this);
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
    const body = buildBody(config);
    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/configs", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplkitValidationError("Failed to create config");
    return resourceToConfig(data.data, this);
  }

  /** @internal — called by `Config.save()` for existing resources. */
  async _updateConfig(config: Config): Promise<Config> {
    if (config.id === null) throw new Error("Cannot update a Config with no id");
    const body = buildBody(config);
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
    return resourceToConfig(data.data, this);
  }
}

// Suppress unused import warning — `SmplkitTimeoutError` is referenced for
// behavior parity but currently not thrown directly here.
void SmplkitTimeoutError;
void ConfigEnvironment;
