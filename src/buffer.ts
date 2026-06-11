/**
 * Context-registration buffer — shared by `client.platform.contexts` and the
 * flags runtime client.
 *
 * Evaluation-context observations (from `flag.get(...)` and from explicit
 * `client.platform.contexts.register(...)`) dedupe through a single LRU and
 * flush in bulk. The platform client owns the buffer; the flags client
 * borrows it so both planes share one dedup window.
 */

import type { Context } from "./flags/types.js";

/** Flush the pending buffer once it reaches this many distinct observations. */
export const CONTEXT_BATCH_FLUSH_SIZE = 100;

/** Cap on the dedup LRU so it doesn't grow unbounded for long-lived processes. */
export const CONTEXT_REGISTRATION_LRU_SIZE = 10_000;

/**
 * Buffer pending context observations for bulk registration.
 *
 * Backed by an LRU of size {@link CONTEXT_REGISTRATION_LRU_SIZE} so the
 * dedup window doesn't grow unbounded for long-lived processes.
 * @internal
 */
export class ContextRegistrationBuffer {
  private _seen = new Map<string, Record<string, unknown>>();
  private _pending: Array<{ type: string; key: string; attributes: Record<string, unknown> }> = [];

  observe(contexts: Context[]): void {
    for (const ctx of contexts) {
      const cacheKey = `${ctx.type}:${ctx.key}`;
      if (!this._seen.has(cacheKey)) {
        if (this._seen.size >= CONTEXT_REGISTRATION_LRU_SIZE) {
          const firstKey = this._seen.keys().next().value;
          /* v8 ignore next */
          if (firstKey !== undefined) this._seen.delete(firstKey);
        }
        this._seen.set(cacheKey, ctx.attributes);
        this._pending.push({
          type: ctx.type,
          key: ctx.key,
          attributes: { ...ctx.attributes },
        });
      }
    }
  }

  drain(): Array<{ type: string; key: string; attributes: Record<string, unknown> }> {
    const batch = this._pending;
    this._pending = [];
    return batch;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}
