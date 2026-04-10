/**
 * Internal HTTP client wrapper.
 *
 * @internal This module is not part of the public API.
 */

import { buildAuthHeader } from "./auth.js";
import { SmplConnectionError, SmplError, SmplTimeoutError, throwForStatus } from "./errors.js";

const SDK_VERSION = "0.0.0";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Options for constructing a {@link Transport} instance. */
export interface TransportOptions {
  /** The API key used for Bearer token authentication. */
  apiKey: string;

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
  private readonly timeout: number;

  constructor(options: TransportOptions) {
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Send a GET request.
   *
   * @param url - Fully-qualified URL (e.g. `https://config.smplkit.com/api/v1/configs`).
   * @param params - Optional query parameters.
   * @returns Parsed JSON response body.
   */
  async get(url: string, params?: Record<string, string>): Promise<JsonBody> {
    return this.request("GET", url, undefined, params);
  }

  /**
   * Send a POST request with a JSON body.
   *
   * @param url - Fully-qualified URL.
   * @param body - JSON-serializable request body.
   * @returns Parsed JSON response body.
   */
  async post(url: string, body: JsonBody): Promise<JsonBody> {
    return this.request("POST", url, body);
  }

  /**
   * Send a PUT request with a JSON body.
   *
   * @param url - Fully-qualified URL.
   * @param body - JSON-serializable request body.
   * @returns Parsed JSON response body.
   */
  async put(url: string, body: JsonBody): Promise<JsonBody> {
    return this.request("PUT", url, body);
  }

  /**
   * Send a DELETE request.
   *
   * @param url - Fully-qualified URL.
   * @returns Parsed JSON response body (empty object for 204 responses).
   */
  async delete(url: string): Promise<JsonBody> {
    return this.request("DELETE", url);
  }

  /**
   * Core request method. Handles headers, timeouts, and error mapping.
   */
  private async request(
    method: string,
    url: string,
    body?: JsonBody,
    params?: Record<string, string>,
  ): Promise<JsonBody> {
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
      throwForStatus(response.status, responseText);
    }

    try {
      return JSON.parse(responseText) as JsonBody;
    } catch {
      throw new SmplError(`Invalid JSON response: ${responseText}`, response.status, responseText);
    }
  }
}
