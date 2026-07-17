/**
 * Live-updates socket seam — pure module.
 *
 * The real {@link SharedWebSocket} lives in `./ws.js`, whose import graph
 * carries the Node `ws` package. Sub-client modules (config, flags, logging)
 * must stay importable from edge runtimes via the `@smplkit/sdk/*` subpath
 * entries, so the socket factory is injected by the package ROOT entry
 * (`src/index.ts`) rather than imported statically. Via an edge entry the
 * factory is unset: constructing a client still works, `streaming: false`
 * gives the poll-with-`refresh()` stateless surface, and a live method that
 * would need the socket throws a clear {@link SmplError} instead.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { MetricsReporter } from "./_metrics.js";

/** Structural surface of the shared live-updates socket that sub-clients consume. */
export interface LiveSocket {
  on(eventName: string, callback: (data: Record<string, any>) => void): void;
  off(eventName: string, callback: (data: Record<string, any>) => void): void;
  start(): void;
  stop(): void;
  readonly connectionStatus: string;
}

/** @internal */
export type LiveSocketFactory = (
  appBaseUrl: string,
  apiKey: string,
  metrics: MetricsReporter | null,
) => LiveSocket;

let _factory: LiveSocketFactory | null = null;

/** @internal Wired by the package-root entry; the edge entries leave it unset. */
export function _setLiveSocketFactory(factory: LiveSocketFactory): void {
  _factory = factory;
}

/** @internal The injected factory, or `null` on edge entries. */
export function _liveSocketFactory(): LiveSocketFactory | null {
  return _factory;
}

/**
 * The error message thrown when a live surface needs the socket but no
 * factory is wired (an edge-entry import with `streaming` left on).
 * @internal
 */
export function noLiveSocketMessage(subpath: string): string {
  return (
    "Live updates aren't available from the @smplkit/sdk/" +
    subpath +
    " entry: WebSocket-driven updates need the package root " +
    '("@smplkit/sdk"). Construct the client with streaming: false to use ' +
    "the stateless surface (fetch on connect, poll with refresh()) instead."
  );
}
