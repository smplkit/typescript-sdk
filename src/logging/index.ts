/**
 * Smpl Logging SDK namespace.
 *
 * One {@link LoggingClient} exposes the full surface — logger and log-group
 * CRUD (`loggers` / `logGroups`) plus the live integration surface
 * (`install` / `onChange` / `refresh`) — reachable as `client.logging` on
 * {@link SmplClient} or constructed directly.
 *
 * This module is also the package's `@smplkit/sdk/logging` subpath — the
 * edge/serverless entry. Its import graph is free of Node built-ins, so it
 * bundles for edge runtimes (e.g. Cloudflare Workers). Differences from the
 * package root there:
 *
 * - Configuration resolves from defaults → the `SMPLKIT_API_KEY` /
 *   `SMPLKIT_BASE_DOMAIN` / `SMPLKIT_SCHEME` / `SMPLKIT_ENVIRONMENT` /
 *   `SMPLKIT_SERVICE` environment variables → constructor options, exactly
 *   like the root — minus the `~/.smplkit` file step (that machinery needs
 *   `node:fs`, and an isolate has no home directory anyway).
 * - Pass `streaming: false` for the stateless apply-once surface:
 *   `install()` loads adapters, flushes discovery, and applies the
 *   server's levels — all with `await` — and no connection, timers, or
 *   background state are created; `refresh()` re-applies on demand — the
 *   right shape for short-lived isolates that cannot host a long-lived
 *   live-updates connection.
 * - The built-in framework adapters (`WinstonAdapter`, `PinoAdapter`) are
 *   package-root exports: they wrap Node logging frameworks, which edge
 *   isolates don't host. Register a custom {@link LoggingAdapter} for an
 *   edge-side logging framework, or use the CRUD surface, which needs no
 *   `install()` at all.
 */

export { LoggingClient, LoggersClient, LogGroupsClient } from "./client.js";
export type { LoggingClientOptions } from "./client.js";
export { Logger, LogGroup } from "./models.js";
export { LogLevel, LoggerEnvironment, LoggerChangeEvent, LoggerSource } from "./types.js";
export type { LoggingAdapter } from "./adapters/base.js";
// The full typed error surface, so edge callers can catch what the client throws.
export * from "../errors.js";
