/**
 * Shared WebSocket connection for real-time event delivery.
 */

import WebSocket from "ws";

/* eslint-disable @typescript-eslint/no-explicit-any */

type EventCallback = (data: Record<string, any>) => void;

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

/**
 * Manages a WebSocket connection for real-time event delivery.
 */
export class SharedWebSocket {
  private readonly _appBaseUrl: string;
  private readonly _apiKey: string;

  private _listeners: Map<string, EventCallback[]> = new Map();
  private _connectionStatus: string = "disconnected";
  private _closed = false;
  private _ws: InstanceType<typeof WebSocket> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _backoffIndex = 0;

  constructor(appBaseUrl: string, apiKey: string) {
    this._appBaseUrl = appBaseUrl;
    this._apiKey = apiKey;
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

  private _dispatch(eventName: string, data: Record<string, any>): void {
    const callbacks = this._listeners.get(eventName);
    if (callbacks) {
      for (const cb of [...callbacks]) {
        try {
          cb(data);
        } catch {
          // ignore listener errors
        }
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

  /** Start the WebSocket connection. */
  start(): void {
    this._closed = false;
    this._connect();
  }

  /** Stop the WebSocket connection. */
  stop(): void {
    this._closed = true;
    this._connectionStatus = "disconnected";

    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._ws !== null) {
      this._ws.close();
      this._ws = null;
    }
  }

  // ------------------------------------------------------------------
  // Connection internals
  // ------------------------------------------------------------------

  private _buildWsUrl(): string {
    let url = this._appBaseUrl;
    if (url.startsWith("https://")) {
      url = "wss://" + url.slice("https://".length);
    } else if (url.startsWith("http://")) {
      url = "ws://" + url.slice("http://".length);
    } else {
      url = "wss://" + url;
    }
    url = url.replace(/\/$/, "");
    return `${url}/api/ws/v1/events?api_key=${this._apiKey}`;
  }

  private _connect(): void {
    if (this._closed) return;

    this._connectionStatus = "connecting";
    const wsUrl = this._buildWsUrl();

    try {
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      ws.on("open", () => {
        if (this._closed) {
          ws.close();
          return;
        }
        // Don't set connected yet — wait for {"type": "connected"} confirmation
      });

      ws.on("message", (data: WebSocket.RawData) => {
        try {
          const raw = String(data);

          // Heartbeat: server sends "ping", we respond with "pong"
          if (raw === "ping") {
            ws.send("pong");
            return;
          }

          const msg = JSON.parse(raw) as Record<string, any>;

          // Connection confirmation
          if (msg.type === "connected") {
            this._backoffIndex = 0;
            this._connectionStatus = "connected";
            return;
          }

          // Error from server
          if (msg.type === "error") {
            return;
          }

          // Route events by the "event" field
          const eventName = msg.event as string | undefined;
          if (eventName) {
            this._dispatch(eventName, msg);
          }
        } catch {
          // ignore unparseable messages
        }
      });

      ws.on("close", () => {
        if (!this._closed) {
          this._connectionStatus = "disconnected";
          this._scheduleReconnect();
        }
      });

      ws.on("error", () => {
        // 'close' will fire after 'error'; reconnect is handled there
      });
    } catch {
      if (!this._closed) {
        this._scheduleReconnect();
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this._closed) return;

    const delay = BACKOFF_MS[Math.min(this._backoffIndex, BACKOFF_MS.length - 1)];
    this._backoffIndex++;
    this._connectionStatus = "connecting";

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }
}
