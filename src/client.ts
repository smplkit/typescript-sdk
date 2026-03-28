/**
 * Top-level SDK client — SmplkitClient.
 *
 * The main entry point for the smplkit TypeScript SDK. Provides access
 * to sub-clients for each API domain (config, flags, logging, etc.).
 */

import { ConfigClient } from "./config/client.js";

/** Configuration options for the {@link SmplkitClient}. */
export interface SmplkitClientOptions {
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
 * import { SmplkitClient } from "@smplkit/sdk";
 *
 * const client = new SmplkitClient({ apiKey: "sk_api_..." });
 * const cfg = await client.config.get({ key: "common" });
 * ```
 */
export class SmplkitClient {
  /** Client for config management-plane operations. */
  readonly config: ConfigClient;

  constructor(options: SmplkitClientOptions) {
    if (!options.apiKey) {
      throw new Error("apiKey is required");
    }

    this.config = new ConfigClient(options.apiKey, options.timeout);
  }
}
