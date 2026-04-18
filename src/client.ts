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
import { resolveConfig, serviceUrl } from "./config.js";
import { MetricsReporter } from "./_metrics.js";
import { debug } from "./_debug.js";

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
   * When omitted, resolved from the `SMPLKIT_ENVIRONMENT` environment variable
   * or the `~/.smplkit` configuration file.
   */
  environment?: string;

  /**
   * Service name. The SDK automatically registers the service as a
   * context instance and includes it in flag evaluation context.
   * When omitted, resolved from the `SMPLKIT_SERVICE` environment variable
   * or the `~/.smplkit` configuration file.
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

  /**
   * Configuration profile to use from `~/.smplkit`.
   * When omitted, resolved from `SMPLKIT_PROFILE` env var, falling back to `"default"`.
   */
  profile?: string;

  /**
   * Base domain for all service URLs.
   * When omitted, resolved from `SMPLKIT_BASE_DOMAIN` env var or config file,
   * falling back to `"smplkit.com"`.
   */
  baseDomain?: string;

  /**
   * URL scheme for service URLs (`"https"` or `"http"`).
   * When omitted, resolved from `SMPLKIT_SCHEME` env var or config file,
   * falling back to `"https"`.
   */
  scheme?: string;

  /**
   * Enable debug logging to stderr.
   * When omitted, resolved from `SMPLKIT_DEBUG` env var or config file,
   * falling back to `false`.
   */
  debug?: boolean;
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
  private readonly _appBaseUrl: string;
  private readonly _appHttp: ReturnType<typeof createClient<import("./generated/app.d.ts").paths>>;

  constructor(options: SmplClientOptions = {}) {
    const cfg = resolveConfig(options);

    this._apiKey = cfg.apiKey;
    this._environment = cfg.environment;
    this._service = cfg.service;
    this._timeout = options.timeout ?? 30_000;

    // Build service URLs from resolved config
    const appBaseUrl = serviceUrl(cfg.scheme, "app", cfg.baseDomain);
    const configBaseUrl = serviceUrl(cfg.scheme, "config", cfg.baseDomain);
    const flagsBaseUrl = serviceUrl(cfg.scheme, "flags", cfg.baseDomain);
    const loggingBaseUrl = serviceUrl(cfg.scheme, "logging", cfg.baseDomain);
    this._appBaseUrl = appBaseUrl;

    const maskedKey =
      cfg.apiKey.length > 14
        ? cfg.apiKey.slice(0, 10) + "..." + cfg.apiKey.slice(-4)
        : cfg.apiKey.slice(0, Math.min(4, cfg.apiKey.length)) + "...";
    debug(
      "lifecycle",
      `SmplClient created (api_key=${maskedKey}, environment=${cfg.environment}, service=${cfg.service})`,
    );

    this._appHttp = createClient<import("./generated/app.d.ts").paths>({
      baseUrl: appBaseUrl,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: "application/json",
      },
    });

    // Metrics reporter
    if (!cfg.disableTelemetry) {
      this._metrics = new MetricsReporter({
        apiKey: cfg.apiKey,
        environment: this._environment,
        service: this._service,
        appBaseUrl,
      });
    }

    this.config = new ConfigClient(cfg.apiKey, this._timeout, configBaseUrl);
    this.flags = new FlagsClient(
      cfg.apiKey,
      () => this._ensureWs(),
      this._timeout,
      flagsBaseUrl,
      appBaseUrl,
    );
    this.logging = new LoggingClient(cfg.apiKey, () => this._ensureWs(), this._timeout, loggingBaseUrl);

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
      this._wsManager = new SharedWebSocket(this._appBaseUrl, this._apiKey, this._metrics);
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
