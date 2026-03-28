/**
 * ConfigClient — management-plane operations for configs.
 *
 * Provides CRUD operations on config resources. Obtained via
 * `SmplkitClient.config`.
 */

import { SmplNotFoundError, SmplValidationError } from "../errors.js";
import type { Transport } from "../transport.js";
import type { Config, CreateConfigOptions, GetConfigOptions } from "./types.js";

const BASE_URL = "https://config.smplkit.com";
const CONFIGS_PATH = "/api/v1/configs";

/**
 * JSON:API resource shape as returned by the Config API.
 * @internal
 */
interface JsonApiResource {
  id: string;
  type: string;
  attributes: {
    name: string;
    key: string;
    description: string | null;
    parent: string | null;
    values: Record<string, unknown> | null;
    environments: Record<string, Record<string, unknown>> | null;
    created_at: string | null;
    updated_at: string | null;
  };
}

/**
 * Client for the smplkit Config API.
 *
 * All methods are async and return `Promise<T>`. Network and server
 * errors are mapped to typed SDK exceptions.
 */
export class ConfigClient {
  /** @internal */
  private readonly transport: Transport;

  /** @internal */
  constructor(transport: Transport) {
    this.transport = transport;
  }

  /**
   * Fetch a single config by key or UUID.
   *
   * Exactly one of `key` or `id` must be provided.
   *
   * @param options - Lookup options.
   * @returns The matching config.
   * @throws {SmplNotFoundError} If no matching config exists.
   * @throws {Error} If neither or both of `key` and `id` are provided.
   */
  async get(options: GetConfigOptions): Promise<Config> {
    const { key, id } = options;

    if ((key === undefined) === (id === undefined)) {
      throw new Error("Exactly one of 'key' or 'id' must be provided.");
    }

    if (id !== undefined) {
      return this.getById(id);
    }

    return this.getByKey(key!);
  }

  /**
   * List all configs for the account.
   *
   * @returns An array of config objects.
   */
  async list(): Promise<Config[]> {
    const response = await this.transport.get(`${BASE_URL}${CONFIGS_PATH}`);
    const resources = response.data as JsonApiResource[];
    return resources.map((r) => this.resourceToModel(r));
  }

  /**
   * Create a new config.
   *
   * @param options - Config creation options.
   * @returns The created config.
   * @throws {SmplValidationError} If the server rejects the request.
   */
  async create(options: CreateConfigOptions): Promise<Config> {
    const body = this.buildRequestBody(options);
    const response = await this.transport.post(`${BASE_URL}${CONFIGS_PATH}`, body);

    if (!response.data) {
      throw new SmplValidationError("Failed to create config");
    }

    return this.resourceToModel(response.data as JsonApiResource);
  }

  /**
   * Delete a config by UUID.
   *
   * @param configId - The UUID of the config to delete.
   * @throws {SmplNotFoundError} If the config does not exist.
   * @throws {SmplConflictError} If the config has children.
   */
  async delete(configId: string): Promise<void> {
    await this.transport.delete(`${BASE_URL}${CONFIGS_PATH}/${configId}`);
  }

  /** Fetch a config by UUID. */
  private async getById(configId: string): Promise<Config> {
    const response = await this.transport.get(`${BASE_URL}${CONFIGS_PATH}/${configId}`);

    if (!response.data) {
      throw new SmplNotFoundError(`Config ${configId} not found`);
    }

    return this.resourceToModel(response.data as JsonApiResource);
  }

  /** Fetch a config by key using the list endpoint with a filter. */
  private async getByKey(key: string): Promise<Config> {
    const response = await this.transport.get(`${BASE_URL}${CONFIGS_PATH}`, { "filter[key]": key });
    const resources = response.data as JsonApiResource[];

    if (!resources || resources.length === 0) {
      throw new SmplNotFoundError(`Config with key '${key}' not found`);
    }

    return this.resourceToModel(resources[0]);
  }

  /**
   * Convert a JSON:API resource to a Config domain model.
   * @internal
   */
  private resourceToModel(resource: JsonApiResource): Config {
    const attrs = resource.attributes;
    return {
      id: resource.id,
      key: attrs.key ?? "",
      name: attrs.name,
      description: attrs.description ?? null,
      parent: attrs.parent ?? null,
      values: attrs.values ?? {},
      environments: attrs.environments ?? {},
      createdAt: attrs.created_at ? new Date(attrs.created_at) : null,
      updatedAt: attrs.updated_at ? new Date(attrs.updated_at) : null,
    };
  }

  /** Build a JSON:API request body for create operations. */
  private buildRequestBody(options: CreateConfigOptions): Record<string, unknown> {
    const attributes: Record<string, unknown> = {
      name: options.name,
    };

    if (options.key !== undefined) attributes.key = options.key;
    if (options.description !== undefined) attributes.description = options.description;
    if (options.parent !== undefined) attributes.parent = options.parent;
    if (options.values !== undefined) attributes.values = options.values;

    return {
      data: {
        type: "config",
        attributes,
      },
    };
  }
}
