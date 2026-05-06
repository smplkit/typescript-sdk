/**
 * In-memory bounded buffer + interval-driven flush for fire-and-forget audit emits.
 *
 * Mirrors the python-sdk audit buffer (see ADR-047 §2.6) but uses
 * `setInterval` + Promises rather than a daemon thread. Items are stored in
 * a FIFO array; oldest items are evicted when the buffer overflows. Retry
 * uses exponential backoff with jitter. Permanent 4xx (other than 429)
 * are logged and dropped.
 */

const MAX_BUFFER_SIZE = 1000;
const PERIODIC_FLUSH_INTERVAL_MS = 5_000;
const HIGH_WATERMARK = 50;
const MAX_ATTEMPTS_PER_ITEM = 5;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8_000;

interface PendingItem {
  body: object;
  idempotencyKey: string | null;
  attempts: number;
  nextRetryAt: number; // ms since epoch
}

export interface PostOutcome {
  /** HTTP status code, or `0` for transport error (DNS, connection refused, abort). */
  status: number;
}

export type PostFn = (item: PendingItem) => Promise<PostOutcome>;

export class AuditEventBuffer {
  private readonly _queue: PendingItem[] = [];
  private readonly _post: PostFn;
  private readonly _maxSize: number;
  private readonly _watermark: number;
  private _flushTimer: ReturnType<typeof setInterval> | null;
  private _draining = false;
  private _closed = false;
  private _droppedCount = 0;

  constructor(opts: {
    post: PostFn;
    maxSize?: number;
    flushIntervalMs?: number;
    watermark?: number;
  }) {
    this._post = opts.post;
    this._maxSize = opts.maxSize ?? MAX_BUFFER_SIZE;
    this._watermark = opts.watermark ?? HIGH_WATERMARK;
    const interval = opts.flushIntervalMs ?? PERIODIC_FLUSH_INTERVAL_MS;
    this._flushTimer = setInterval(() => {
      void this._drainOnce();
    }, interval);
    // Don't keep the Node process alive on the timer alone.
    if (typeof (this._flushTimer as { unref?: () => void }).unref === "function") {
      (this._flushTimer as { unref?: () => void }).unref!();
    }
  }

  /** Enqueue a new event. May evict the oldest queued item if full. */
  enqueue(body: object, idempotencyKey: string | null = null): void {
    if (this._closed) return;
    if (this._queue.length >= this._maxSize) {
      this._queue.shift();
      this._droppedCount += 1;
      // eslint-disable-next-line no-console
      console.warn(
        `[smplkit.audit] buffer full (size=${this._maxSize}); dropped oldest event ` +
          `(total dropped=${this._droppedCount})`,
      );
    }
    this._queue.push({ body, idempotencyKey, attempts: 0, nextRetryAt: 0 });
    if (this._queue.length >= this._watermark) {
      void this._drainOnce();
    }
  }

  /** Block (cooperatively) until the buffer is empty or `timeoutMs` elapses. */
  async flush(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this._queue.length > 0) {
      if (Date.now() >= deadline) {
        // eslint-disable-next-line no-console
        console.warn(`[smplkit.audit] flush timed out after ${timeoutMs}ms`);
        return;
      }
      void this._drainOnce();
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Stop the periodic timer, drain best-effort, and mark closed. */
  async close(timeoutMs = 5_000): Promise<void> {
    this._closed = true;
    await this.flush(timeoutMs);
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  private async _drainOnce(): Promise<void> {
    if (this._draining) return;
    this._draining = true;
    try {
      const now = Date.now();
      while (this._queue.length > 0) {
        const head = this._queue[0];
        if (head.nextRetryAt > now) break;
        this._queue.shift();

        let outcome: PostOutcome;
        try {
          outcome = await this._post(head);
        } catch (err) {
          outcome = { status: 0 };
        }

        const requeued = this._handleOutcome(head, outcome);
        if (requeued !== null) {
          // Push back to the front so retry order is preserved.
          this._queue.unshift(requeued);
          // Stop draining for now — head is queued for the future.
          break;
        }
      }
    } finally {
      this._draining = false;
    }
  }

  private _handleOutcome(item: PendingItem, outcome: PostOutcome): PendingItem | null {
    // Success.
    if (outcome.status >= 200 && outcome.status < 300) return null;

    // Permanent 4xx other than 429.
    if (outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429) {
      // eslint-disable-next-line no-console
      console.warn(
        `[smplkit.audit] permanent failure status=${outcome.status}; event dropped`,
      );
      return null;
    }

    // Transient failure — exponential backoff with jitter.
    item.attempts += 1;
    if (item.attempts >= MAX_ATTEMPTS_PER_ITEM) {
      // eslint-disable-next-line no-console
      console.warn(
        `[smplkit.audit] gave up after ${item.attempts} attempts ` +
          `(last_status=${outcome.status})`,
      );
      return null;
    }
    const backoff = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (item.attempts - 1));
    const jitter = Math.random() * backoff * 0.25;
    item.nextRetryAt = Date.now() + backoff + jitter;
    return item;
  }
}
