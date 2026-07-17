/**
 * Smpl Account SDK namespace.
 *
 * The authenticated account's own configuration — `account.settings`
 * get/save. One {@link AccountClient} exposes the surface, reachable as
 * `client.account` on {@link SmplClient} or constructed directly.
 *
 * This module is also the package's `@smplkit/sdk/account` subpath — the
 * edge/serverless entry. Its import graph is free of Node built-ins and of
 * the `ws` transport, so it bundles for edge runtimes (e.g. Cloudflare
 * Workers). Account is pure awaited CRUD — no sockets or timers — so no
 * stateless switch is needed; the only difference from the package root is
 * configuration: defaults → the `SMPLKIT_API_KEY` / `SMPLKIT_BASE_DOMAIN`
 * / `SMPLKIT_SCHEME` environment variables → constructor options — minus
 * the `~/.smplkit` file step (that machinery needs `node:fs`, and an
 * isolate has no home directory anyway).
 */

export { AccountClient, SettingsClient } from "./client.js";
export type { AccountClientOptions } from "./client.js";
export { AccountSettings } from "./models.js";
// The full typed error surface, so edge callers can catch what the client throws.
export * from "../errors.js";
