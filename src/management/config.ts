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
async function checkError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
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

/**
 * `mgmt.config.*` — CRUD client for configs.
 */
export class ManagementConfigClient {
  /** @internal */
  constructor(private readonly _http: ConfigHttp) {}

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

  /** List all configs. */
  async list(): Promise<Config[]> {
    let data: components["schemas"]["ConfigListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs", {});
      if (!result.response.ok) await checkError(result.response);
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
      if (!result.response.ok) await checkError(result.response);
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
        await checkError(result.response);
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
      if (!result.response.ok) await checkError(result.response);
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
      if (!result.response.ok) await checkError(result.response);
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
