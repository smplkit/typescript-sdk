/**
 * Internal HTTP client wrapper.
 *
 * Uses native `fetch` with `AbortController` for timeouts. Maps network
 * errors and HTTP status codes to typed SDK exceptions.
 *
 * @internal This module is not part of the public API.
 */

import { buildAuthHeader } from "./auth.js";
import {
  SmplConnectionError,
  SmplConflictError,
  SmplError,
  SmplNotFoundError,
  SmplTimeoutError,
  SmplValidationError,
} from "./errors.js";

const SDK_VERSION = "0.0.0";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Options for constructing a {@link Transport} instance. */
export interface TransportOptions {
  /** The API key used for Bearer token authentication. */
  apiKey: string;

  /** Base URL for all API requests. Must not have a trailing slash. */
  baseUrl: string;

  /** Request timeout in milliseconds. Defaults to 30 000. */
  timeout?: number;
}

/** Parsed JSON response from the API. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

/**
 * Low-level HTTP transport that handles auth, timeouts, and error mapping.
 *
 * @internal
 */
export class Transport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: TransportOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Send a GET request.
   *
   * @param path - URL path relative to `baseUrl` (e.g. `/api/v1/configs`).
   * @param params - Optional query parameters.
   * @returns Parsed JSON response body.
   */
  async get(path: string, params?: Record<string, string>): Promise<JsonBody> {
    return this.request("GET", path, undefined, params);
  }

  /**
   * Send a POST request with a JSON body.
   *
   * @param path - URL path relative to `baseUrl`.
   * @param body - JSON-serializable request body.
   * @returns Parsed JSON response body.
   */
  async post(path: string, body: JsonBody): Promise<JsonBody> {
    return this.request("POST", path, body);
  }

  /**
   * Send a PUT request with a JSON body.
   *
   * @param path - URL path relative to `baseUrl`.
   * @param body - JSON-serializable request body.
   * @returns Parsed JSON response body.
   */
  async put(path: string, body: JsonBody): Promise<JsonBody> {
    return this.request("PUT", path, body);
  }

  /**
   * Send a DELETE request.
   *
   * @param path - URL path relative to `baseUrl`.
   * @returns Parsed JSON response body (empty object for 204 responses).
   */
  async delete(path: string): Promise<JsonBody> {
    return this.request("DELETE", path);
  }

  /**
   * Core request method. Handles headers, timeouts, and error mapping.
   */
  private async request(
    method: string,
    path: string,
    body?: JsonBody,
    params?: Record<string, string>,
  ): Promise<JsonBody> {
    let url = `${this.baseUrl}${path}`;

    if (params) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const headers: Record<string, string> = {
      Authorization: buildAuthHeader(this.apiKey),
      "User-Agent": `smplkit-typescript-sdk/${SDK_VERSION}`,
      Accept: "application/vnd.api+json",
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/vnd.api+json";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new SmplTimeoutError(`Request timed out after ${this.timeout}ms`);
      }
      if (error instanceof TypeError) {
        throw new SmplConnectionError(`Network error: ${error.message}`);
      }
      throw new SmplConnectionError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // 204 No Content — return empty object
    if (response.status === 204) {
      return {};
    }

    const responseText = await response.text();

    if (!response.ok) {
      this.throwForStatus(response.status, responseText);
    }

    try {
      return JSON.parse(responseText) as JsonBody;
    } catch {
      throw new SmplError(`Invalid JSON response: ${responseText}`, response.status, responseText);
    }
  }

  /**
   * Map HTTP error status codes to typed SDK exceptions.
   *
   * @throws {SmplNotFoundError} On 404.
   * @throws {SmplConflictError} On 409.
   * @throws {SmplValidationError} On 422.
   * @throws {SmplError} On any other non-2xx status.
   */
  private throwForStatus(status: number, body: string): never {
    switch (status) {
      case 404:
        throw new SmplNotFoundError(body, 404, body);
      case 409:
        throw new SmplConflictError(body, 409, body);
      case 422:
        throw new SmplValidationError(body, 422, body);
      default:
        throw new SmplError(`HTTP ${status}: ${body}`, status, body);
    }
  }
}
