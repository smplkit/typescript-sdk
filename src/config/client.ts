/**
 * ConfigClient — management-plane operations for configs.
 *
 * Uses the generated OpenAPI types (`src/generated/config.d.ts`) via
 * `openapi-fetch` for all HTTP calls, keeping the client layer fully
 * type-safe without hand-coded request/response shapes.
 */

import createClient from "openapi-fetch";
import type { components, operations } from "../generated/config.d.ts";
import {
  SmplConflictError,
  SmplNotFoundError,
  SmplValidationError,
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
} from "../errors.js";
import { Config } from "./types.js";
import type { ConfigUpdatePayload, CreateConfigOptions, GetConfigOptions } from "./types.js";

const BASE_URL = "https://config.smplkit.com";

type ApiConfig = components["schemas"]["Config"];
type ConfigResource = components["schemas"]["ConfigResource"];

/** @internal */
function resourceToConfig(resource: ConfigResource, client: ConfigClient): Config {
  const attrs: ApiConfig = resource.attributes;
  return new Config(client, {
    id: resource.id ?? "",
    key: attrs.key ?? "",
    name: attrs.name,
    description: attrs.description ?? null,
    parent: attrs.parent ?? null,
    values: (attrs.values ?? {}) as Record<string, unknown>,
    environments: (attrs.environments ?? {}) as Record<string, unknown>,
    createdAt: attrs.created_at ? new Date(attrs.created_at) : null,
    updatedAt: attrs.updated_at ? new Date(attrs.updated_at) : null,
  });
}

/**
 * Map fetch or HTTP errors to typed SDK exceptions.
 * @internal
 */
async function checkError(response: Response, context: string): Promise<never> {
  const body = await response.text().catch(() => "");
  switch (response.status) {
    case 404:
      throw new SmplNotFoundError(body || context, 404, body);
    case 409:
      throw new SmplConflictError(body || context, 409, body);
    case 422:
      throw new SmplValidationError(body || context, 422, body);
    default:
      throw new SmplError(`HTTP ${response.status}: ${body}`, response.status, body);
  }
}

/**
 * Re-raise fetch-level errors (network, timeout) as typed SDK exceptions.
 * @internal
 */
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
 * Build a JSON:API request body for create/update operations.
 * @internal
 */
function buildRequestBody(options: {
  id?: string | null;
  name: string;
  key?: string | null;
  description?: string | null;
  parent?: string | null;
  values?: Record<string, unknown> | null;
  environments?: Record<string, unknown> | null;
}): operations["create_config"]["requestBody"]["content"]["application/json"] {
  const attrs: ApiConfig = {
    name: options.name,
  };
  if (options.key !== undefined) attrs.key = options.key;
  if (options.description !== undefined) attrs.description = options.description;
  if (options.parent !== undefined) attrs.parent = options.parent;
  if (options.values !== undefined)
    attrs.values = options.values as { [key: string]: unknown } | null;
  if (options.environments !== undefined)
    attrs.environments = options.environments as { [key: string]: unknown } | null;

  return {
    data: {
      id: options.id ?? null,
      type: "config",
      attributes: attrs,
    },
  };
}

/**
 * Client for the smplkit Config API (management plane).
 *
 * All methods are async and return `Promise<T>`. Network and server
 * errors are mapped to typed SDK exceptions.
 *
 * Obtained via `SmplClient.config`.
 */
export class ConfigClient {
  /** @internal — used by Config instances for reconnecting and WebSocket auth. */
  readonly _apiKey: string;

  /** @internal */
  readonly _baseUrl: string = BASE_URL;

  /** @internal */
  private readonly _http: ReturnType<typeof createClient<import("../generated/config.d.ts").paths>>;

  /** @internal */
  constructor(apiKey: string, timeout?: number) {
    this._apiKey = apiKey;
    const ms = timeout ?? 30_000;
    this._http = createClient<import("../generated/config.d.ts").paths>({
      baseUrl: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      // openapi-fetch custom fetch receives a pre-built Request object
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

  /**
   * Fetch a single config by key or UUID.
   *
   * Exactly one of `key` or `id` must be provided.
   *
   * @throws {SmplNotFoundError} If no matching config exists.
   */
  async get(options: GetConfigOptions): Promise<Config> {
    const { key, id } = options;
    if ((key === undefined) === (id === undefined)) {
      throw new Error("Exactly one of 'key' or 'id' must be provided.");
    }
    return id !== undefined ? this._getById(id) : this._getByKey(key!);
  }

  /**
   * List all configs for the account.
   */
  async list(): Promise<Config[]> {
    let data: components["schemas"]["ConfigListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs", {});
      if (result.error !== undefined) await checkError(result.response, "Failed to list configs");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToConfig(r, this));
  }

  /**
   * Create a new config.
   *
   * @throws {SmplValidationError} If the server rejects the request.
   */
  async create(options: CreateConfigOptions): Promise<Config> {
    const body = buildRequestBody({
      name: options.name,
      key: options.key,
      description: options.description,
      parent: options.parent,
      values: options.values,
    });

    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/configs", { body });
      if (result.error !== undefined) await checkError(result.response, "Failed to create config");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError("Failed to create config");
    return resourceToConfig(data.data, this);
  }

  /**
   * Delete a config by UUID.
   *
   * @throws {SmplNotFoundError} If the config does not exist.
   * @throws {SmplConflictError} If the config has child configs.
   */
  async delete(configId: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/configs/{id}", {
        params: { path: { id: configId } },
      });
      if (result.error !== undefined && result.response.status !== 204)
        await checkError(result.response, `Failed to delete config ${configId}`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * Internal: PUT a full config update and return the updated model.
   *
   * Called by {@link Config} instance methods.
   * @internal
   */
  async _updateConfig(payload: ConfigUpdatePayload): Promise<Config> {
    const body = buildRequestBody({
      id: payload.configId,
      name: payload.name,
      key: payload.key,
      description: payload.description,
      parent: payload.parent,
      values: payload.values,
      environments: payload.environments,
    });

    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/configs/{id}", {
        params: { path: { id: payload.configId } },
        body,
      });
      if (result.error !== undefined)
        await checkError(result.response, `Failed to update config ${payload.configId}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data)
      throw new SmplValidationError(`Failed to update config ${payload.configId}`);
    return resourceToConfig(data.data, this);
  }

  // ---- Private helpers ----

  private async _getById(configId: string): Promise<Config> {
    let data: components["schemas"]["ConfigResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs/{id}", {
        params: { path: { id: configId } },
      });
      if (result.error !== undefined)
        await checkError(result.response, `Config ${configId} not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplNotFoundError(`Config ${configId} not found`);
    return resourceToConfig(data.data, this);
  }

  private async _getByKey(key: string): Promise<Config> {
    let data: components["schemas"]["ConfigListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/configs", {
        params: { query: { "filter[key]": key } },
      });
      if (result.error !== undefined)
        await checkError(result.response, `Config with key '${key}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data || data.data.length === 0) {
      throw new SmplNotFoundError(`Config with key '${key}' not found`);
    }
    return resourceToConfig(data.data[0], this);
  }
}
