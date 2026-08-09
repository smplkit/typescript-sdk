/**
 * Smpl Flags SDK namespace.
 *
 * One {@link FlagsClient} exposes the full surface — flag CRUD and
 * discovery plus the live evaluation surface (`booleanFlag` / `stringFlag`
 * / `numberFlag` / `jsonFlag` / `refresh` / `stats` / `onChange`) —
 * reachable as `client.flags` on {@link SmplClient} or constructed
 * directly.
 *
 * This module is also the package's `@smplkit/sdk/flags` subpath — the
 * edge/serverless entry. Its import graph is free of Node built-ins, so it
 * bundles for edge runtimes (e.g. Cloudflare Workers). Differences from the
 * package root there:
 *
 * - Configuration resolves from defaults → the `SMPLKIT_API_KEY` /
 *   `SMPLKIT_BASE_DOMAIN` / `SMPLKIT_SCHEME` / `SMPLKIT_ENVIRONMENT` /
 *   `SMPLKIT_SERVICE` environment variables → constructor options, exactly
 *   like the root — minus the `~/.smplkit` file step (that machinery needs
 *   `node:fs`, and an isolate has no home directory anyway).
 * - Pass `streaming: false` for the stateless read-through surface: the
 *   first live call fetches all flag definitions once with `await`,
 *   evaluation stays local, `refresh()` re-fetches on demand, and no
 *   connection, timers, or background state are created — the right shape
 *   for short-lived isolates that cannot host a long-lived live-updates
 *   connection.
 * - There is no ambient per-request context (`client.setContext` is a
 *   {@link SmplClient} affordance backed by `AsyncLocalStorage`); pass
 *   evaluation contexts explicitly per call or via `setContextProvider`.
 */

export { FlagsClient, FlagChangeEvent, FlagStats } from "./client.js";
export type { FlagsClientOptions } from "./client.js";
export {
  Flag,
  BooleanFlag,
  StringFlag,
  NumberFlag,
  JsonFlag,
  FlagValue,
  FlagRule,
  FlagEnvironment,
} from "./models.js";
export { Context, Op, Rule, FlagDeclaration } from "./types.js";
// The full typed error surface, so edge callers can catch what the client throws.
export * from "../errors.js";
