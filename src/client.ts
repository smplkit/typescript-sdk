/**
 * Top-level SDK client — SmplClient.
 *
 * The main entry point for the smplkit TypeScript SDK. Provides access to
 * sub-clients for each API domain: `config`, `flags`, `logging`, `audit`,
 * `jobs`, `platform`, and `account`.
 */

import createClient from "openapi-fetch";
import { AuditClient } from "./audit/client.js";
import { ConfigClient } from "./config/client.js";
import { FlagsClient } from "./flags/client.js";
import { LoggingClient } from "./logging/client.js";
import { JobsClient } from "./jobs/client.js";
import { PlatformClient } from "./platform/client.js";
import { AccountClient } from "./account/client.js";
import { SmplTimeoutError } from "./errors.js";
import { SharedWebSocket } from "./ws.js";
import { resolveConfig, serviceUrl } from "./config.js";
import { MetricsReporter } from "./_metrics.js";
import { debug, enableDebug } from "./_debug.js";

type AppHttp = ReturnType<typeof createClient<import("./generated/app.d.ts").paths>>;

// Periodic flush of all sub-client registration buffers (contexts, flags,
// loggers, configs). Threshold flushes still fire immediately when buffers
// fill up; this timer is the liveness guarantee for the tail.
const PERIODIC_FLUSH_INTERVAL_MS = 60_000;

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
   * Enable anonymous usage telemetry.
   * When omitted, resolved from the `SMPLKIT_TELEMETRY` environment variable
   * or the `~/.smplkit` configuration file, falling back to `true`.
   * Set to `false` to disable telemetry collection entirely.
   * @default true
   */
  telemetry?: boolean;

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

  /**
   * Additional HTTP headers to include on every request made by this client
   * and all sub-clients (audit, config, flags, logging, jobs, platform,
   * account).
   *
   * SDK-owned headers (`Authorization`, `Accept`) take precedence over any
   * key supplied here — callers cannot override them.
   */
  extraHeaders?: Record<string, string>;
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
 * const checkoutV2 = client.flags.booleanFlag("checkout-v2", false);
 * if (await checkoutV2.get()) {
 *   // ...
 * }
 * ```
 */
export class SmplClient {
  /** Platform's cross-cutting CRUD — environments, services, contexts, context types. */
  readonly platform: PlatformClient;

  /** Account-level settings. */
  readonly account: AccountClient;

  /** Client for config management and runtime. */
  readonly config: ConfigClient;

  /** Client for flags management and runtime. */
  readonly flags: FlagsClient;

  /** Client for logging management and runtime. */
  readonly logging: LoggingClient;

  /** Client for the audit service — fire-and-forget event recording. */
  readonly audit: AuditClient;

  /** Client for scheduled jobs — CRUD, runs, and usage. */
  readonly jobs: JobsClient;

  private _wsManager: SharedWebSocket | null = null;
  private readonly _apiKey: string;

  // Read by wired sub-clients through the `*Parent` interfaces, so these stay
  // `readonly` (public) for structural assignability; `@internal` + the build's
  // `stripInternal` keep them out of the published `.d.ts`.
  /** @internal */
  readonly _environment: string;

  /** @internal */
  readonly _service: string | null;

  private _metrics: MetricsReporter | null = null;

  private readonly _timeout: number;
  private readonly _appBaseUrl: string;
  private readonly _appHttp: AppHttp;

  private _closed = false;
  private _started = false;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SmplClientOptions = {}) {
    const cfg = resolveConfig(options);

    if (cfg.debug) {
      enableDebug();
    }

    this._apiKey = cfg.apiKey;
    this._environment = cfg.environment ?? "";
    this._service = cfg.service;
    this._timeout = options.timeout ?? 30_000;

    // Build service URLs from resolved config
    const appBaseUrl = serviceUrl(cfg.scheme, "app", cfg.baseDomain);
    const configBaseUrl = serviceUrl(cfg.scheme, "config", cfg.baseDomain);
    const flagsBaseUrl = serviceUrl(cfg.scheme, "flags", cfg.baseDomain);
    const loggingBaseUrl = serviceUrl(cfg.scheme, "logging", cfg.baseDomain);
    const jobsBaseUrl = serviceUrl(cfg.scheme, "jobs", cfg.baseDomain);
    const auditBaseUrl = serviceUrl(cfg.scheme, "audit", cfg.baseDomain);
    this._appBaseUrl = appBaseUrl;

    const maskedKey =
      cfg.apiKey.length > 14
        ? cfg.apiKey.slice(0, 10) + "..." + cfg.apiKey.slice(-4)
        : cfg.apiKey.slice(0, Math.min(4, cfg.apiKey.length)) + "...";
    debug(
      "lifecycle",
      `SmplClient created (api_key=${maskedKey}, environment=${cfg.environment}, service=${cfg.service})`,
    );

    const extraHeaders = options.extraHeaders ?? {};

    // Shared HTTP transports — single connection pool per service.
    const headers = {
      ...extraHeaders,
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
    };
    // JSON:API services (jobs) negotiate the vendor media type.
    const jsonApiHeaders = {
      ...extraHeaders,
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
    };

    this._appHttp = createClient<import("./generated/app.d.ts").paths>({
      baseUrl: appBaseUrl,
      headers,
    });
    const configHttp = createClient<import("./generated/config.d.ts").paths>({
      baseUrl: configBaseUrl,
      headers,
    });
    const flagsHttp = createClient<import("./generated/flags.d.ts").paths>({
      baseUrl: flagsBaseUrl,
      headers,
    });
    const loggingHttp = createClient<import("./generated/logging.d.ts").paths>({
      baseUrl: loggingBaseUrl,
      headers,
    });
    const jobsHttp = createClient<import("./generated/jobs.d.ts").paths>({
      baseUrl: jobsBaseUrl,
      headers: jsonApiHeaders,
    });

    // Metrics reporter
    if (cfg.telemetry) {
      this._metrics = new MetricsReporter({
        apiKey: cfg.apiKey,
        environment: this._environment,
        service: this._service,
        appBaseUrl,
      });
    }

    // Platform's cross-cutting CRUD on one client; wired into this parent so it
    // borrows the shared app transport, and owns the context-registration
    // buffer. Built BEFORE flags so the contexts seam below is available.
    this.platform = new PlatformClient({ appTransport: this._appHttp });
    // Account-level settings; built from the app url + api key.
    this.account = new AccountClient({ apiKey: cfg.apiKey, baseUrl: appBaseUrl, extraHeaders });
    // Config's full surface on one client; wired into this parent so it borrows
    // the shared config transport and WebSocket.
    this.config = new ConfigClient({ parent: this, transport: configHttp, metrics: this._metrics });
    // Flags' full surface on one client; wired into this parent so it borrows
    // the shared flags transport and WebSocket. `contexts` is the injection
    // seam for evaluation-context registration, wired to
    // `client.platform.contexts`.
    this.flags = new FlagsClient({
      parent: this,
      transport: flagsHttp,
      contexts: this.platform.contexts,
      metrics: this._metrics,
    });
    // Logging's full surface on one client; wired into this parent so it
    // borrows the shared logging transport and WebSocket. The two management
    // sub-clients live at client.logging.loggers / client.logging.logGroups.
    this.logging = new LoggingClient({
      parent: this,
      transport: loggingHttp,
      metrics: this._metrics,
    });
    // Audit's full surface on one client; this runtime instance carries the
    // configured environment as `X-Smplkit-Environment` and owns its own
    // transport (closed in `close()`).
    this.audit = new AuditClient({
      apiKey: cfg.apiKey,
      baseUrl: auditBaseUrl,
      environment: this._environment,
      timeoutMs: this._timeout,
      extraHeaders,
    });
    // Jobs has no runtime/management split — reuse the shared jobs transport
    // (single connection pool) so `client.jobs` is one-stop.
    this.jobs = new JobsClient({ transport: jobsHttp });

    // Construction is side-effect-free: no background timers, no phone-home.
    // The periodic registration-buffer flush and the service-context
    // registration are deferred until the first config/flags/logging operation
    // or WebSocket open via `_ensureStarted` — so an audit-only or jobs-only
    // customer pays zero timers and zero network at construction.
  }

  /**
   * Start the deferred background machinery exactly once.
   *
   * Idempotent; a no-op after `close()`. Triggered by the first
   * config/flags/logging operation or WebSocket open — never at construction.
   * @internal
   */
  _ensureStarted(): void {
    if (this._started || this._closed) return;
    this._started = true;
    this._schedulePeriodicFlush();
    void this._registerServiceContext();
  }

  /** Tick the periodic registration-buffer flush. Self-rescheduling. @internal */
  private _schedulePeriodicFlush(): void {
    const tick = (): void => {
      if (this._closed) return;
      void Promise.allSettled([
        this.platform.contexts.flush(),
        this.flags.flush(),
        this.logging.loggers.flush(),
        this.config.flush(),
      ]).then(() => {
        if (!this._closed) this._schedulePeriodicFlush();
      });
    };
    this._flushTimer = setTimeout(tick, PERIODIC_FLUSH_INTERVAL_MS);
    // Don't keep the event loop alive (mirrors Python's daemon timer).
    if (typeof this._flushTimer.unref === "function") this._flushTimer.unref();
  }

  /**
   * Register the environment and/or service as context instances on the app
   * service. Only the values that are set are registered; if neither
   * environment nor service was provided the POST is skipped entirely (an
   * audit/jobs-only customer has nothing to register). Fire-and-forget —
   * failures never propagate to customer code.
   * @internal
   */
  private async _registerServiceContext(): Promise<void> {
    try {
      const contexts: Array<{ type: string; key: string; attributes?: { name: string } }> = [];
      if (this._environment) {
        contexts.push({ type: "environment", key: this._environment });
      }
      if (this._service) {
        contexts.push({ type: "service", key: this._service, attributes: { name: this._service } });
      }
      if (contexts.length === 0) return;
      await this._appHttp.POST("/api/v1/contexts/bulk", { body: { contexts } });
    } catch {
      // Fire-and-forget: failures never propagate.
    }
  }

  /** Lazily create and start the shared WebSocket. @internal */
  _ensureWs(): SharedWebSocket {
    this._ensureStarted();
    if (this._wsManager === null) {
      this._wsManager = new SharedWebSocket(this._appBaseUrl, this._apiKey, this._metrics);
      this._wsManager.start();
    }
    return this._wsManager;
  }

  /**
   * Optionally pre-warm the SDK and block until the live socket is up.
   *
   * Eagerly connects config and flags — flushing discovery, pre-fetching all
   * flags and configs into the local cache, opening the live-updates
   * WebSocket — and waits for the handshake to complete. After this returns,
   * `flag.get()` / `client.config.subscribe()` hit cache (no first-request
   * connect tax) and any `onChange` listeners receive every server event from
   * this point forward.
   *
   * Optional: config and flags connect lazily on first live use, so this is
   * purely a pre-warm / WebSocket-ready barrier. Logging integration is *not*
   * connected here — call `await client.logging.install()` separately if you
   * want it (it installs adapters and hooks into your application's logger,
   * which should be opt-in).
   *
   * @throws SmplTimeoutError If the WebSocket fails to connect within
   *   `timeoutMs` milliseconds.
   */
  async waitUntilReady(options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    await this.flags._ensureConnected();
    await this.config._ensureConnected();
    const ws = this._ensureWs();
    const deadline = Date.now() + timeoutMs;
    while (ws.connectionStatus !== "connected") {
      if (Date.now() >= deadline) {
        throw new SmplTimeoutError(
          `Live-updates websocket did not connect within ${timeoutMs}ms ` +
            `(status: ${JSON.stringify(ws.connectionStatus)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Release all resources held by this client. */
  close(): void {
    debug("lifecycle", "SmplClient.close() called");
    this._closed = true;
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    // Drain every registration buffer one last time on close (best-effort).
    void Promise.allSettled([
      this.platform.contexts.flush(),
      this.flags.flush(),
      this.logging.loggers.flush(),
      this.config.flush(),
    ]);
    if (this._metrics !== null) {
      this._metrics.close();
    }
    this.logging.close();
    this.flags.close();
    this.config.close();
    void this.audit._close();
    if (this._wsManager !== null) {
      this._wsManager.stop();
      this._wsManager = null;
    }
  }
}
