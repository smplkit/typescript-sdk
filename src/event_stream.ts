/**
 * Shared live-updates stream for real-time event delivery.
 *
 * Connects to the platform's event endpoint over plain HTTPS using the
 * native `fetch` API and incrementally parses the response body as a
 * Server-Sent Events (SSE) stream. The import graph is free of Node
 * built-ins, so every `@smplkit/sdk/*` subpath entry can use it —
 * including edge runtimes such as Cloudflare Workers.
 */

import type { MetricsReporter } from "./_metrics.js";
import { debug } from "./_debug.js";
import { SDK_USER_AGENT } from "./user_agent.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

type EventCallback = (data: Record<string, any>) => void;

/** Base reconnect delay until the server supplies a `retry:` value. */
const DEFAULT_RETRY_MS = 1000;

/** Reconnect delays double up to this cap. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Liveness read timeout — two missed server keepalives (30s apart). Any
 * bytes on the stream (including comment frames) reset the timer; on
 * expiry the connection is dropped and the reconnect loop takes over.
 */
const READ_TIMEOUT_MS = 45_000;

/**
 * Incremental SSE frame parser.
 *
 * Accepts `\n`, `\r\n`, and `\r` line terminators (safe across chunk
 * boundaries), strips a leading BOM, treats lines starting with `:` as
 * comments, joins multiple `data:` lines with `\n`, ignores unknown
 * fields, and dispatches accumulated `event:`/`data:` fields on each
 * blank line. `retry:` values are reported through a dedicated callback.
 * @internal
 */
class SseParser {
  private _buffer = "";
  private _strippedBom = false;
  private _skipLf = false;
  private _eventName = "";
  private _dataLines: string[] = [];

  constructor(
    private readonly _onEvent: (eventName: string, data: string) => void,
    private readonly _onRetry: (ms: number) => void,
  ) {}

  /** Feed a decoded chunk; chunks may split lines (and frames) anywhere. */
  feed(text: string): void {
    if (!this._strippedBom && text.length > 0) {
      if (text.startsWith("\uFEFF")) text = text.slice(1);
      this._strippedBom = true;
    }
    if (this._skipLf) {
      // The previous chunk ended in `\r` (already treated as a line
      // terminator); a `\n` opening this chunk is the second half of a
      // split `\r\n`, not a new blank line.
      if (text.startsWith("\n")) text = text.slice(1);
      this._skipLf = false;
    }
    this._buffer += text;

    const buf = this._buffer;
    let pos = 0;
    for (;;) {
      const cr = buf.indexOf("\r", pos);
      const lf = buf.indexOf("\n", pos);
      if (cr === -1 && lf === -1) break;
      let lineEnd: number;
      let nextPos: number;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        lineEnd = cr;
        if (cr === buf.length - 1) {
          // A trailing `\r` terminates its line now; remember to swallow a
          // leading `\n` in the next chunk (a `\r\n` split at the boundary).
          nextPos = cr + 1;
          this._skipLf = true;
        } else {
          nextPos = buf[cr + 1] === "\n" ? cr + 2 : cr + 1;
        }
      } else {
        lineEnd = lf;
        nextPos = lf + 1;
      }
      this._processLine(buf.slice(pos, lineEnd));
      pos = nextPos;
    }
    this._buffer = buf.slice(pos);
  }

  private _processLine(line: string): void {
    if (line === "") {
      this._dispatchPending();
      return;
    }
    if (line.startsWith(":")) {
      // Comment frame (e.g. the server keepalive) — nothing to accumulate;
      // liveness is accounted at the read level, where any bytes reset the
      // watchdog.
      return;
    }
    const colon = line.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "event":
        this._eventName = value;
        break;
      case "data":
        this._dataLines.push(value);
        break;
      case "retry":
        if (/^\d+$/.test(value)) this._onRetry(Number(value));
        break;
      default:
        // Unknown fields are ignored per the SSE spec.
        break;
    }
  }

  private _dispatchPending(): void {
    const eventName = this._eventName;
    const data = this._dataLines.join("\n");
    this._eventName = "";
    this._dataLines = [];
    // A blank line with an empty data buffer dispatches nothing.
    if (data === "") return;
    this._onEvent(eventName, data);
  }
}

/**
 * Manages the live event-stream connection for real-time event delivery.
 * @internal
 */
export class EventStream {
  private readonly _appBaseUrl: string;
  private readonly _apiKey: string;
  private readonly _metrics: MetricsReporter | null;

  private _listeners: Map<string, EventCallback[]> = new Map();
  private _refetchCallbacks: Array<() => void> = [];
  private _connectionStatus: string = "disconnected";
  private _closed = false;
  private _controller: AbortController | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private _retryMs = DEFAULT_RETRY_MS;
  private _backoffAttempt = 0;
  private _everConnected = false;

  constructor(appBaseUrl: string, apiKey: string, metrics?: MetricsReporter | null) {
    this._appBaseUrl = appBaseUrl;
    this._apiKey = apiKey;
    this._metrics = metrics ?? null;
  }

  // ------------------------------------------------------------------
  // Listener registration
  // ------------------------------------------------------------------

  /** Register a listener for a specific event type. */
  on(eventName: string, callback: EventCallback): void {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, []);
    }
    this._listeners.get(eventName)!.push(callback);
  }

  /** Unregister a listener for a specific event type. */
  off(eventName: string, callback: EventCallback): void {
    const list = this._listeners.get(eventName);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
    }
  }

  /**
   * Register a refetch callback invoked on every successful *re*connect
   * (never on the initial connect). Product modules use this to run their
   * full bulk refresh so changes that happened while the stream was down
   * are picked up and diffed through the normal listener path.
   */
  onReconnect(callback: () => void): void {
    this._refetchCallbacks.push(callback);
  }

  /** Unregister a refetch callback. */
  offReconnect(callback: () => void): void {
    const idx = this._refetchCallbacks.indexOf(callback);
    if (idx !== -1) {
      this._refetchCallbacks.splice(idx, 1);
    }
  }

  private _dispatch(eventName: string, data: Record<string, any>): void {
    const callbacks = this._listeners.get(eventName);
    if (!callbacks || callbacks.length === 0) {
      debug("events", `no handler registered for event: "${eventName}"`);
      return;
    }
    debug("events", `routing "${eventName}" to ${callbacks.length} handler(s)`);
    for (const cb of [...callbacks]) {
      try {
        cb(data);
      } catch {
        // ignore listener errors
      }
    }
  }

  // ------------------------------------------------------------------
  // Connection status
  // ------------------------------------------------------------------

  get connectionStatus(): string {
    return this._connectionStatus;
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Start the event-stream connection. */
  start(): void {
    debug("events", "starting event-stream connection");
    this._closed = false;
    this._connect();
  }

  /** Stop the event-stream connection. */
  stop(): void {
    debug("events", "stopping event-stream connection");
    this._closed = true;
    this._connectionStatus = "disconnected";

    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._clearWatchdog();

    if (this._controller !== null) {
      this._controller.abort();
      this._controller = null;
    }
  }

  // ------------------------------------------------------------------
  // Connection internals
  // ------------------------------------------------------------------

  private _buildStreamUrl(): string {
    let url = this._appBaseUrl;
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      url = "https://" + url;
    }
    url = url.replace(/\/$/, "");
    return `${url}/api/v1/events`;
  }

  private _connect(): void {
    if (this._closed) return;
    this._connectionStatus = "connecting";
    void this._run();
  }

  private async _run(): Promise<void> {
    const url = this._buildStreamUrl();
    debug("events", `connecting to ${url}`);

    const controller = new AbortController();
    this._controller = controller;
    let connected = false;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          Accept: "text/event-stream",
          // Some edges in front of the platform (CloudFront's managed WAF
          // rules) reject requests that carry no User-Agent header, and not
          // every runtime sends one by default — inject the SDK default to
          // match the HTTP transport.
          "User-Agent": SDK_USER_AGENT,
        },
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("text/event-stream") || response.body === null) {
        debug(
          "events",
          `connection attempt failed (status=${response.status}, content-type=${JSON.stringify(contentType)})`,
        );
        void response.body?.cancel().catch(() => undefined);
      } else {
        // Successful connect: HTTP 200 with an event-stream body.
        connected = true;
        const isReconnect = this._everConnected;
        this._everConnected = true;
        this._backoffAttempt = 0;
        this._connectionStatus = "connected";
        debug("events", `connected to ${url}`);
        if (this._metrics) {
          this._metrics.recordGauge("platform.event_connections", 1, "connections");
        }
        if (isReconnect) {
          debug(
            "events",
            `reconnected — invoking ${this._refetchCallbacks.length} refetch callback(s)`,
          );
          for (const cb of [...this._refetchCallbacks]) {
            try {
              cb();
            } catch {
              // ignore refetch errors
            }
          }
        }

        const parser = new SseParser(this._handleFrame, this._handleRetry);
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        this._armWatchdog(controller);
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this._closed) break;
          // ANY bytes — including comment/keepalive frames — count as
          // liveness and reset the read-timeout watchdog.
          this._armWatchdog(controller);
          parser.feed(decoder.decode(value, { stream: true }));
        }
        debug("events", "stream ended");
      }
    } catch (err) {
      debug("events", `stream error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this._clearWatchdog();
      if (this._controller === controller) {
        this._controller = null;
      }
      if (connected && this._metrics) {
        this._metrics.recordGauge("platform.event_connections", 0, "connections");
      }
      if (!this._closed) {
        this._connectionStatus = "disconnected";
        this._scheduleReconnect();
      }
    }
  }

  /** Parsed-frame sink: decode the JSON payload and route by event name. */
  private _handleFrame = (eventName: string, data: string): void => {
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(data) as Record<string, any>;
    } catch {
      debug("events", `ignoring event "${eventName}" with unparseable payload`);
      return;
    }
    debug("events", `event received: ${eventName} ${data}`);
    this._dispatch(eventName, payload);
  };

  /** Server-supplied `retry:` value reseeds the backoff base. */
  private _handleRetry = (ms: number): void => {
    debug("events", `server retry interval: ${ms}ms`);
    this._retryMs = ms;
  };

  private _armWatchdog(controller: AbortController): void {
    this._clearWatchdog();
    this._watchdogTimer = setTimeout(() => {
      this._watchdogTimer = null;
      debug("events", `no data received for ${READ_TIMEOUT_MS}ms — dropping the connection`);
      controller.abort();
    }, READ_TIMEOUT_MS);
  }

  private _clearWatchdog(): void {
    if (this._watchdogTimer !== null) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(this._retryMs * 2 ** this._backoffAttempt, MAX_BACKOFF_MS);
    this._backoffAttempt++;
    this._connectionStatus = "connecting";
    debug("events", `reconnecting in ${delay}ms (attempt ${this._backoffAttempt})`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }
}
