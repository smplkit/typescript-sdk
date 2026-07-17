/**
 * Smpl Config SDK namespace.
 *
 * One {@link ConfigClient} exposes the full surface — config CRUD and
 * discovery plus the live runtime surface (`subscribe` / `getValue` /
 * `bind` / `onChange` / `refresh`) — reachable as `client.config` on
 * {@link SmplClient} or constructed directly.
 *
 * This module is also the package's `@smplkit/sdk/config` subpath — the
 * edge/serverless entry. Its import graph is free of Node built-ins and of
 * the `ws` transport, so it bundles for edge runtimes (e.g. Cloudflare
 * Workers). Differences from the package root there:
 *
 * - Configuration resolves from defaults → the `SMPLKIT_API_KEY` /
 *   `SMPLKIT_BASE_DOMAIN` / `SMPLKIT_SCHEME` / `SMPLKIT_ENVIRONMENT` /
 *   `SMPLKIT_SERVICE` environment variables → constructor options, exactly
 *   like the root — minus the `~/.smplkit` file step (that machinery needs
 *   `node:fs`, and an isolate has no home directory anyway).
 * - Pass `streaming: false` for the stateless read-through surface: the
 *   first live call fetches and resolves every config once with `await`,
 *   reads stay local, `refresh()` re-fetches on demand, and no socket,
 *   timers, or background state are created. With `streaming` left on, a
 *   live call throws — WebSocket-driven updates need the package root.
 */

export { ConfigClient } from "./client.js";
export type { ConfigChangeEvent, ConfigClientOptions } from "./client.js";
export { Config, ConfigItem, ConfigEnvironment, ItemType } from "./types.js";
export { LiveConfigProxy } from "./proxy.js";
// The full typed error surface, so edge callers can catch what the client throws.
export * from "../errors.js";
