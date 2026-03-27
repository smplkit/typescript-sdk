/**
 * Top-level SDK client — SmplkitClient.
 *
 * The main entry point for the smplkit TypeScript SDK. Provides access
 * to sub-clients for each API domain (config, flags, logging, etc.).
 */

import { ConfigClient } from "./config/client.js";
import { Transport } from "./transport.js";

const DEFAULT_BASE_URL = "https://config.smplkit.com";

/** Configuration options for the {@link SmplkitClient}. */
export interface SmplkitClientOptions {
  /** API key for authenticating with the smplkit platform. */
  apiKey: string;

  /**
   * Base URL for all API requests.
   * @default "https://config.smplkit.com"
   */
  baseUrl?: string;

  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeout?: number;
}

/**
 * Entry point for the smplkit TypeScript SDK.
 *
 * @example
 * ```typescript
 * import { SmplkitClient } from "@smplkit/sdk";
 *
 * const client = new SmplkitClient({ apiKey: "sk_api_..." });
 * const cfg = await client.config.get({ key: "common" });
 * ```
 */
export class SmplkitClient {
  /** Client for config management-plane operations. */
  readonly config: ConfigClient;

  /** @internal */
  private readonly transport: Transport;

  constructor(options: SmplkitClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }

    this.transport = new Transport({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      timeout: options.timeout,
    });

    this.config = new ConfigClient(this.transport);
  }
}
