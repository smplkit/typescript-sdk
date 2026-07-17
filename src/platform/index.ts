/**
 * Smpl Platform SDK namespace.
 *
 * Cross-cutting, account-global CRUD: environments, services, evaluation
 * contexts, and context types. One {@link PlatformClient} exposes the full
 * surface, reachable as `client.platform` on {@link SmplClient} or
 * constructed directly.
 *
 * This module is also the package's `@smplkit/sdk/platform` subpath — the
 * edge/serverless entry. Its import graph is free of Node built-ins and of
 * the `ws` transport, so it bundles for edge runtimes (e.g. Cloudflare
 * Workers). Platform is pure awaited CRUD — no sockets or timers — so no
 * stateless switch is needed; the only difference from the package root is
 * configuration: defaults → the `SMPLKIT_API_KEY` / `SMPLKIT_BASE_DOMAIN`
 * / `SMPLKIT_SCHEME` environment variables → constructor options — minus
 * the `~/.smplkit` file step (that machinery needs `node:fs`, and an
 * isolate has no home directory anyway).
 */

export {
  PlatformClient,
  EnvironmentsClient,
  ServicesClient,
  ContextsClient,
  ContextTypesClient,
} from "./client.js";
export type { PlatformClientOptions } from "./client.js";
export { Environment, Service, ContextType } from "./models.js";
export { Color, EnvironmentClassification } from "./types.js";
// The full typed error surface, so edge callers can catch what the client throws.
export * from "../errors.js";
