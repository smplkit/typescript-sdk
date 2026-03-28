/**
 * Top-level SDK client — SmplClient.
 *
 * The main entry point for the smplkit TypeScript SDK. Provides access
 * to sub-clients for each API domain (config, flags, logging, etc.).
 */

import { ConfigClient } from "./config/client.js";

/** Configuration options for the {@link SmplClient}. */
export interface SmplClientOptions {
  /** API key for authenticating with the smplkit platform. */
  apiKey: string;

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
 * import { SmplClient } from "@smplkit/sdk";
 *
 * const client = new SmplClient({ apiKey: "sk_api_..." });
 * const cfg = await client.config.get({ key: "common" });
 * ```
 */
export class SmplClient {
  /** Client for config management-plane operations. */
  readonly config: ConfigClient;

  constructor(options: SmplClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }

    this.config = new ConfigClient(options.apiKey, options.timeout);
  }
}
