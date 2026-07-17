/**
 * Ambient request-context seam — pure module.
 *
 * The real per-request evaluation context store lives in `./context.js`,
 * which is backed by `AsyncLocalStorage` (`node:async_hooks`). The flags
 * module must stay importable from edge runtimes via the
 * `@smplkit/sdk/flags` subpath entry, so the reader is injected by the
 * package ROOT entry (`src/index.ts`) rather than imported statically. Via
 * the edge entry the reader stays at its default (`null` — no ambient
 * context), and evaluation contexts are supplied explicitly per call or via
 * `setContextProvider` instead.
 */

import type { Context } from "./flags/types.js";

type AmbientContextReader = () => Context[];

let _reader: AmbientContextReader = () => [];

/** @internal Wired by the package-root entry; the edge entries leave the default. */
export function _setAmbientContextReader(reader: AmbientContextReader): void {
  _reader = reader;
}

/** @internal Contexts stashed for the current task; empty when none/unsupported. */
export function getAmbientContext(): Context[] {
  return _reader();
}
