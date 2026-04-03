/**
 * Top-level SDK client — SmplClient.
 *
 * The main entry point for the smplkit TypeScript SDK. Provides access
 * to sub-clients for each API domain (config, flags, logging, etc.).
 */

import { ConfigClient } from "./config/client.js";
import { FlagsClient } from "./flags/client.js";
import { SharedWebSocket } from "./ws.js";
import { resolveApiKey } from "./resolve.js";

const APP_BASE_URL = "https://app.smplkit.com";

/** Configuration options for the {@link SmplClient}. */
export interface SmplClientOptions {
  /**
   * API key for authenticating with the smplkit platform.
   * When omitted, the SDK resolves it from the `SMPLKIT_API_KEY`
   * environment variable or the `~/.smplkit` configuration file.
   */
  apiKey?: string;

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

  /** Client for flags management and runtime operations. */
  readonly flags: FlagsClient;

  private _wsManager: SharedWebSocket | null = null;
  private readonly _apiKey: string;

  constructor(options: SmplClientOptions = {}) {
    const apiKey = resolveApiKey(options.apiKey);
    this._apiKey = apiKey;
    this.config = new ConfigClient(apiKey, options.timeout);
    this.flags = new FlagsClient(apiKey, () => this._ensureWs(), options.timeout);

    // Wire the shared WebSocket into the config client
    this.config._getSharedWs = () => this._ensureWs();
  }

  /** Lazily create and start the shared WebSocket. @internal */
  private _ensureWs(): SharedWebSocket {
    if (this._wsManager === null) {
      this._wsManager = new SharedWebSocket(APP_BASE_URL, this._apiKey);
      this._wsManager.start();
    }
    return this._wsManager;
  }

  /** Close the shared WebSocket and release resources. */
  close(): void {
    if (this._wsManager !== null) {
      this._wsManager.stop();
      this._wsManager = null;
    }
  }
}
