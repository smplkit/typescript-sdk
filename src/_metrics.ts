/**
 * Internal SDK telemetry engine.
 *
 * Accumulates usage metrics in memory and periodically flushes them to the
 * app service via `POST /api/v1/metrics/bulk`.  This module is entirely
 * private — nothing here is exported or documented for customers.
 *
 * @internal
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const APP_BASE_URL = "https://app.smplkit.com";

interface Counter {
  value: number;
  unit: string | null;
  windowStart: string; // ISO 8601 UTC
}

function makeCounter(unit: string | null): Counter {
  return { value: 0, unit, windowStart: new Date().toISOString() };
}

/**
 * Build a deterministic map key from metric name + sorted dimensions.
 * @internal
 */
function makeMapKey(name: string, dimensions: Record<string, string>): string {
  const sorted = Object.keys(dimensions)
    .sort()
    .map((k) => `${k}=${dimensions[k]}`)
    .join("&");
  return `${name}|${sorted}`;
}

/** @internal */
export class MetricsReporter {
  private readonly _apiKey: string;
  private readonly _environment: string;
  private readonly _service: string;
  private readonly _flushInterval: number;

  private _counters: Map<
    string,
    { name: string; dimensions: Record<string, string>; counter: Counter }
  > = new Map();
  private _gauges: Map<
    string,
    { name: string; dimensions: Record<string, string>; counter: Counter }
  > = new Map();
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _closed = false;

  constructor(options: {
    apiKey: string;
    environment: string;
    service: string;
    flushInterval?: number;
  }) {
    this._apiKey = options.apiKey;
    this._environment = options.environment;
    this._service = options.service;
    this._flushInterval = options.flushInterval ?? 60;
  }

  // ------------------------------------------------------------------
  // Public recording API
  // ------------------------------------------------------------------

  record(
    name: string,
    value: number = 1,
    unit: string | null = null,
    dimensions?: Record<string, string>,
  ): void {
    const merged = this._mergeDimensions(dimensions);
    const key = makeMapKey(name, merged);

    let entry = this._counters.get(key);
    if (!entry) {
      entry = { name, dimensions: merged, counter: makeCounter(unit) };
      this._counters.set(key, entry);
    }
    entry.counter.value += value;
    if (entry.counter.unit === null && unit !== null) {
      entry.counter.unit = unit;
    }
    this._maybeStartTimer();
  }

  recordGauge(
    name: string,
    value: number,
    unit: string | null = null,
    dimensions?: Record<string, string>,
  ): void {
    const merged = this._mergeDimensions(dimensions);
    const key = makeMapKey(name, merged);

    let entry = this._gauges.get(key);
    if (!entry) {
      entry = { name, dimensions: merged, counter: makeCounter(unit) };
      this._gauges.set(key, entry);
    }
    entry.counter.value = value;
    if (entry.counter.unit === null && unit !== null) {
      entry.counter.unit = unit;
    }
    this._maybeStartTimer();
  }

  // ------------------------------------------------------------------
  // Flush / close
  // ------------------------------------------------------------------

  flush(): void {
    this._flush();
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._flush();
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private _mergeDimensions(dimensions?: Record<string, string>): Record<string, string> {
    const merged: Record<string, string> = {
      environment: this._environment,
      service: this._service,
    };
    if (dimensions) {
      Object.assign(merged, dimensions);
    }
    return merged;
  }

  private _maybeStartTimer(): void {
    if (this._timer === null && !this._closed) {
      this._timer = setInterval(() => this._flush(), this._flushInterval * 1000);
      // Unref so the timer doesn't keep the process alive
      if (typeof this._timer === "object" && "unref" in this._timer) {
        (this._timer as NodeJS.Timeout).unref();
      }
    }
  }

  private _flush(): void {
    // Snapshot and clear
    const counters = this._counters;
    const gauges = this._gauges;
    this._counters = new Map();
    this._gauges = new Map();

    if (counters.size === 0 && gauges.size === 0) return;

    const payload = this._buildPayload(counters, gauges);

    // Fire-and-forget POST
    try {
      fetch(`${APP_BASE_URL}/api/v1/metrics/bulk`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          "Content-Type": "application/vnd.api+json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      }).catch(() => {
        // silently discard
      });
    } catch {
      // silently discard
    }
  }

  private _buildPayload(
    counters: Map<string, { name: string; dimensions: Record<string, string>; counter: Counter }>,
    gauges: Map<string, { name: string; dimensions: Record<string, string>; counter: Counter }>,
  ): { data: any[] } {
    const data: any[] = [];
    for (const [, entry] of counters) {
      data.push(this._entry(entry.name, entry.counter, entry.dimensions));
    }
    for (const [, entry] of gauges) {
      data.push(this._entry(entry.name, entry.counter, entry.dimensions));
    }
    return { data };
  }

  private _entry(
    name: string,
    counter: Counter,
    dimensions: Record<string, string>,
  ): Record<string, any> {
    return {
      type: "metric",
      attributes: {
        name,
        value: counter.value,
        unit: counter.unit,
        period_seconds: this._flushInterval,
        dimensions,
        recorded_at: counter.windowStart,
      },
    };
  }
}
