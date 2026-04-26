/**
 * FlagsClient — management and runtime for Smpl Flags.
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
  throwForStatus,
} from "../errors.js";

import { Flag, BooleanFlag, StringFlag, NumberFlag, JsonFlag } from "./models.js";
import type { Context } from "./types.js";
import type { SharedWebSocket } from "../ws.js";
import type { MetricsReporter } from "../_metrics.js";
import { keyToDisplayName } from "../helpers.js";
import { debug } from "../_debug.js";

// Use require-style import for json-logic-js (no TS types)
// eslint-disable-next-line @typescript-eslint/no-require-imports
import jsonLogic from "json-logic-js";

const FLAGS_BASE_URL = "https://flags.smplkit.com";
const APP_BASE_URL = "https://app.smplkit.com";
const CACHE_MAX_SIZE = 10_000;
const CONTEXT_REGISTRATION_LRU_SIZE = 10_000;
const CONTEXT_BATCH_FLUSH_SIZE = 100;
const FLAG_REGISTRATION_FLUSH_SIZE = 50;
const FLAG_REGISTRATION_FLUSH_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FlagResource = components["schemas"]["FlagResource"];

/** Map HTTP errors to typed SDK exceptions. @internal */
async function checkError(response: Response, _context: string): Promise<never> {
  const body = await response.text().catch(() => "");
  throwForStatus(response.status, body);
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
  readonly id: string;
  readonly source: string;
  /** True when the flag was deleted. */
  readonly deleted?: true;

  constructor(id: string, source: string, deleted?: true) {
    this.id = id;
    this.source = source;
    if (deleted) this.deleted = deleted;
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

/** Evaluation statistics for the flags runtime. */
export class FlagStats {
  readonly cacheHits: number;
  readonly cacheMisses: number;

  constructor(cacheHits: number, cacheMisses: number) {
    this.cacheHits = cacheHits;
    this.cacheMisses = cacheMisses;
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
          type: ctx.type,
          key: ctx.key,
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
// Flag registration buffer
// ---------------------------------------------------------------------------

/** @internal */
class FlagRegistrationBuffer {
  private _seen = new Set<string>();
  private _pending: Array<components["schemas"]["FlagBulkItem"]> = [];

  add(
    id: string,
    type: string,
    defaultValue: unknown,
    service: string | null,
    environment: string | null,
  ): void {
    if (!this._seen.has(id)) {
      this._seen.add(id);
      this._pending.push({
        id,
        type,
        default: defaultValue,
        service: service ?? undefined,
        environment: environment ?? undefined,
      });
    }
  }

  drain(): Array<components["schemas"]["FlagBulkItem"]> {
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
 * Management API for smplkit Flags — CRUD operations on Flag models.
 *
 * Access via `SmplClient.flags.management`.
 */
export class FlagsManagement {
  constructor(private readonly _client: FlagsClient) {}

  /** Create an unsaved boolean flag. Call `.save()` to persist. */
  newBooleanFlag(
    id: string,
    options: { default: boolean; name?: string; description?: string },
  ): BooleanFlag {
    return this._client._mgNewBooleanFlag(id, options);
  }

  /** Create an unsaved string flag. Call `.save()` to persist. */
  newStringFlag(
    id: string,
    options: {
      default: string;
      name?: string;
      description?: string;
      values?: Array<{ name: string; value: unknown }>;
    },
  ): StringFlag {
    return this._client._mgNewStringFlag(id, options);
  }

  /** Create an unsaved number flag. Call `.save()` to persist. */
  newNumberFlag(
    id: string,
    options: {
      default: number;
      name?: string;
      description?: string;
      values?: Array<{ name: string; value: unknown }>;
    },
  ): NumberFlag {
    return this._client._mgNewNumberFlag(id, options);
  }

  /** Create an unsaved JSON flag. Call `.save()` to persist. */
  newJsonFlag(
    id: string,
    options: {
      default: Record<string, any>;
      name?: string;
      description?: string;
      values?: Array<{ name: string; value: unknown }>;
    },
  ): JsonFlag {
    return this._client._mgNewJsonFlag(id, options);
  }

  /** Fetch a flag by id. */
  async get(id: string): Promise<Flag> {
    return this._client._mgGet(id);
  }

  /** List all flags. */
  async list(): Promise<Flag[]> {
    return this._client._mgList();
  }

  /** Delete a flag by id. */
  async delete(id: string): Promise<void> {
    return this._client._mgDelete(id);
  }
}

/**
 * Client for the smplkit Flags API.
 *
 * Obtained via `SmplClient.flags`.
 */
export class FlagsClient {
  /** @internal */
  readonly _apiKey: string;
  /** @internal */
  readonly _baseUrl: string;

  /** @internal */
  private readonly _http: ReturnType<typeof createClient<import("../generated/flags.d.ts").paths>>;
  /** @internal */
  private readonly _appHttp: ReturnType<typeof createClient<import("../generated/app.d.ts").paths>>;

  // Runtime state
  private _environment: string | null = null;
  private _flagStore: Record<string, Record<string, any>> = {};
  private _initialized = false;
  private _cache = new ResolutionCache();
  private _contextProvider: (() => Context[]) | null = null;
  private _contextBuffer = new ContextRegistrationBuffer();
  private _flagBuffer = new FlagRegistrationBuffer();
  private _flagFlushTimer: ReturnType<typeof setInterval> | null = null;
  private _handles: Record<string, Flag> = {};
  private _globalListeners: Array<(event: FlagChangeEvent) => void> = [];
  private _keyListeners: Map<string, Array<(event: FlagChangeEvent) => void>> = new Map();

  // Shared WebSocket (set during initialize)
  private _wsManager: SharedWebSocket | null = null;
  private readonly _ensureWs: () => SharedWebSocket;

  /** @internal — set by SmplClient after construction. */
  _parent: {
    readonly _environment: string;
    readonly _service: string | null;
    readonly _metrics: MetricsReporter | null;
  } | null = null;

  /** Management API — CRUD operations on Flag models. */
  readonly management: FlagsManagement;

  /** @internal */
  constructor(
    apiKey: string,
    ensureWs: () => SharedWebSocket,
    timeout?: number,
    flagsBaseUrl?: string,
    appBaseUrl?: string,
  ) {
    this._apiKey = apiKey;
    this._ensureWs = ensureWs;
    const resolvedBaseUrl = flagsBaseUrl ?? FLAGS_BASE_URL;
    const resolvedAppBaseUrl = appBaseUrl ?? APP_BASE_URL;
    this._baseUrl = resolvedBaseUrl;
    const ms = timeout ?? 30_000;

    const fetchWithTimeout = async (request: Request): Promise<Response> => {
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
    };

    this._http = createClient<import("../generated/flags.d.ts").paths>({
      baseUrl: resolvedBaseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      fetch: fetchWithTimeout,
    });

    this._appHttp = createClient<import("../generated/app.d.ts").paths>({
      baseUrl: resolvedAppBaseUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      fetch: fetchWithTimeout,
    });
    this.management = new FlagsManagement(this);
  }

  // ------------------------------------------------------------------
  // Management: internal implementations (delegated from FlagsManagement)
  // ------------------------------------------------------------------

  /** @internal */
  _mgNewBooleanFlag(
    id: string,
    options: { default: boolean; name?: string; description?: string },
  ): BooleanFlag {
    return new BooleanFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "BOOLEAN",
      default: options.default,
      values: [
        { name: "True", value: true },
        { name: "False", value: false },
      ],
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @internal */
  _mgNewStringFlag(
    id: string,
    options: {
      default: string;
      name?: string;
      description?: string;
      values?: Array<{ name: string; value: unknown }>;
    },
  ): StringFlag {
    return new StringFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "STRING",
      default: options.default,
      values: options.values ?? null,
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @internal */
  _mgNewNumberFlag(
    id: string,
    options: {
      default: number;
      name?: string;
      description?: string;
      values?: Array<{ name: string; value: unknown }>;
    },
  ): NumberFlag {
    return new NumberFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "NUMERIC",
      default: options.default,
      values: options.values ?? null,
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @internal */
  _mgNewJsonFlag(
    id: string,
    options: {
      default: Record<string, any>;
      name?: string;
      description?: string;
      values?: Array<{ name: string; value: unknown }>;
    },
  ): JsonFlag {
    return new JsonFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "JSON",
      default: options.default,
      values: options.values ?? null,
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /** @internal */
  async _mgGet(id: string): Promise<Flag> {
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, `Flag with id '${id}' not found`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplNotFoundError(`Flag with id '${id}' not found`);
    }
    return this._resourceToModel(data.data);
  }

  /** @internal */
  async _mgList(): Promise<Flag[]> {
    let data: components["schemas"]["FlagListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags", {});
      if (!result.response.ok) await checkError(result.response, "Failed to list flags");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => this._resourceToModel(r));
  }

  /** @internal */
  async _mgDelete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/flags/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, `Failed to delete flag '${id}'`);
    } catch (err) {
      wrapFetchError(err);
    }
  }

  // ------------------------------------------------------------------
  // Management: internal save methods (called by Flag.save())
  // ------------------------------------------------------------------

  /** @internal — POST a new flag. */
  async _createFlag(flag: Flag): Promise<Flag> {
    const body = {
      data: {
        id: flag.id,
        type: "flag" as const,
        attributes: {
          name: flag.name,
          description: flag.description ?? "",
          type: flag.type,
          default: flag.default,
          values: flag.values as any,
          ...(Object.keys(flag.environments).length > 0 ? { environments: flag.environments } : {}),
        },
      },
    };

    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/flags", { body });
      if (!result.response.ok) await checkError(result.response, "Failed to create flag");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError("Failed to create flag");
    return this._resourceToModel(data.data);
  }

  /** @internal — PUT a flag update. */
  async _updateFlag(flag: Flag): Promise<Flag> {
    const body = {
      data: {
        type: "flag" as const,
        attributes: {
          name: flag.name,
          type: flag.type,
          default: flag.default,
          values: flag.values as any,
          description: flag.description ?? "",
          ...(Object.keys(flag.environments).length > 0 ? { environments: flag.environments } : {}),
        },
      },
    };

    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/flags/{id}", {
        params: { path: { id: flag.id! } },
        body,
      });
      if (!result.response.ok)
        await checkError(result.response, `Failed to update flag ${flag.id}`);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplValidationError(`Failed to update flag ${flag.id}`);
    return this._resourceToModel(data.data);
  }

  // ------------------------------------------------------------------
  // Runtime: typed flag handles
  // ------------------------------------------------------------------

  /** Declare a boolean flag handle for runtime evaluation. */
  booleanFlag(id: string, defaultValue: boolean): BooleanFlag {
    const handle = new BooleanFlag(this, {
      id,
      name: id,
      type: "BOOLEAN",
      default: defaultValue,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._flagBuffer.add(
      id,
      "BOOLEAN",
      defaultValue,
      this._parent?._service ?? null,
      this._parent?._environment ?? null,
    );
    if (this._flagBuffer.pendingCount >= FLAG_REGISTRATION_FLUSH_SIZE) {
      void this._flushFlags();
    }
    return handle;
  }

  /** Declare a string flag handle for runtime evaluation. */
  stringFlag(id: string, defaultValue: string): StringFlag {
    const handle = new StringFlag(this, {
      id,
      name: id,
      type: "STRING",
      default: defaultValue,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._flagBuffer.add(
      id,
      "STRING",
      defaultValue,
      this._parent?._service ?? null,
      this._parent?._environment ?? null,
    );
    if (this._flagBuffer.pendingCount >= FLAG_REGISTRATION_FLUSH_SIZE) {
      void this._flushFlags();
    }
    return handle;
  }

  /** Declare a numeric flag handle for runtime evaluation. */
  numberFlag(id: string, defaultValue: number): NumberFlag {
    const handle = new NumberFlag(this, {
      id,
      name: id,
      type: "NUMERIC",
      default: defaultValue,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._flagBuffer.add(
      id,
      "NUMERIC",
      defaultValue,
      this._parent?._service ?? null,
      this._parent?._environment ?? null,
    );
    if (this._flagBuffer.pendingCount >= FLAG_REGISTRATION_FLUSH_SIZE) {
      void this._flushFlags();
    }
    return handle;
  }

  /** Declare a JSON flag handle for runtime evaluation. */
  jsonFlag(id: string, defaultValue: Record<string, any>): JsonFlag {
    const handle = new JsonFlag(this, {
      id,
      name: id,
      type: "JSON",
      default: defaultValue,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._flagBuffer.add(
      id,
      "JSON",
      defaultValue,
      this._parent?._service ?? null,
      this._parent?._environment ?? null,
    );
    if (this._flagBuffer.pendingCount >= FLAG_REGISTRATION_FLUSH_SIZE) {
      void this._flushFlags();
    }
    return handle;
  }

  // ------------------------------------------------------------------
  // Runtime: context provider
  // ------------------------------------------------------------------

  /**
   * Register a context provider function.
   *
   * Called on every `handle.get()` to supply the current evaluation context.
   */
  setContextProvider(fn: () => Context[]): void {
    this._contextProvider = fn;
  }

  /**
   * Register a context provider — decorator-style alias.
   */
  contextProvider(fn: () => Context[]): () => Context[] {
    this._contextProvider = fn;
    return fn;
  }

  // ------------------------------------------------------------------
  // Runtime: initialize / disconnect / refresh
  // ------------------------------------------------------------------

  /**
   * Initialize the flags runtime.
   *
   * Idempotent — safe to call multiple times. Must be called (and awaited)
   * before using `.get()` on flag handles.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;
    debug("lifecycle", "FlagsClient.initialize() called");
    this._environment = this._parent?._environment ?? null;
    await this._flushFlags();
    await this._fetchAllFlags();
    this._initialized = true;
    this._cache.clear();

    // Register on the shared WebSocket
    this._wsManager = this._ensureWs();
    this._wsManager.on("flag_changed", this._handleFlagChanged);
    this._wsManager.on("flag_deleted", this._handleFlagDeleted);
    this._wsManager.on("flags_changed", this._handleFlagsChanged);

    // Start periodic flush timer
    this._flagFlushTimer = setInterval(() => {
      void this._flushFlags();
    }, FLAG_REGISTRATION_FLUSH_INTERVAL_MS);
  }

  /** Disconnect the flags runtime and release resources. */
  async disconnect(): Promise<void> {
    if (this._wsManager !== null) {
      this._wsManager.off("flag_changed", this._handleFlagChanged);
      this._wsManager.off("flag_deleted", this._handleFlagDeleted);
      this._wsManager.off("flags_changed", this._handleFlagsChanged);
      this._wsManager = null;
    }

    if (this._flagFlushTimer !== null) {
      clearInterval(this._flagFlushTimer);
      this._flagFlushTimer = null;
    }

    await this._flushContexts();
    this._flagStore = {};
    this._cache.clear();
    this._initialized = false;
    this._environment = null;
  }

  /** Refresh all flag definitions from the server. */
  async refresh(): Promise<void> {
    await this._fetchAllFlags();
    this._cache.clear();
    this._fireChangeListenersAll("manual");
  }

  /** Return the current real-time connection status. */
  connectionStatus(): string {
    if (this._wsManager !== null) {
      return this._wsManager.connectionStatus;
    }
    return "disconnected";
  }

  /** Return evaluation statistics. */
  stats(): FlagStats {
    return new FlagStats(this._cache.cacheHits, this._cache.cacheMisses);
  }

  // ------------------------------------------------------------------
  // Runtime: change listeners
  // ------------------------------------------------------------------

  /**
   * Register a change listener.
   *
   * - `onChange(callback)` — fires for any flag change.
   * - `onChange(id, callback)` — fires only for the specified flag id.
   */
  onChange(
    callbackOrId: string | ((event: FlagChangeEvent) => void),
    callback?: (event: FlagChangeEvent) => void,
  ): void {
    if (typeof callbackOrId === "function") {
      // Global listener
      this._globalListeners.push(callbackOrId);
    } else {
      // Id-scoped listener
      const id = callbackOrId;
      if (!callback) {
        throw new SmplError("onChange(id, callback) requires a callback function.");
      }
      if (!this._keyListeners.has(id)) {
        this._keyListeners.set(id, []);
      }
      this._keyListeners.get(id)!.push(callback);
    }
  }

  // ------------------------------------------------------------------
  // Runtime: context registration
  // ------------------------------------------------------------------

  /**
   * Register context(s) with the server.
   *
   * Accepts a single Context or an array. Works before `initialize()` is called.
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
   * Evaluate a flag with an explicit environment and context.
   */
  async evaluate(id: string, options: { environment: string; context: Context[] }): Promise<any> {
    const evalDict = contextsToEvalDict(options.context);

    // Auto-inject service context if set and not already provided
    if (this._parent?._service && !("service" in evalDict)) {
      evalDict["service"] = { key: this._parent._service };
    }

    // Use local store if initialized, otherwise fetch
    let flagDef: Record<string, any> | null = null;
    if (this._initialized && id in this._flagStore) {
      flagDef = this._flagStore[id];
    } else {
      const flags = await this._fetchFlagsList();
      for (const f of flags) {
        if (f.id === id) {
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
    if (!this._initialized) {
      throw new SmplError("Flags not initialized. Call await client.flags.initialize() first.");
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

    // Auto-inject service context if set and not already provided
    if (this._parent?._service && !("service" in evalDict)) {
      evalDict["service"] = { key: this._parent._service };
    }

    const ctxHash = hashContext(evalDict);
    const cacheKey = `${key}:${ctxHash}`;

    const [hit, cachedValue] = this._cache.get(cacheKey);
    if (hit) {
      const metrics = this._parent?._metrics;
      if (metrics) {
        metrics.record("flags.cache_hits", 1, "hits");
        metrics.record("flags.evaluations", 1, "evaluations", { flag: key });
      }
      return cachedValue;
    }

    // Cache miss
    const metrics = this._parent?._metrics;
    if (metrics) {
      metrics.record("flags.cache_misses", 1, "misses");
      metrics.record("flags.evaluations", 1, "evaluations", { flag: key });
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
  // Internal: _connectInternal (called by SmplClient for backward compat)
  // ------------------------------------------------------------------

  /** @internal — called by SmplClient constructor / lazy init. */
  async _connectInternal(environment: string): Promise<void> {
    this._environment = environment;
    await this._flushFlags();
    await this._fetchAllFlags();
    this._initialized = true;
    this._cache.clear();

    // Register on the shared WebSocket
    this._wsManager = this._ensureWs();
    this._wsManager.on("flag_changed", this._handleFlagChanged);
    this._wsManager.on("flag_deleted", this._handleFlagDeleted);
    this._wsManager.on("flags_changed", this._handleFlagsChanged);

    // Start periodic flush timer
    this._flagFlushTimer = setInterval(() => {
      void this._flushFlags();
    }, FLAG_REGISTRATION_FLUSH_INTERVAL_MS);
  }

  // ------------------------------------------------------------------
  // Internal: event handlers (called by SharedWebSocket)
  // ------------------------------------------------------------------

  private _handleFlagChanged = (data: Record<string, any>): void => {
    debug("websocket", `flag_changed event received: ${JSON.stringify(data)}`);
    const flagKey = data.id as string | undefined;
    if (!flagKey) return;
    // Scoped fetch: GET /flags/{key}
    void this._fetchSingleFlag(flagKey).then((newDef) => {
      const oldDef = this._flagStore[flagKey];
      const oldJson = oldDef !== undefined ? JSON.stringify(oldDef) : null;
      const newJson = newDef !== undefined ? JSON.stringify(newDef) : null;
      if (oldJson === newJson) return; // no change — skip listeners
      if (newDef !== undefined) {
        this._flagStore[flagKey] = newDef;
      } else {
        delete this._flagStore[flagKey];
      }
      this._cache.clear();
      this._fireChangeListeners(flagKey, "websocket");
    });
  };

  private _handleFlagDeleted = (data: Record<string, any>): void => {
    debug("websocket", `flag_deleted event received: ${JSON.stringify(data)}`);
    const flagKey = data.id as string | undefined;
    if (!flagKey) return;
    // Remove from store — no HTTP fetch
    if (flagKey in this._flagStore) {
      delete this._flagStore[flagKey];
    }
    this._cache.clear();
    const deletedEvent = new FlagChangeEvent(flagKey, "websocket", true);
    for (const cb of this._globalListeners) {
      try {
        cb(deletedEvent);
      } catch {
        // ignore listener errors
      }
    }
    const keyCallbacks = this._keyListeners.get(flagKey);
    if (keyCallbacks) {
      for (const cb of keyCallbacks) {
        try {
          cb(deletedEvent);
        } catch {
          // ignore listener errors
        }
      }
    }
  };

  private _handleFlagsChanged = (_data: Record<string, any>): void => {
    debug("websocket", `flags_changed event received`);
    // Full list fetch, diff pre vs post store, fire global listener ONCE + per-key for changed keys
    const preStore = { ...this._flagStore };
    void this._fetchAllFlags().then(() => {
      this._cache.clear();
      const postStore = this._flagStore;
      const changedKeys = new Set<string>();
      const allKeys = new Set([...Object.keys(preStore), ...Object.keys(postStore)]);
      for (const key of allKeys) {
        const preJson = preStore[key] !== undefined ? JSON.stringify(preStore[key]) : null;
        const postJson = postStore[key] !== undefined ? JSON.stringify(postStore[key]) : null;
        if (preJson !== postJson) {
          changedKeys.add(key);
        }
      }
      if (changedKeys.size === 0) return; // nothing changed
      // Fire global listener ONCE (with the first changed key as representative)
      const [firstKey] = changedKeys;
      const globalEvent = new FlagChangeEvent(firstKey, "websocket");
      for (const cb of this._globalListeners) {
        try {
          cb(globalEvent);
        } catch {
          // ignore listener errors
        }
      }
      // Fire per-key listeners for each changed key
      for (const key of changedKeys) {
        const keyCallbacks = this._keyListeners.get(key);
        if (keyCallbacks) {
          const keyEvent = new FlagChangeEvent(key, "websocket");
          for (const cb of keyCallbacks) {
            try {
              cb(keyEvent);
            } catch {
              // ignore listener errors
            }
          }
        }
      }
    });
  };

  // ------------------------------------------------------------------
  // Internal: flag store
  // ------------------------------------------------------------------

  private async _fetchAllFlags(): Promise<void> {
    const flags = await this._fetchFlagsList();
    const store: Record<string, Record<string, any>> = {};
    for (const f of flags) {
      store[f.id] = f;
    }
    this._flagStore = store;
  }

  /** Fetch a single flag by key. Returns undefined if not found. @internal */
  private async _fetchSingleFlag(key: string): Promise<Record<string, any> | undefined> {
    debug("api", `GET /api/v1/flags/${key}`);
    try {
      const result = await this._http.GET("/api/v1/flags/{id}", {
        params: { path: { id: key } },
      });
      if (!result.response.ok) return undefined;
      if (!result.data?.data) return undefined;
      return this._resourceToPlainDict(result.data.data);
    } catch {
      return undefined;
    }
  }

  private async _fetchFlagsList(): Promise<Array<Record<string, any>>> {
    debug("api", "GET /api/v1/flags");
    let data: components["schemas"]["FlagListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags", {});
      if (!result.response.ok) await checkError(result.response, "Failed to list flags");
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    const flags = data.data.map((r) => this._resourceToPlainDict(r));
    debug("api", `GET /api/v1/flags -> ${flags.length} flag(s)`);
    return flags;
  }

  // ------------------------------------------------------------------
  // Internal: change listeners
  // ------------------------------------------------------------------

  private _fireChangeListeners(flagId: string | null, source: string): void {
    if (flagId) {
      const event = new FlagChangeEvent(flagId, source);
      // Global listeners first
      for (const cb of this._globalListeners) {
        try {
          cb(event);
        } catch {
          // ignore listener errors
        }
      }
      // Id-scoped listeners
      const idCallbacks = this._keyListeners.get(flagId);
      if (idCallbacks) {
        for (const cb of idCallbacks) {
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
    for (const flagId of Object.keys(this._flagStore)) {
      this._fireChangeListeners(flagId, source);
    }
  }

  // ------------------------------------------------------------------
  // Internal: flag registration flush
  // ------------------------------------------------------------------

  private async _flushFlags(): Promise<void> {
    const batch = this._flagBuffer.drain();
    if (batch.length === 0) return;
    debug("registration", `flushing ${batch.length} flag(s) to bulk-register endpoint`);
    try {
      await this._http.POST("/api/v1/flags/bulk", {
        body: { flags: batch },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[smplkit] Failed to bulk-register flags: ${msg}`);
      debug(
        "registration",
        `flag bulk-register error: ${err instanceof Error ? (err.stack ?? msg) : msg}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Internal: context flush
  // ------------------------------------------------------------------

  private async _flushContexts(): Promise<void> {
    const batch = this._contextBuffer.drain();
    if (batch.length === 0) return;
    try {
      await this._appHttp.POST("/api/v1/contexts/bulk", {
        body: {
          contexts: batch.map((ctx) => ({
            type: ctx.type,
            key: ctx.key,
            attributes: ctx.attributes,
          })),
        },
      });
    } catch {
      // Fire-and-forget: ignore registration failures
    }
  }

  // ------------------------------------------------------------------
  // Internal: model conversion
  // ------------------------------------------------------------------

  /** @internal */
  _resourceToModel(resource: FlagResource): Flag {
    const attrs = resource.attributes;
    return new Flag(this, {
      id: resource.id ?? null,
      name: attrs.name,
      type: attrs.type ?? null,
      default: attrs.default,
      values: attrs.values ? attrs.values.map((v) => ({ name: v.name, value: v.value })) : null,
      description: attrs.description ?? null,
      environments: attrs.environments ?? {},
      createdAt: attrs.created_at ?? null,
      updatedAt: attrs.updated_at ?? null,
    });
  }

  private _resourceToPlainDict(resource: FlagResource): Record<string, any> {
    const attrs = resource.attributes;
    return {
      id: resource.id ?? null,
      name: attrs.name,
      type: attrs.type,
      default: attrs.default,
      values: attrs.values ? attrs.values.map((v) => ({ name: v.name, value: v.value })) : null,
      description: attrs.description ?? null,
      environments: attrs.environments ?? {},
    };
  }
}
