/**
 * Top-level SDK client — SmplClient.
 *
 * The main entry point for the smplkit TypeScript SDK. Provides access
 * to sub-clients for each API domain (config, flags, logging).
 */

import createClient from "openapi-fetch";
import { ConfigClient } from "./config/client.js";
import { FlagsClient } from "./flags/client.js";
import { LoggingClient } from "./logging/client.js";
import { SharedWebSocket } from "./ws.js";
import { resolveApiKey } from "./resolve.js";
import { SmplError } from "./errors.js";
import { MetricsReporter } from "./_metrics.js";
import { debug } from "./_debug.js";

const APP_BASE_URL = "https://app.smplkit.com";

const NO_ENVIRONMENT_MESSAGE =
  "No environment provided. Set one of:\n" +
  "  1. Pass environment to the constructor\n" +
  "  2. Set the SMPLKIT_ENVIRONMENT environment variable";

const NO_SERVICE_MESSAGE =
  "No service provided. Set one of:\n" +
  "  1. Pass service in options\n" +
  "  2. Set the SMPLKIT_SERVICE environment variable";

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
   * Service name. The SDK automatically registers the service as a
   * context instance and includes it in flag evaluation context.
   * When omitted, resolved from the `SMPLKIT_SERVICE` environment variable.
   */
  service?: string;

  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeout?: number;

  /**
   * Disable SDK telemetry reporting.
   * When `true`, no usage metrics are collected or sent.
   * @default false
   */
  disableTelemetry?: boolean;
}

/**
 * Entry point for the smplkit TypeScript SDK.
 *
 * @example
 * ```typescript
 * import { SmplClient } from "@smplkit/sdk";
 *
 * const client = new SmplClient({
 *   apiKey: "sk_api_...",
 *   environment: "production",
 *   service: "my-service",
 * });
 *
 * // Flags runtime
 * await client.flags.initialize();
 * const flag = client.flags.booleanFlag("checkout-v2", false);
 * console.log(flag.get());
 *
 * // Config runtime
 * const values = await client.config.get("user-service");
 * ```
 */
export class SmplClient {
  /** Client for config management and runtime. */
  readonly config: ConfigClient;

  /** Client for flags management and runtime. */
  readonly flags: FlagsClient;

  /** Client for logging management and runtime. */
  readonly logging: LoggingClient;

  private _wsManager: SharedWebSocket | null = null;
  private readonly _apiKey: string;

  /** @internal */
  readonly _environment: string;

  /** @internal */
  readonly _service: string;

  /** @internal */
  readonly _metrics: MetricsReporter | null = null;

  private readonly _timeout: number;
  private readonly _appHttp: ReturnType<typeof createClient<import("./generated/app.d.ts").paths>>;

  constructor(options: SmplClientOptions = {}) {
    // 1. Resolve environment first
    const environment = options.environment || process.env.SMPLKIT_ENVIRONMENT;
    if (!environment) {
      throw new SmplError(NO_ENVIRONMENT_MESSAGE);
    }
    this._environment = environment;

    // 2. Resolve service second
    const service = options.service || process.env.SMPLKIT_SERVICE;
    if (!service) {
      throw new SmplError(NO_SERVICE_MESSAGE);
    }
    this._service = service;

    // 3. Resolve API key last (receives the already-resolved environment)
    const apiKey = resolveApiKey(options.apiKey, environment);
    this._apiKey = apiKey;

    this._timeout = options.timeout ?? 30_000;

    const maskedKey =
      apiKey.length > 14
        ? apiKey.slice(0, 10) + "..." + apiKey.slice(-4)
        : apiKey.slice(0, Math.min(4, apiKey.length)) + "...";
    debug(
      "lifecycle",
      `SmplClient created (api_key=${maskedKey}, environment=${environment}, service=${service})`,
    );

    this._appHttp = createClient<import("./generated/app.d.ts").paths>({
      baseUrl: APP_BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });

    // 4. Metrics reporter
    if (!options.disableTelemetry) {
      this._metrics = new MetricsReporter({
        apiKey,
        environment: this._environment,
        service: this._service,
      });
    }

    this.config = new ConfigClient(apiKey, this._timeout);
    this.flags = new FlagsClient(apiKey, () => this._ensureWs(), this._timeout);
    this.logging = new LoggingClient(apiKey, () => this._ensureWs(), this._timeout);

    // Wire the shared WebSocket into the config client
    this.config._getSharedWs = () => this._ensureWs();

    // Wire parent reference into sub-clients
    this.flags._parent = this;
    this.config._parent = this;
    this.logging._parent = this;

    // Fire-and-forget: register service context
    void this._registerServiceContext();
  }

  /** @internal */
  private async _registerServiceContext(): Promise<void> {
    try {
      await this._appHttp.POST("/api/v1/contexts/bulk", {
        body: {
          contexts: [
            {
              type: "environment",
              key: this._environment,
            },
            {
              type: "service",
              key: this._service,
              attributes: { name: this._service },
            },
          ],
        },
      });
    } catch {
      // Fire-and-forget: log warning on failure
    }
  }

  /** Lazily create and start the shared WebSocket. @internal */
  private _ensureWs(): SharedWebSocket {
    if (this._wsManager === null) {
      this._wsManager = new SharedWebSocket(APP_BASE_URL, this._apiKey, this._metrics);
      this._wsManager.start();
    }
    return this._wsManager;
  }

  /** Close the shared WebSocket and release resources. */
  close(): void {
    debug("lifecycle", "SmplClient.close() called");
    if (this._metrics !== null) {
      this._metrics.close();
    }
    this.logging._close();
    if (this._wsManager !== null) {
      this._wsManager.stop();
      this._wsManager = null;
    }
  }
}
