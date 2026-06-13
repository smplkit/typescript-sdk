/**
 * Per-request evaluation context for context-sensitive lookups (flags today,
 * likely more later).
 *
 * Backed by an `AsyncLocalStorage` store so per-request isolation works across
 * concurrent async tasks — each request/task sees only the context set within
 * it, with no cross-contamination (the same guarantee Python gets from
 * `contextvars`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "./flags/types.js";

/**
 * Ensure the well-known `Symbol.dispose` exists on the given `Symbol`-like
 * object, defining it (only when missing) so {@link ContextScope} can key its
 * dispose method off the real symbol and `using` works on Node < 20, which
 * predates native `Symbol.dispose`.
 *
 * Returns the resolved symbol. Exported for direct testing of the
 * define-when-missing branch on runtimes that already provide it.
 * @internal
 */
export function ensureDisposeSymbol(sym: { dispose?: symbol }): symbol {
  if (typeof sym.dispose !== "symbol") {
    const created = Symbol("Symbol.dispose");
    Object.defineProperty(sym, "dispose", { value: created });
    return created;
  }
  return sym.dispose;
}

// Run the polyfill before defining ContextScope below so its `[Symbol.dispose]`
// method keys off the real symbol across the supported Node range (18+).
ensureDisposeSymbol(Symbol as unknown as { dispose?: symbol });

/** Backing store for the current task's evaluation context. @internal */
const requestContext = new AsyncLocalStorage<Context[]>();

/**
 * Return the current per-request evaluation context (an empty list when none
 * is active).
 * @internal
 */
export function getRequestContext(): Context[] {
  return requestContext.getStore() ?? [];
}

/**
 * A restorable handle to a context set with {@link SmplClient.setContext}.
 *
 * Optional to use — a bare `client.setContext([...])` is fire-and-forget (the
 * typical middleware pattern). Hold the returned scope to restore the previous
 * context once you're done with a one-off override (e.g. impersonation):
 *
 * - as a `using` declaration — the scope auto-restores when it leaves block
 *   scope (`using scope = client.setContext([...]);`), or
 * - by calling {@link ContextScope.restore} explicitly.
 */
export class ContextScope {
  /** @internal */
  private readonly _previous: Context[] | undefined;
  /** @internal */
  private _restored = false;

  /** @internal */
  constructor(previous: Context[] | undefined) {
    this._previous = previous;
  }

  /**
   * Restore the evaluation context that was active before this scope was
   * created. Idempotent — calling it again is a no-op.
   */
  restore(): void {
    if (this._restored) return;
    this._restored = true;
    requestContext.enterWith(this._previous ?? []);
  }

  /**
   * Dispose hook — restores the previous context. Enables
   * `using scope = client.setContext([...]);` for block-scoped overrides.
   */
  [Symbol.dispose](): void {
    this.restore();
  }
}

/**
 * Stash *contexts* as the current task's evaluation context and return a
 * {@link ContextScope} that can restore the prior context.
 * @internal
 */
export function setContext(contexts: Context[]): ContextScope {
  const previous = requestContext.getStore();
  requestContext.enterWith([...contexts]);
  return new ContextScope(previous);
}
