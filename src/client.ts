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
import { SmplError } from "./errors.js";

const APP_BASE_URL = "https://app.smplkit.com";

const NO_ENVIRONMENT_MESSAGE =
  "No environment provided. Set one of:\n" +
  "  1. Pass environment to the constructor\n" +
  "  2. Set the SMPLKIT_ENVIRONMENT environment variable";

/** Configuration options for the {@link SmplClient}. */
export interface SmplClientOptions {
  /**
   * API key for authenticating with the smplkit platform.
   * When omitted, the SDK resolves it from the `SMPLKIT_API_KEY`
   * environment variable or the `~/.smplkit` configuration file.
   */
  apiKey?: string;

  /**
   * The environment to connect to (e.g. `"production"`, `"staging"`).
   * When omitted, resolved from the `SMPLKIT_ENVIRONMENT` environment variable.
   */
  environment?: string;

  /**
   * Optional service name. When set, the SDK automatically registers
   * the service as a context instance and includes it in flag
   * evaluation context.
   */
  service?: string;

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
 * const client = new SmplClient({ apiKey: "sk_api_...", environment: "production" });
 * await client.connect();
 * ```
 */
export class SmplClient {
  /** Client for config management-plane operations. */
  readonly config: ConfigClient;

  /** Client for flags management and runtime operations. */
  readonly flags: FlagsClient;

  private _wsManager: SharedWebSocket | null = null;
  private readonly _apiKey: string;

  /** @internal */
  readonly _environment: string;

  /** @internal */
  readonly _service: string | null;

  private _connected = false;
  private readonly _timeout: number;

  constructor(options: SmplClientOptions = {}) {
    const apiKey = resolveApiKey(options.apiKey);
    this._apiKey = apiKey;

    const environment = options.environment || process.env.SMPLKIT_ENVIRONMENT;
    if (!environment) {
      throw new SmplError(NO_ENVIRONMENT_MESSAGE);
    }
    this._environment = environment;
    this._service = options.service || process.env.SMPLKIT_SERVICE || null;

    this._timeout = options.timeout ?? 30_000;
    this.config = new ConfigClient(apiKey, this._timeout);
    this.flags = new FlagsClient(apiKey, () => this._ensureWs(), this._timeout);

    // Wire the shared WebSocket into the config client
    this.config._getSharedWs = () => this._ensureWs();

    // Wire parent reference into sub-clients
    this.flags._parent = this;
    this.config._parent = this;
  }

  /**
   * Connect to the smplkit platform.
   *
   * Fetches initial flag and config data, opens the shared WebSocket,
   * and registers the service as a context instance (if provided).
   *
   * This method is idempotent — calling it multiple times is safe.
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    // Register service context (fire-and-forget)
    if (this._service) {
      await this._registerServiceContext();
    }

    // Connect flags (fetch definitions, register WS listeners)
    await this.flags._connectInternal(this._environment);

    // Connect config (fetch all, resolve, cache)
    await this.config._connectInternal(this._environment);

    this._connected = true;
  }

  /** @internal */
  private async _registerServiceContext(): Promise<void> {
    try {
      await fetch(`${APP_BASE_URL}/api/v1/contexts/bulk`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contexts: [
            {
              type: "service",
              key: this._service,
              attributes: { name: this._service },
            },
          ],
        }),
      });
    } catch {
      // Fire-and-forget: log warning on failure
    }
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
