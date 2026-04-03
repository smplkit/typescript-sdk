/**
 * FlagsClient — management + prescriptive runtime for Smpl Flags.
 *
 * Uses the generated OpenAPI types (`src/generated/flags.d.ts`) via
 * `openapi-fetch` for all HTTP calls. Context type management and
 * context registration use direct HTTP via the Transport class since
 * these endpoints are on the flags service but not in the generated spec.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/flags.d.ts";
import {
  SmplConflictError,
  SmplError,
  SmplNotFoundError,
  SmplTimeoutError,
  SmplValidationError,
} from "../errors.js";
import { Transport } from "../transport.js";
import { Flag, ContextType } from "./models.js";
import type { Context, FlagType } from "./types.js";
import type { SharedWebSocket } from "../ws.js";

// Use require-style import for json-logic-js (no TS types)
// eslint-disable-next-line @typescript-eslint/no-require-imports
import jsonLogic from "json-logic-js";

const FLAGS_BASE_URL = "https://flags.smplkit.com";
const APP_BASE_URL = "https://app.smplkit.com";
const CACHE_MAX_SIZE = 10_000;
const CONTEXT_REGISTRATION_LRU_SIZE = 10_000;
const CONTEXT_BATCH_FLUSH_SIZE = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FlagResource = components["schemas"]["FlagResource"];

/** Map HTTP errors to typed SDK exceptions. @internal */
async function checkError(response: Response, context: string): Promise<never> {
  const body = await response.text().catch(() => "");
  switch (response.status) {
    case 404:
      throw new SmplNotFoundError(body || context, 404, body);
    case 409:
      throw new SmplConflictError(body || context, 409, body);
    case 422:
      throw new SmplValidationError(body || context, 422, body);
    default:
      throw new SmplError(`HTTP ${response.status}: ${body}`, response.status, body);
  }
}

/** Re-raise fetch-level errors as typed SDK exceptions. @internal */
function wrapFetchError(err: unknown): never {
  if (
    err instanceof SmplNotFoundError ||
    err instanceof SmplConflictError ||
    err instanceof SmplValidationError ||
    err instanceof SmplError
  ) {
    throw err;
  }
  if (err instanceof TypeError) {
    throw new SmplConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

// Re-import for the above helper
import { SmplConnectionError } from "../errors.js";

/** Convert Context list to nested evaluation dict. @internal */
function contextsToEvalDict(contexts: Context[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const ctx of contexts) {
    result[ctx.type] = { key: ctx.key, ...ctx.attributes };
  }
  return result;
}

/** Recursively sort object keys for stable serialization. @internal */
function sortedStringify(obj: any): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(sortedStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k])).join(",") + "}";
}

/** Compute a stable hash for a context evaluation dict. @internal */
function hashContext(evalDict: Record<string, any>): string {
  const serialized = sortedStringify(evalDict);
  // Simple hash — no crypto needed, just cache keying
  let hash = 0;
  for (let i = 0; i < serialized.length; i++) {
    const chr = serialized.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash.toString(36);
}

/**
 * Evaluate a flag definition against the given context.
 *
 * Follows ADR-022 §2.6 semantics:
 * 1. Look up the environment. If missing, return flag-level default.
 * 2. If disabled, return env default or flag default.
 * 3. Iterate rules; first match wins.
 * 4. No match → env default or flag default.
 * @internal
 */
function evaluateFlag(
  flagDef: Record<string, any>,
  environment: string | null,
  evalDict: Record<string, any>,
): any {
  const flagDefault = flagDef.default;
  const environments = flagDef.environments ?? {};

  if (environment === null || !(environment in environments)) {
    return flagDefault;
  }

  const envConfig = environments[environment];
  const envDefault = envConfig.default;
  const fallback = envDefault !== undefined && envDefault !== null ? envDefault : flagDefault;

  if (!envConfig.enabled) {
    return fallback;
  }

  const rules = envConfig.rules ?? [];
  for (const rule of rules) {
    const logic = rule.logic;
    if (!logic || Object.keys(logic).length === 0) {
      continue;
    }
    try {
      const result = jsonLogic.apply(logic, evalDict);
      if (result) {
        return rule.value;
      }
    } catch {
      // Skip invalid rules
      continue;
    }
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Change event
// ---------------------------------------------------------------------------

/** Describes a flag definition change. */
export class FlagChangeEvent {
  readonly key: string;
  readonly source: string;

  constructor(key: string, source: string) {
    this.key = key;
    this.source = source;
  }
}

// ---------------------------------------------------------------------------
// Resolution cache + stats
// ---------------------------------------------------------------------------

/** @internal */
class ResolutionCache {
  private _maxSize: number;
  private _cache = new Map<string, any>();
  cacheHits = 0;
  cacheMisses = 0;

  constructor(maxSize: number = CACHE_MAX_SIZE) {
    this._maxSize = maxSize;
  }

  get(cacheKey: string): [boolean, any] {
    if (this._cache.has(cacheKey)) {
      // Move to end (delete + re-set)
      const value = this._cache.get(cacheKey);
      this._cache.delete(cacheKey);
      this._cache.set(cacheKey, value);
      this.cacheHits++;
      return [true, value];
    }
    this.cacheMisses++;
    return [false, null];
  }

  put(cacheKey: string, value: any): void {
    if (this._cache.has(cacheKey)) {
      this._cache.delete(cacheKey);
    }
    this._cache.set(cacheKey, value);
    if (this._cache.size > this._maxSize) {
      // Remove oldest (first) entry
      const firstKey = this._cache.keys().next().value;
      if (firstKey !== undefined) {
        this._cache.delete(firstKey);
      }
    }
  }

  clear(): void {
    this._cache.clear();
  }
}

/** Cache statistics for the flags runtime. */
export class FlagStats {
  readonly cacheHits: number;
  readonly cacheMisses: number;

  constructor(cacheHits: number, cacheMisses: number) {
    this.cacheHits = cacheHits;
    this.cacheMisses = cacheMisses;
  }
}

// ---------------------------------------------------------------------------
// Typed flag handles
// ---------------------------------------------------------------------------

/** @internal */
class FlagHandleBase {
  /** @internal */ readonly _namespace: FlagsClient;
  /** @internal */ readonly _key: string;
  /** @internal */ readonly _default: any;
  /** @internal */ _listeners: Array<(event: FlagChangeEvent) => void> = [];

  constructor(namespace: FlagsClient, key: string, defaultValue: any) {
    this._namespace = namespace;
    this._key = key;
    this._default = defaultValue;
  }

  get key(): string {
    return this._key;
  }

  get default(): any {
    return this._default;
  }

  /* v8 ignore next 3 — overridden by all exported subclasses */
  get(options?: { context?: Context[] }): any {
    return this._namespace._evaluateHandle(this._key, this._default, options?.context ?? null);
  }

  /** Register a flag-specific change listener. Works as a decorator. */
  onChange(callback: (event: FlagChangeEvent) => void): (event: FlagChangeEvent) => void {
    this._listeners.push(callback);
    return callback;
  }
}

/** Typed handle for a boolean flag. */
export class BoolFlagHandle extends FlagHandleBase {
  get(options?: { context?: Context[] }): boolean {
    const value = this._namespace._evaluateHandle(
      this._key,
      this._default,
      options?.context ?? null,
    );
    if (typeof value === "boolean") {
      return value;
    }
    return this._default;
  }
}

/** Typed handle for a string flag. */
export class StringFlagHandle extends FlagHandleBase {
  get(options?: { context?: Context[] }): string {
    const value = this._namespace._evaluateHandle(
      this._key,
      this._default,
      options?.context ?? null,
    );
    if (typeof value === "string") {
      return value;
    }
    return this._default;
  }
}

/** Typed handle for a numeric flag. */
export class NumberFlagHandle extends FlagHandleBase {
  get(options?: { context?: Context[] }): number {
    const value = this._namespace._evaluateHandle(
      this._key,
      this._default,
      options?.context ?? null,
    );
    if (typeof value === "number") {
      return value;
    }
    return this._default;
  }
}

/** Typed handle for a JSON flag. */
export class JsonFlagHandle extends FlagHandleBase {
  get(options?: { context?: Context[] }): Record<string, any> {
    const value = this._namespace._evaluateHandle(
      this._key,
      this._default,
      options?.context ?? null,
    );
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, any>;
    }
    return this._default;
  }
}

// ---------------------------------------------------------------------------
// Context registration buffer
// ---------------------------------------------------------------------------

/** @internal */
class ContextRegistrationBuffer {
  private _seen = new Map<string, Record<string, any>>();
  private _pending: Array<Record<string, any>> = [];

  observe(contexts: Context[]): void {
    for (const ctx of contexts) {
      const cacheKey = `${ctx.type}:${ctx.key}`;
      if (!this._seen.has(cacheKey)) {
        if (this._seen.size >= CONTEXT_REGISTRATION_LRU_SIZE) {
          // Remove oldest entry
          const firstKey = this._seen.keys().next().value;
          if (firstKey !== undefined) {
            this._seen.delete(firstKey);
          }
        }
        this._seen.set(cacheKey, ctx.attributes);
        this._pending.push({
          id: `${ctx.type}:${ctx.key}`,
          name: ctx.name ?? ctx.key,
          attributes: { ...ctx.attributes },
        });
      }
    }
  }

  drain(): Array<Record<string, any>> {
    const batch = this._pending;
    this._pending = [];
    return batch;
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

// ---------------------------------------------------------------------------
// FlagsClient
// ---------------------------------------------------------------------------

/**
 * Client for the smplkit Flags API — management plane + prescriptive runtime.
 *
 * Obtained via `SmplClient.flags`.
 */
export class FlagsClient {
  /** @internal */
  readonly _apiKey: string;
  /** @internal */
  readonly _baseUrl: string = FLAGS_BASE_URL;

  /** @internal */
  private readonly _http: ReturnType<typeof createClient<import("../generated/flags.d.ts").paths>>;
  /** @internal */
  private readonly _transport: Transport;

  // Runtime state
  private _environment: string | null = null;
  private _flagStore: Record<string, Record<string, any>> = {};
  private _connected = false;
  private _cache = new ResolutionCache();
  private _contextProvider: (() => Context[]) | null = null;
  private _contextBuffer = new ContextRegistrationBuffer();
  private _handles: Record<string, FlagHandleBase> = {};
  private _globalListeners: Array<(event: FlagChangeEvent) => void> = [];

  // Shared WebSocket (set during connect)
  private _wsManager: SharedWebSocket | null = null;
  private readonly _ensureWs: () => SharedWebSocket;

  /** @internal */
  constructor(apiKey: string, ensureWs: () => SharedWebSocket, timeout?: number) {
    this._apiKey = apiKey;
    this._ensureWs = ensureWs;
    const ms = timeout ?? 30_000;

    this._http = createClient<import("../generated/flags.d.ts").paths>({
      baseUrl: FLAGS_BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      fetch: async (request: Request): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
          return await fetch(new Request(request, { signal: controller.signal }));
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw new SmplTimeoutError(`Request timed out after ${ms}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    });

    this._transport = new Transport({ apiKey, timeout: ms });
  }

  // ------------------------------------------------------------------
  // Management methods
  // ------------------------------------------------------------------

  /** Create a flag. */
  async create(
    key: string,
    options: {
      name: string;
      type: FlagType;
      default: unknown;
      description?: string;
      values?: Array<{ name: string; value: unknown }>;
    },
  ): Promise<Flag> {
    let values = options.values;
    if (values === undefined && options.type === "BOOLEAN") {
      values = [
        { name: "True", value: true },
        { name: "False", value: false },
      ];
    }

    const body = {
      data: {
        type: "flag" as const,
        attributes: {
          key,
          name: options.name,
          type: options.type,
          default: options.default,
          values: values ?? [],
          ...(options.description !== undefined ? { description: options.description } : {}),
        },
      },
    };

    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/flags", { body });
      if (result.error !== undefined) await checkError(result.response, "Failed to create flag");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError("Failed to create flag");
    return this._resourceToModel(data.data);
  }

  /** Fetch a flag by UUID. */
  async get(flagId: string): Promise<Flag> {
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags/{id}", {
        params: { path: { id: flagId } },
      });
      if (result.error !== undefined) await checkError(result.response, `Flag ${flagId} not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplNotFoundError(`Flag ${flagId} not found`);
    return this._resourceToModel(data.data);
  }

  /** List all flags. */
  async list(): Promise<Flag[]> {
    let data: components["schemas"]["FlagListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags", {});
      if (result.error !== undefined) await checkError(result.response, "Failed to list flags");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => this._resourceToModel(r));
  }

  /** Delete a flag by UUID. */
  async delete(flagId: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/flags/{id}", {
        params: { path: { id: flagId } },
      });
      if (result.error !== undefined && result.response.status !== 204)
        await checkError(result.response, `Failed to delete flag ${flagId}`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * Internal: PUT a full flag update.
   * Called by {@link Flag} instance methods.
   * @internal
   */
  async _updateFlag(options: {
    flag: Flag;
    environments?: Record<string, any>;
    values?: Array<{ name: string; value: unknown }>;
    default?: unknown;
    description?: string;
    name?: string;
  }): Promise<Flag> {
    const { flag } = options;
    const body = {
      data: {
        type: "flag" as const,
        attributes: {
          key: flag.key,
          name: options.name !== undefined ? options.name : flag.name,
          type: flag.type,
          default: options.default !== undefined ? options.default : flag.default,
          values: options.values !== undefined ? options.values : flag.values,
          ...(options.description !== undefined
            ? { description: options.description }
            : flag.description !== null
              ? { description: flag.description }
              : {}),
          ...(options.environments !== undefined
            ? { environments: options.environments }
            : flag.environments && Object.keys(flag.environments).length > 0
              ? { environments: flag.environments }
              : {}),
        },
      },
    };

    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/flags/{id}", {
        params: { path: { id: flag.id } },
        body,
      });
      if (result.error !== undefined)
        await checkError(result.response, `Failed to update flag ${flag.id}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError(`Failed to update flag ${flag.id}`);
    return this._resourceToModel(data.data);
  }

  // ------------------------------------------------------------------
  // Context type management (direct HTTP — not in generated spec)
  // ------------------------------------------------------------------

  /** Create a context type. */
  async createContextType(key: string, options: { name: string }): Promise<ContextType> {
    const resp = await this._transport.post(`${APP_BASE_URL}/api/v1/context_types`, {
      data: { type: "context_type", attributes: { key, name: options.name } },
    });
    const data = resp.data ?? {};
    return this._parseContextType(data);
  }

  /** Update a context type (merge attributes). */
  async updateContextType(
    ctId: string,
    options: { attributes: Record<string, any> },
  ): Promise<ContextType> {
    const resp = await this._transport.put(`${APP_BASE_URL}/api/v1/context_types/${ctId}`, {
      data: { type: "context_type", attributes: { attributes: options.attributes } },
    });
    const data = resp.data ?? {};
    return this._parseContextType(data);
  }

  /** List all context types. */
  async listContextTypes(): Promise<ContextType[]> {
    const resp = await this._transport.get(`${APP_BASE_URL}/api/v1/context_types`);
    const items = resp.data ?? [];
    return (items as any[]).map((item: any) => this._parseContextType(item));
  }

  /** Delete a context type. */
  async deleteContextType(ctId: string): Promise<void> {
    await this._transport.delete(`${APP_BASE_URL}/api/v1/context_types/${ctId}`);
  }

  /** List context instances filtered by context type key. */
  async listContexts(options: { contextTypeKey: string }): Promise<any[]> {
    const resp = await this._transport.get(`${APP_BASE_URL}/api/v1/contexts`, {
      "filter[context_type]": options.contextTypeKey,
    });
    return resp.data ?? [];
  }

  // ------------------------------------------------------------------
  // Runtime: typed flag handles
  // ------------------------------------------------------------------

  /** Declare a boolean flag handle. */
  boolFlag(key: string, defaultValue: boolean): BoolFlagHandle {
    const handle = new BoolFlagHandle(this, key, defaultValue);
    this._handles[key] = handle;
    return handle;
  }

  /** Declare a string flag handle. */
  stringFlag(key: string, defaultValue: string): StringFlagHandle {
    const handle = new StringFlagHandle(this, key, defaultValue);
    this._handles[key] = handle;
    return handle;
  }

  /** Declare a numeric flag handle. */
  numberFlag(key: string, defaultValue: number): NumberFlagHandle {
    const handle = new NumberFlagHandle(this, key, defaultValue);
    this._handles[key] = handle;
    return handle;
  }

  /** Declare a JSON flag handle. */
  jsonFlag(key: string, defaultValue: Record<string, any>): JsonFlagHandle {
    const handle = new JsonFlagHandle(this, key, defaultValue);
    this._handles[key] = handle;
    return handle;
  }

  // ------------------------------------------------------------------
  // Runtime: context provider
  // ------------------------------------------------------------------

  /**
   * Register a context provider function.
   *
   * Called on every `handle.get()` to supply the current evaluation
   * context. Can also be used as a decorator:
   *
   * ```typescript
   * client.flags.setContextProvider(() => [
   *   new Context("user", userId, { plan: userPlan }),
   * ]);
   * ```
   */
  setContextProvider(fn: () => Context[]): void {
    this._contextProvider = fn;
  }

  /**
   * Register a context provider — decorator-style alias.
   *
   * ```typescript
   * const provider = client.flags.contextProvider(() => [...]);
   * ```
   */
  contextProvider(fn: () => Context[]): () => Context[] {
    this._contextProvider = fn;
    return fn;
  }

  // ------------------------------------------------------------------
  // Runtime: connect / disconnect / refresh
  // ------------------------------------------------------------------

  /**
   * Connect to an environment: fetch flag definitions, register on
   * shared WebSocket, enable local evaluation.
   */
  async connect(environment: string, _options?: { timeout?: number }): Promise<void> {
    this._environment = environment;
    await this._fetchAllFlags();
    this._connected = true;
    this._cache.clear();

    // Register on the shared WebSocket
    this._wsManager = this._ensureWs();
    this._wsManager.on("flag_changed", this._handleFlagChanged);
    this._wsManager.on("flag_deleted", this._handleFlagDeleted);
  }

  /** Disconnect: unregister from WebSocket, flush contexts, clear state. */
  async disconnect(): Promise<void> {
    if (this._wsManager !== null) {
      this._wsManager.off("flag_changed", this._handleFlagChanged);
      this._wsManager.off("flag_deleted", this._handleFlagDeleted);
      this._wsManager = null;
    }

    await this._flushContexts();
    this._flagStore = {};
    this._cache.clear();
    this._connected = false;
    this._environment = null;
  }

  /** Re-fetch all flag definitions and clear cache. */
  async refresh(): Promise<void> {
    await this._fetchAllFlags();
    this._cache.clear();
    this._fireChangeListenersAll("manual");
  }

  /** Return the current WebSocket connection status. */
  connectionStatus(): string {
    if (this._wsManager !== null) {
      return this._wsManager.connectionStatus;
    }
    return "disconnected";
  }

  /** Return cache statistics. */
  stats(): FlagStats {
    return new FlagStats(this._cache.cacheHits, this._cache.cacheMisses);
  }

  // ------------------------------------------------------------------
  // Runtime: change listeners
  // ------------------------------------------------------------------

  /** Register a global change listener that fires for any flag change. */
  onChangeAny(callback: (event: FlagChangeEvent) => void): (event: FlagChangeEvent) => void {
    this._globalListeners.push(callback);
    return callback;
  }

  /**
   * Register a global change listener — decorator-style alias.
   *
   * ```typescript
   * const listener = client.flags.onChange((event) => { ... });
   * ```
   */
  onChange(callback: (event: FlagChangeEvent) => void): (event: FlagChangeEvent) => void {
    return this.onChangeAny(callback);
  }

  // ------------------------------------------------------------------
  // Runtime: context registration
  // ------------------------------------------------------------------

  /**
   * Explicitly register context(s) for background batch registration.
   *
   * Accepts a single Context or an array. Fire-and-forget — never
   * blocks. Works before `connect()` is called.
   */
  register(context: Context | Context[]): void {
    if (Array.isArray(context)) {
      this._contextBuffer.observe(context);
    } else {
      this._contextBuffer.observe([context]);
    }
  }

  /** Flush pending context registrations to the server. */
  async flushContexts(): Promise<void> {
    await this._flushContexts();
  }

  // ------------------------------------------------------------------
  // Runtime: Tier 1 evaluate
  // ------------------------------------------------------------------

  /**
   * Tier 1 explicit evaluation — stateless, no provider or cache.
   *
   * Useful for scripts, one-off jobs, and infrastructure code.
   */
  async evaluate(key: string, options: { environment: string; context: Context[] }): Promise<any> {
    const evalDict = contextsToEvalDict(options.context);

    // Use local store if connected, otherwise fetch
    let flagDef: Record<string, any> | null = null;
    if (this._connected && key in this._flagStore) {
      flagDef = this._flagStore[key];
    } else {
      const flags = await this._fetchFlagsList();
      for (const f of flags) {
        if (f.key === key) {
          flagDef = f;
          break;
        }
      }
    }

    if (flagDef === null) {
      return null;
    }

    return evaluateFlag(flagDef, options.environment, evalDict);
  }

  // ------------------------------------------------------------------
  // Internal: evaluation
  // ------------------------------------------------------------------

  /** @internal */
  _evaluateHandle(key: string, defaultValue: any, context: Context[] | null): any {
    if (!this._connected) {
      return defaultValue;
    }

    let evalDict: Record<string, any>;
    if (context !== null) {
      evalDict = contextsToEvalDict(context);
    } else if (this._contextProvider !== null) {
      const contexts = this._contextProvider();
      evalDict = contextsToEvalDict(contexts);
      this._contextBuffer.observe(contexts);
      if (this._contextBuffer.pendingCount >= CONTEXT_BATCH_FLUSH_SIZE) {
        // Fire-and-forget background flush
        void this._flushContexts();
      }
    } else {
      evalDict = {};
    }

    const ctxHash = hashContext(evalDict);
    const cacheKey = `${key}:${ctxHash}`;

    const [hit, cachedValue] = this._cache.get(cacheKey);
    if (hit) {
      return cachedValue;
    }

    const flagDef = this._flagStore[key];
    if (flagDef === undefined) {
      this._cache.put(cacheKey, defaultValue);
      return defaultValue;
    }

    let value = evaluateFlag(flagDef, this._environment, evalDict);
    if (value === null || value === undefined) {
      value = defaultValue;
    }

    this._cache.put(cacheKey, value);
    return value;
  }

  // ------------------------------------------------------------------
  // Internal: event handlers (called by SharedWebSocket)
  // ------------------------------------------------------------------

  private _handleFlagChanged = (data: Record<string, any>): void => {
    const flagKey = data.key as string | undefined;
    // Re-fetch all flags (async, fire-and-forget)
    void this._fetchAllFlags().then(() => {
      this._cache.clear();
      this._fireChangeListeners(flagKey ?? null, "websocket");
    });
  };

  private _handleFlagDeleted = (data: Record<string, any>): void => {
    const flagKey = data.key as string | undefined;
    void this._fetchAllFlags().then(() => {
      this._cache.clear();
      this._fireChangeListeners(flagKey ?? null, "websocket");
    });
  };

  // ------------------------------------------------------------------
  // Internal: flag store
  // ------------------------------------------------------------------

  private async _fetchAllFlags(): Promise<void> {
    const flags = await this._fetchFlagsList();
    const store: Record<string, Record<string, any>> = {};
    for (const f of flags) {
      store[f.key] = f;
    }
    this._flagStore = store;
  }

  private async _fetchFlagsList(): Promise<Array<Record<string, any>>> {
    let data: components["schemas"]["FlagListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags", {});
      if (result.error !== undefined) await checkError(result.response, "Failed to list flags");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => this._resourceToPlainDict(r));
  }

  // ------------------------------------------------------------------
  // Internal: change listeners
  // ------------------------------------------------------------------

  private _fireChangeListeners(flagKey: string | null, source: string): void {
    if (flagKey) {
      const event = new FlagChangeEvent(flagKey, source);
      for (const cb of this._globalListeners) {
        try {
          cb(event);
        } catch {
          // ignore listener errors
        }
      }
      const handle = this._handles[flagKey];
      if (handle) {
        for (const cb of handle._listeners) {
          try {
            cb(event);
          } catch {
            // ignore listener errors
          }
        }
      }
    }
  }

  private _fireChangeListenersAll(source: string): void {
    for (const flagKey of Object.keys(this._flagStore)) {
      this._fireChangeListeners(flagKey, source);
    }
  }

  // ------------------------------------------------------------------
  // Internal: context flush
  // ------------------------------------------------------------------

  private async _flushContexts(): Promise<void> {
    const batch = this._contextBuffer.drain();
    if (batch.length === 0) return;
    try {
      await this._transport.put(`${APP_BASE_URL}/api/v1/contexts/bulk`, {
        contexts: batch,
      });
    } catch {
      // Fire-and-forget: ignore registration failures
    }
  }

  // ------------------------------------------------------------------
  // Internal: model conversion
  // ------------------------------------------------------------------

  private _resourceToModel(resource: FlagResource): Flag {
    const attrs = resource.attributes;
    return new Flag(this, {
      id: resource.id ?? "",
      key: attrs.key,
      name: attrs.name,
      type: attrs.type,
      default: attrs.default,
      values: (attrs.values ?? []).map((v) => ({ name: v.name, value: v.value })),
      description: attrs.description ?? null,
      environments: attrs.environments ?? {},
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }

  private _resourceToPlainDict(resource: FlagResource): Record<string, any> {
    const attrs = resource.attributes;
    return {
      key: attrs.key,
      name: attrs.name,
      type: attrs.type,
      default: attrs.default,
      values: (attrs.values ?? []).map((v) => ({ name: v.name, value: v.value })),
      description: attrs.description ?? null,
      environments: attrs.environments ?? {},
    };
  }

  private _parseContextType(data: any): ContextType {
    const attrs = data.attributes ?? {};
    return new ContextType({
      id: data.id ?? "",
      key: attrs.key ?? "",
      name: attrs.name ?? "",
      attributes: attrs.attributes ?? {},
    });
  }
}
