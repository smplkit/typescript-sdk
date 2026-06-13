/**
 * The Smpl Flags client — one unified `FlagsClient`.
 *
 * Smpl Flags has two surfaces on a single client, mirroring how the config,
 * audit, and jobs clients expose their full surface from one class:
 *
 * - **CRUD surface** — pure CRUD, no live connection:
 *   `newBooleanFlag` / `newStringFlag` / `newNumberFlag` / `newJsonFlag`
 *   constructors, `get` / `list` / `delete` CRUD, and the flag-declaration
 *   discovery buffer (`register` / `flush` / `pendingCount`). The client owns
 *   the discovery buffer directly.
 * - **Live surface** — lazily connects to your running service on first use:
 *   the typed handle declarations (`booleanFlag` / `stringFlag` /
 *   `numberFlag` / `jsonFlag`) whose `.get()` evaluates against the cached
 *   definitions, plus `refresh` / `stats` / `onChange`. The first live call
 *   transparently flushes discovery, fetches all flag definitions into the
 *   local cache, and opens the live-updates WebSocket — no explicit install
 *   step.
 *
 * The client supports two construction shapes:
 *
 * - **Wired** into {@link SmplClient} — borrows the parent's flags transport
 *   for both runtime fetch and CRUD, the parent's shared WebSocket for the
 *   live channel, and `client.platform.contexts` for evaluation-context
 *   registration. This is the common path.
 * - **Standalone** — `new FlagsClient({ apiKey, baseUrl, ... })` builds and
 *   owns its own flags transport and a contexts client (against its own app
 *   transport), and on first live use opens and owns its own WebSocket.
 *   `close()` tears down only the owned transports and owned WebSocket.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/flags.d.ts";
import {
  SmplkitError,
  SmplkitConflictError,
  SmplkitConnectionError,
  SmplkitNotFoundError,
  SmplkitTimeoutError,
  SmplkitValidationError,
  throwForStatus,
} from "../errors.js";
import { resolveClientConfig, serviceUrl } from "../config.js";
import {
  Flag,
  BooleanFlag,
  StringFlag,
  NumberFlag,
  JsonFlag,
  FlagValue,
  FlagRule,
  FlagEnvironment,
} from "./models.js";
import { Context, FlagDeclaration } from "./types.js";
import { getRequestContext } from "../context.js";
import { keyToDisplayName } from "../helpers.js";
import { ContextsClient } from "../platform/client.js";
import { ContextRegistrationBuffer } from "../buffer.js";
import type { MetricsReporter } from "../_metrics.js";
import { SharedWebSocket } from "../ws.js";
import { debug } from "../_debug.js";

// Use require-style import for json-logic-js (no TS types)
// eslint-disable-next-line @typescript-eslint/no-require-imports
import jsonLogic from "json-logic-js";

type FlagsHttp = ReturnType<typeof createClient<import("../generated/flags.d.ts").paths>>;
type AppHttp = ReturnType<typeof createClient<import("../generated/app.d.ts").paths>>;
type FlagResource = components["schemas"]["FlagResource"];

/** @internal — the owning {@link SmplClient} interface the wired client borrows. */
export interface FlagsParent {
  readonly _environment: string;
  readonly _service: string | null;
  _ensureStarted(): void;
  _ensureWs(): SharedWebSocket;
}

const FLAGS_BASE_URL = "https://flags.smplkit.com";

const CACHE_MAX_SIZE = 10_000;

/** Flush the discovery buffer once it reaches this many pending flags. */
const FLAG_BATCH_FLUSH_SIZE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @internal */
async function checkError(response: Response, error?: unknown): Promise<never> {
  // ``openapi-fetch`` pre-reads the response body to populate ``result.error``
  // / ``result.data`` — by the time we get here ``response.text()`` returns
  // ``""`` because the stream is consumed. Prefer the pre-parsed error payload
  // when openapi-fetch handed one to us; fall back to a fresh ``.text()``.
  let body = "";
  if (error !== undefined && error !== null) {
    try {
      body = typeof error === "string" ? error : JSON.stringify(error);
      /* v8 ignore start — defensive guard; openapi-fetch parses JSON itself
         so circular refs / BigInts never reach this code path. */
    } catch {
      // leave body empty; throwForStatus tolerates an empty payload
    }
    /* v8 ignore stop */
  }
  /* v8 ignore start — fallback for the rare null/empty-error case. */
  if (!body) {
    body = await response.text().catch(() => "");
  }
  /* v8 ignore stop */
  throwForStatus(response.status, body);
}

/** @internal */
function wrapFetchError(err: unknown): never {
  if (
    err instanceof SmplkitNotFoundError ||
    err instanceof SmplkitConflictError ||
    err instanceof SmplkitValidationError ||
    err instanceof SmplkitError
  ) {
    throw err;
  }
  if (err instanceof TypeError) {
    throw new SmplkitConnectionError(`Network error: ${err.message}`);
  }
  throw new SmplkitConnectionError(
    `Request failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** Convert a list of Context objects to the nested evaluation dict. @internal */
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

/** @internal Convert wire-shaped environments to typed FlagEnvironment dict. */
function convertEnvironments(
  raw: Record<string, any> | null | undefined,
): Record<string, FlagEnvironment> {
  const out: Record<string, FlagEnvironment> = {};
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    const rules = Array.isArray(v?.rules)
      ? v.rules.map(
          (r: any) =>
            new FlagRule({
              logic: r.logic ?? {},
              value: r.value,
              description: r.description ?? null,
            }),
        )
      : [];
    out[k] = new FlagEnvironment({
      enabled: v?.enabled ?? true,
      default: v?.default ?? null,
      rules,
    });
  }
  return out;
}

/** @internal Convert typed environments back to wire shape. */
function environmentsToWire(envs: Record<string, FlagEnvironment>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(envs)) {
    out[k] = {
      enabled: v.enabled,
      default: v.default ?? null,
      rules: v.rules.map((r) => ({
        logic: r.logic,
        value: r.value,
        ...(r.description !== null ? { description: r.description } : {}),
      })),
    };
  }
  return out;
}

/** @internal Shared attribute payload for create + update. */
function flagAttrs(flag: Flag): components["schemas"]["Flag"] {
  return {
    name: flag.name,
    description: flag.description ?? "",
    type: flag.type,
    default: flag.default,
    values: flag.values?.map((v) => ({ name: v.name, value: v.value })),
    ...(Object.keys(flag.environments).length > 0
      ? { environments: environmentsToWire(flag._envsRaw()) }
      : {}),
  } as components["schemas"]["Flag"];
}

/**
 * Build the JSON:API request body for `POST /api/v1/flags` (create).
 *
 * The create envelope requires `data.id` to be a non-null string — the
 * flag key is caller-supplied. Update has its own builder because the
 * update envelope keeps `id` optional/nullable.
 * @internal
 */
function flagToCreateBody(flag: Flag): components["schemas"]["FlagCreateRequest"] {
  /* v8 ignore start — defensive guard: `Flag.id` is always set by the
     `client.flags.new*(id, ...)` factories, the only public paths that
     reach `_createFlag`. Spec narrowing requires a non-null `data.id`. */
  if (flag.id === null) {
    throw new SmplkitValidationError("Cannot create a Flag without an id");
  }
  /* v8 ignore stop */
  return {
    data: {
      id: flag.id,
      type: "flag",
      attributes: flagAttrs(flag),
    },
  };
}

/** @internal Build the JSON:API request body for `PUT /api/v1/flags/{id}` (update). */
function flagToUpdateBody(flag: Flag): components["schemas"]["FlagRequest"] {
  return {
    data: {
      id: flag.id ?? null,
      type: "flag",
      attributes: flagAttrs(flag),
    },
  };
}

/** @internal */
function _flagSubclassFor(
  type: string,
  client: FlagsClient,
  fields: ConstructorParameters<typeof Flag>[1],
): Flag {
  switch (type) {
    case "BOOLEAN":
      return new BooleanFlag(client, fields);
    case "STRING":
      return new StringFlag(client, fields);
    case "NUMERIC":
      return new NumberFlag(client, fields);
    case "JSON":
      return new JsonFlag(client, fields);
    default:
      return new Flag(client, fields);
  }
}

/** @internal — construct a typed {@link Flag} model from a wire resource. */
function resourceToFlag(resource: FlagResource, client: FlagsClient): Flag {
  const attrs = resource.attributes;
  const values = attrs.values
    ? attrs.values.map((v) => new FlagValue({ name: v.name, value: v.value }))
    : null;
  return _flagSubclassFor(attrs.type, client, {
    id: resource.id ?? null,
    name: attrs.name,
    type: attrs.type,
    default: attrs.default,
    values,
    description: attrs.description ?? null,
    environments: convertEnvironments(attrs.environments),
    createdAt: attrs.created_at ?? null,
    updatedAt: attrs.updated_at ?? null,
  });
}

/** Shape a flag wire resource into the runtime store format. @internal */
function storeEntry(resource: FlagResource): Record<string, any> {
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

/** @internal */
function _coerceValues(
  values?: Array<FlagValue | { name: string; value: unknown }>,
): FlagValue[] | null {
  if (values === undefined) return null;
  return values.map((v) => (v instanceof FlagValue ? v : new FlagValue(v)));
}

/**
 * Evaluate a flag definition against the given context.
 *
 * Evaluation order:
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

/** Describes a flag definition change. Frozen — fields are set at construction. */
export class FlagChangeEvent {
  /** The flag id that changed. */
  readonly id: string;
  /** How the change was delivered (`"websocket"` or `"manual"`). */
  readonly source: string;
  /** True when the flag was deleted. */
  readonly deleted: boolean;

  constructor(fields: { id: string; source: string; deleted?: boolean }) {
    this.id = fields.id;
    this.source = fields.source;
    this.deleted = fields.deleted ?? false;
    Object.freeze(this);
  }
}

// ---------------------------------------------------------------------------
// Resolution cache + stats
// ---------------------------------------------------------------------------

/** Thread-safe LRU resolution cache with hit/miss stats. @internal */
class ResolutionCache {
  private _maxSize: number;
  private _cache = new Map<string, any>();
  cacheHits = 0;
  cacheMisses = 0;

  constructor(maxSize: number = CACHE_MAX_SIZE) {
    this._maxSize = maxSize;
  }

  /** Return [hit, value]. Moves the key to end on hit. */
  get(cacheKey: string): [boolean, any] {
    if (this._cache.has(cacheKey)) {
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
      const firstKey = this._cache.keys().next().value;
      /* v8 ignore next 3 — LRU eviction only fires past 10k distinct keys. */
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

  constructor(fields: { cacheHits: number; cacheMisses: number }) {
    this.cacheHits = fields.cacheHits;
    this.cacheMisses = fields.cacheMisses;
    Object.freeze(this);
  }
}

// ---------------------------------------------------------------------------
// Flag registration buffer
// ---------------------------------------------------------------------------

/**
 * Buffer pending flag declarations for bulk registration. @internal
 *
 * Items remain in the buffer until a flush commits them, so a flush
 * against an unhealthy `flags` service is retried by the next flush.
 * Mirrors Python's `_FlagRegistrationBuffer`.
 */
export class FlagRegistrationBuffer {
  private _seen = new Set<string>();
  private _pending: Array<components["schemas"]["FlagBulkItem"]> = [];

  add(
    id: string,
    type: components["schemas"]["FlagBulkItem"]["type"],
    defaultValue: unknown,
    service: string | null,
    environment: string | null,
  ): void {
    if (this._seen.has(id)) return;
    this._seen.add(id);
    this._pending.push({
      id,
      type,
      default: defaultValue,
      service: service ?? undefined,
      environment: environment ?? undefined,
    });
  }

  /** Non-destructive snapshot — items remain in the buffer until committed. */
  peek(): Array<components["schemas"]["FlagBulkItem"]> {
    return [...this._pending];
  }

  /** Remove successfully-sent items by id. Called after a successful POST. */
  commit(ids: Set<string>): void {
    this._pending = this._pending.filter((item) => !ids.has(item.id));
  }

  get pendingCount(): number {
    return this._pending.length;
  }
}

// ---------------------------------------------------------------------------
// FlagsClient
// ---------------------------------------------------------------------------

/** Configuration options for the {@link FlagsClient}. */
export interface FlagsClientOptions {
  /** API key. When omitted, resolved from `SMPLKIT_API_KEY` or `~/.smplkit`. */
  apiKey?: string;
  /**
   * Deployment environment used to resolve runtime flag values and to
   * scope discovery declarations. Optional.
   */
  environment?: string;
  /**
   * Full flags-service base URL. Usually resolved from `baseDomain`/`scheme`;
   * supplied directly by the top-level clients which have already computed it.
   */
  baseUrl?: string;
  /** Named `~/.smplkit` profile section. */
  profile?: string;
  /** Base domain for API requests (default `"smplkit.com"`). */
  baseDomain?: string;
  /** URL scheme (default `"https"`). */
  scheme?: string;
  /** Enable SDK debug logging. */
  debug?: boolean;
  /** Extra headers attached to every request. */
  extraHeaders?: Record<string, string>;
  /** Request timeout in milliseconds (default 30000). */
  timeout?: number;
  /**
   * Internal — the owning {@link SmplClient}. Not for direct use.
   * @internal
   */
  parent?: FlagsParent;
  /**
   * Internal — a pre-built flags transport supplied by a top-level client so
   * the flags surface shares one connection pool. Not for direct use.
   * @internal
   */
  transport?: FlagsHttp;
  /**
   * Internal — `client.platform.contexts` used for evaluation-context
   * registration. Not for direct use.
   * @internal
   */
  contexts?: ContextsClient;
  /**
   * Internal — the parent's metrics reporter.
   * @internal
   */
  metrics?: MetricsReporter | null;
}

/**
 * The Smpl Flags client.
 *
 * One client exposes the full surface, reachable as `client.flags`
 * ({@link SmplClient}) or constructed directly:
 *
 * @example
 * ```typescript
 * import { FlagsClient } from "@smplkit/sdk";
 *
 * const flags = new FlagsClient({ environment: "production" });
 * const newFlag = flags.newBooleanFlag("beta", { default: false });
 * await newFlag.save();
 * const beta = flags.booleanFlag("beta", false);
 * if (await beta.get()) {
 *   // ...
 * }
 * ```
 *
 * The CRUD surface (`new*` / `get` / `list` / `delete` and discovery)
 * is pure CRUD. The live surface (`booleanFlag` / `stringFlag` /
 * `numberFlag` / `jsonFlag` / `refresh` / `stats` / `onChange`) connects
 * lazily on first use — the first call flushes discovery, fetches all flag
 * definitions into the local cache, and opens the live-updates WebSocket. No
 * explicit install step is required.
 */
export class FlagsClient {
  /** @internal */
  private readonly _http: FlagsHttp;
  /** @internal */
  private readonly _parent: FlagsParent | null;
  /** @internal */
  private readonly _metrics: MetricsReporter | null;
  /** @internal */
  private readonly _environment: string | null;
  /** @internal */
  private readonly _service: string | null;

  /** @internal — evaluation-context registration seam (borrowed or owned). */
  private readonly _contexts: ContextsClient | null;

  /** @internal — owned discovery buffer (no management delegation). */
  readonly _buffer = new FlagRegistrationBuffer();

  // Standalone-only transport / WebSocket state.
  private readonly _appBaseUrl: string | null;
  private readonly _appHttpStandalone: AppHttp | null;
  private readonly _standaloneApiKey: string | null;
  private _wsManager: SharedWebSocket | null = null;
  private _ownsWs = false;

  // Live-surface state.
  private _flagStore: Record<string, Record<string, any>> = {};
  private _connected = false;
  private _wsSubscribed = false;
  private _cache = new ResolutionCache();
  private _handles: Record<string, Flag> = {};
  private _contextProvider: (() => Context[]) | null = null;
  private _globalListeners: Array<(event: FlagChangeEvent) => void> = [];
  private _keyListeners: Map<string, Array<(event: FlagChangeEvent) => void>> = new Map();

  constructor(options: FlagsClientOptions = {}) {
    this._parent = options.parent ?? null;
    this._metrics = options.metrics ?? null;
    this._environment = options.parent?._environment ?? options.environment ?? null;
    this._service = options.parent?._service ?? null;

    if (options.transport !== undefined) {
      this._http = options.transport;
      this._appBaseUrl = null;
      this._appHttpStandalone = null;
      this._standaloneApiKey = null;
      // Wired: borrow client.platform.contexts as the evaluation-context
      // registration seam.
      this._contexts = options.contexts ?? null;
    } else {
      const cfg = resolveClientConfig(options);
      const flagsUrl =
        options.baseUrl ?? serviceUrl(cfg.scheme, "flags", cfg.baseDomain) ?? FLAGS_BASE_URL;
      this._appBaseUrl = serviceUrl(cfg.scheme, "app", cfg.baseDomain);
      this._standaloneApiKey = options.apiKey ?? cfg.apiKey;
      const ms = options.timeout ?? 30_000;
      const fetchWithTimeout = async (request: Request): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ms);
        try {
          return await fetch(new Request(request, { signal: controller.signal }));
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw new SmplkitTimeoutError(`Request timed out after ${ms}ms`);
          }
          throw err;
        } finally {
          clearTimeout(timer);
        }
      };
      this._http = createClient<import("../generated/flags.d.ts").paths>({
        baseUrl: flagsUrl.replace(/\/+$/, ""),
        headers: {
          ...(options.extraHeaders ?? {}),
          Authorization: `Bearer ${this._standaloneApiKey}`,
          Accept: "application/json",
        },
        fetch: fetchWithTimeout,
      });
      // Standalone: build our own contexts client (and own its app transport).
      this._appHttpStandalone = createClient<import("../generated/app.d.ts").paths>({
        baseUrl: this._appBaseUrl.replace(/\/+$/, ""),
        headers: {
          ...(options.extraHeaders ?? {}),
          Authorization: `Bearer ${this._standaloneApiKey}`,
          Accept: "application/json",
        },
        fetch: fetchWithTimeout,
      });
      this._contexts = new ContextsClient(this._appHttpStandalone, new ContextRegistrationBuffer());
    }
  }

  // ------------------------------------------------------------------
  // Management surface: CRUD (no live connection)
  // ------------------------------------------------------------------

  /**
   * Return a new unsaved boolean {@link BooleanFlag}. Call `save()` to persist.
   *
   * @param id - Stable flag identifier. Unique per account.
   * @param options.default - Value served when no environment override or rule applies.
   * @param options.name - Human-readable display name. Defaults to a title-cased
   *   form of `id`.
   * @param options.description - Optional free-text description of the flag.
   * @returns An unsaved {@link BooleanFlag}; call `save()` to persist it.
   */
  newBooleanFlag(
    id: string,
    options: { default: boolean; name?: string; description?: string },
  ): BooleanFlag {
    return new BooleanFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "BOOLEAN",
      default: options.default,
      values: [
        new FlagValue({ name: "True", value: true }),
        new FlagValue({ name: "False", value: false }),
      ],
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * Return a new unsaved string {@link StringFlag}. Call `save()` to persist.
   *
   * @param id - Stable flag identifier. Unique per account.
   * @param options.default - Value served when no environment override or rule applies.
   * @param options.name - Human-readable display name. Defaults to a title-cased
   *   form of `id`.
   * @param options.description - Optional free-text description of the flag.
   * @param options.values - Optional list of allowed values constraining what the
   *   flag may serve. When omitted, the flag is unconstrained.
   * @returns An unsaved {@link StringFlag}; call `save()` to persist it.
   */
  newStringFlag(
    id: string,
    options: {
      default: string;
      name?: string;
      description?: string;
      values?: Array<FlagValue | { name: string; value: unknown }>;
    },
  ): StringFlag {
    return new StringFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "STRING",
      default: options.default,
      values: _coerceValues(options.values),
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * Return a new unsaved numeric {@link NumberFlag}. Call `save()` to persist.
   *
   * @param id - Stable flag identifier. Unique per account.
   * @param options.default - Value served when no environment override or rule applies.
   * @param options.name - Human-readable display name. Defaults to a title-cased
   *   form of `id`.
   * @param options.description - Optional free-text description of the flag.
   * @param options.values - Optional list of allowed values constraining what the
   *   flag may serve. When omitted, the flag is unconstrained.
   * @returns An unsaved {@link NumberFlag}; call `save()` to persist it.
   */
  newNumberFlag(
    id: string,
    options: {
      default: number;
      name?: string;
      description?: string;
      values?: Array<FlagValue | { name: string; value: unknown }>;
    },
  ): NumberFlag {
    return new NumberFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "NUMERIC",
      default: options.default,
      values: _coerceValues(options.values),
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * Return a new unsaved JSON {@link JsonFlag}. Call `save()` to persist.
   *
   * @param id - Stable flag identifier. Unique per account.
   * @param options.default - Value served when no environment override or rule applies.
   * @param options.name - Human-readable display name. Defaults to a title-cased
   *   form of `id`.
   * @param options.description - Optional free-text description of the flag.
   * @param options.values - Optional list of allowed values constraining what the
   *   flag may serve. When omitted, the flag is unconstrained.
   * @returns An unsaved {@link JsonFlag}; call `save()` to persist it.
   */
  newJsonFlag(
    id: string,
    options: {
      default: Record<string, unknown>;
      name?: string;
      description?: string;
      values?: Array<FlagValue | { name: string; value: unknown }>;
    },
  ): JsonFlag {
    return new JsonFlag(this, {
      id,
      name: options.name ?? keyToDisplayName(id),
      type: "JSON",
      default: options.default,
      values: _coerceValues(options.values),
      description: options.description ?? null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
  }

  /**
   * Fetch the editable {@link Flag} resource by id.
   *
   * @param id - Identifier of the flag to fetch.
   * @returns The {@link Flag}, ready to mutate and `save()`.
   * @throws {@link SmplkitNotFoundError} No flag with that id exists for the account.
   */
  async get(id: string): Promise<Flag> {
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitNotFoundError(`Flag with id ${JSON.stringify(id)} not found`);
    }
    return resourceToFlag(data.data, this);
  }

  /**
   * List flags for the authenticated account.
   *
   * @param params.pageNumber - 1-based page index to fetch. When omitted, the
   *   server default applies.
   * @param params.pageSize - Number of flags per page. When omitted, the server
   *   default applies.
   * @returns The flags on the requested page.
   */
  async list(params: { pageNumber?: number; pageSize?: number } = {}): Promise<Flag[]> {
    const query: Record<string, number> = {};
    if (params.pageNumber !== undefined) query["page[number]"] = params.pageNumber;
    if (params.pageSize !== undefined) query["page[size]"] = params.pageSize;
    let data: components["schemas"]["FlagListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags", {
        params: { query: query as unknown as Record<string, never> },
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToFlag(r, this));
  }

  /**
   * Delete a flag by id.
   *
   * @param id - Identifier of the flag to delete.
   * @throws {@link SmplkitNotFoundError} No flag with that id exists for the account.
   */
  async delete(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/flags/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response, result.error);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /** @internal — called by `Flag.save()` for new resources. */
  async _createFlag(flag: Flag): Promise<Flag> {
    const body = flagToCreateBody(flag);
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/flags", { body });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) throw new SmplkitValidationError("Failed to create flag");
    return resourceToFlag(data.data, this);
  }

  /** @internal — called by `Flag.save()` for existing resources. */
  async _updateFlag(flag: Flag): Promise<Flag> {
    if (flag.id === null) throw new Error("Cannot update a Flag with no id");
    const body = flagToUpdateBody(flag);
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/flags/{id}", {
        params: { path: { id: flag.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response, result.error);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitValidationError(`Failed to update flag ${flag.id}`);
    }
    return resourceToFlag(data.data, this);
  }

  // ------------------------------------------------------------------
  // Management surface: discovery buffer (owned directly)
  // ------------------------------------------------------------------

  /**
   * Buffer flag declarations for bulk-discovery upload; optionally flush now.
   *
   * @param items - A single {@link FlagDeclaration} or a list of them to queue.
   * @param options.flush - When `true`, send the buffered declarations immediately
   *   via {@link flush} before returning. When `false` (the default), they stay
   *   buffered and are sent on the next flush — automatic once the buffer reaches
   *   its batch size, or on the first live call.
   */
  async register(
    items: FlagDeclaration | FlagDeclaration[],
    options: { flush?: boolean } = {},
  ): Promise<void> {
    const batch = Array.isArray(items) ? items : [items];
    for (const d of batch) {
      this._buffer.add(
        d.id,
        d.type as components["schemas"]["FlagBulkItem"]["type"],
        d.default,
        d.service,
        d.environment,
      );
    }
    if (options.flush) {
      await this.flush();
      return;
    }
    if (this._buffer.pendingCount >= FLAG_BATCH_FLUSH_SIZE) {
      void this._thresholdFlush();
    }
  }

  /** @internal */
  private async _thresholdFlush(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      debug(
        "flags",
        `Flag registration flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * POST pending declarations to the flags bulk endpoint.
   *
   * Items remain in the buffer until the request succeeds, so a flush
   * against an unhealthy `flags` service is automatically retried by the
   * next `flush()` call (periodic background flush, install retry, or
   * final flush on close).
   *
   * @returns A promise that resolves once the buffered declarations have been sent.
   */
  async flush(): Promise<void> {
    const batch = this._buffer.peek();
    if (batch.length === 0) return;
    const result = await this._http.POST("/api/v1/flags/bulk", {
      body: { flags: batch },
    });
    if (!result.response.ok) {
      await checkError(result.response, result.error);
      /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
    }
    this._buffer.commit(new Set(batch.map((b) => b.id)));
  }

  /** Number of pending flag declarations awaiting flush. */
  get pendingCount(): number {
    return this._buffer.pendingCount;
  }

  /** @internal — queue a declared flag with the owned discovery buffer. */
  private _observeDeclaration(
    flagId: string,
    flagType: components["schemas"]["FlagBulkItem"]["type"],
    defaultValue: unknown,
  ): void {
    void this.register(
      new FlagDeclaration({
        id: flagId,
        type: flagType,
        default: defaultValue,
        service: this._service,
        environment: this._environment,
      }),
    );
  }

  // ------------------------------------------------------------------
  // Live surface: lazy connect + transport / WebSocket helpers
  // ------------------------------------------------------------------

  /** Return the shared WebSocket — the parent's when wired, else our own. @internal */
  private _ensureWs(): SharedWebSocket {
    if (this._parent !== null) {
      return this._parent._ensureWs();
    }
    if (this._wsManager === null) {
      this._wsManager = new SharedWebSocket(
        this._appBaseUrl!,
        this._standaloneApiKey!,
        this._metrics,
      );
      this._wsManager.start();
      this._ownsWs = true;
    }
    return this._wsManager;
  }

  /**
   * Open the live connection to the running Smpl Flags service.
   *
   * Flushes any buffered discovery declarations, fetches all flag
   * definitions into the local cache, opens the shared WebSocket, and
   * subscribes to `flag_changed` / `flag_deleted` / `flags_changed` events.
   *
   * Idempotent and internal — every live method calls it on first use, so the
   * live surface auto-connects with no explicit step.
   * @internal
   */
  async _ensureConnected(): Promise<void> {
    if (this._parent !== null) {
      this._parent._ensureStarted();
    }
    if (this._connected) return;

    // Flush discovered flags BEFORE fetching definitions so the fetch
    // reflects them. Items stay in the buffer until the POST succeeds.
    try {
      await this.flush();
    } catch (err) {
      debug(
        "flags",
        `Flags discovery flush before connect failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await this._fetchAllFlags();
    this._cache.clear();
    this._connected = true;

    const ws = this._ensureWs();
    if (!this._wsSubscribed) {
      ws.on("flag_changed", this._handleFlagChanged);
      ws.on("flag_deleted", this._handleFlagDeleted);
      ws.on("flags_changed", this._handleFlagsChanged);
      this._wsSubscribed = true;
    }
  }

  // ------------------------------------------------------------------
  // Live surface: typed flag handles
  // ------------------------------------------------------------------

  /**
   * Declare a boolean flag handle for live evaluation. Connects lazily on first use.
   *
   * @param id - Identifier of the flag to evaluate.
   * @param defaultValue - Value returned by `handle.get()` when the flag is unknown
   *   or no environment override or rule applies.
   * @returns A {@link BooleanFlag} handle whose `get()` evaluates against the live cache.
   */
  async booleanFlag(id: string, defaultValue: boolean): Promise<BooleanFlag> {
    await this._ensureConnected();
    const handle = new BooleanFlag(this, {
      id,
      name: id,
      type: "BOOLEAN",
      default: defaultValue,
      values: null,
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._observeDeclaration(id, "BOOLEAN", defaultValue);
    return handle;
  }

  /**
   * Declare a string flag handle for live evaluation. Connects lazily on first use.
   *
   * @param id - Identifier of the flag to evaluate.
   * @param defaultValue - Value returned by `handle.get()` when the flag is unknown
   *   or no environment override or rule applies.
   * @returns A {@link StringFlag} handle whose `get()` evaluates against the live cache.
   */
  async stringFlag(id: string, defaultValue: string): Promise<StringFlag> {
    await this._ensureConnected();
    const handle = new StringFlag(this, {
      id,
      name: id,
      type: "STRING",
      default: defaultValue,
      values: null,
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._observeDeclaration(id, "STRING", defaultValue);
    return handle;
  }

  /**
   * Declare a numeric flag handle for live evaluation. Connects lazily on first use.
   *
   * @param id - Identifier of the flag to evaluate.
   * @param defaultValue - Value returned by `handle.get()` when the flag is unknown
   *   or no environment override or rule applies.
   * @returns A {@link NumberFlag} handle whose `get()` evaluates against the live cache.
   */
  async numberFlag(id: string, defaultValue: number): Promise<NumberFlag> {
    await this._ensureConnected();
    const handle = new NumberFlag(this, {
      id,
      name: id,
      type: "NUMERIC",
      default: defaultValue,
      values: null,
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._observeDeclaration(id, "NUMERIC", defaultValue);
    return handle;
  }

  /**
   * Declare a JSON flag handle for live evaluation. Connects lazily on first use.
   *
   * @param id - Identifier of the flag to evaluate.
   * @param defaultValue - Value returned by `handle.get()` when the flag is unknown
   *   or no environment override or rule applies.
   * @returns A {@link JsonFlag} handle whose `get()` evaluates against the live cache.
   */
  async jsonFlag(id: string, defaultValue: Record<string, any>): Promise<JsonFlag> {
    await this._ensureConnected();
    const handle = new JsonFlag(this, {
      id,
      name: id,
      type: "JSON",
      default: defaultValue,
      values: null,
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    this._handles[id] = handle;
    this._observeDeclaration(id, "JSON", defaultValue);
    return handle;
  }

  // ------------------------------------------------------------------
  // Live surface: context provider
  // ------------------------------------------------------------------

  /**
   * Register a context provider function.
   *
   * Called on every `handle.get()` to supply the current evaluation context.
   *
   * @param fn - Provider invoked on each evaluation; returns the list of
   *   {@link Context} entities to evaluate targeting rules against.
   */
  setContextProvider(fn: () => Context[]): void {
    this._contextProvider = fn;
  }

  /**
   * Register a context provider — decorator-style alias.
   *
   * @param fn - Provider invoked on each `handle.get()`; returns the list of
   *   {@link Context} entities to evaluate targeting rules against.
   * @returns The same provider `fn`, so it can be wrapped decorator-style.
   */
  contextProvider(fn: () => Context[]): () => Context[] {
    this._contextProvider = fn;
    return fn;
  }

  // ------------------------------------------------------------------
  // Live surface: refresh / stats / change listeners
  // ------------------------------------------------------------------

  /**
   * Re-fetch all flag definitions and clear cache.
   *
   * Connects lazily on first use — no explicit install step.
   *
   * @returns A promise that resolves once the definitions have been re-fetched.
   */
  async refresh(): Promise<void> {
    await this._ensureConnected();
    await this._doRefresh("manual");
  }

  /** @internal */
  private async _doRefresh(source: string): Promise<void> {
    await this._fetchAllFlags();
    this._cache.clear();
    this._fireChangeListenersAll(source);
  }

  /**
   * Return evaluation statistics. Connects lazily on first use.
   *
   * @returns The current {@link FlagStats} (cache hit / miss counts).
   */
  async stats(): Promise<FlagStats> {
    await this._ensureConnected();
    return new FlagStats({
      cacheHits: this._cache.cacheHits,
      cacheMisses: this._cache.cacheMisses,
    });
  }

  /**
   * Register a change listener.
   *
   * Supports two forms:
   *
   * - `onChange(callback)` — registers a global listener.
   * - `onChange(id, callback)` — registers an id-scoped listener.
   *
   * Connects lazily on first use — no explicit install step.
   *
   * @param callbackOrId - Either the listener callback (used directly as
   *   `onChange(callback)`) or a flag id string scoping the listener to that flag
   *   (used as `onChange(id, callback)`).
   * @param callback - The listener callback, required when `callbackOrId` is a flag
   *   id. Each listener receives a {@link FlagChangeEvent}.
   */
  async onChange(
    callbackOrId: string | ((event: FlagChangeEvent) => void),
    callback?: (event: FlagChangeEvent) => void,
  ): Promise<void> {
    await this._ensureConnected();
    if (typeof callbackOrId === "function") {
      this._globalListeners.push(callbackOrId);
      return;
    }
    const id = callbackOrId;
    if (!callback) {
      throw new SmplkitError("onChange(id, callback) requires a callback function.");
    }
    if (!this._keyListeners.has(id)) {
      this._keyListeners.set(id, []);
    }
    this._keyListeners.get(id)!.push(callback);
  }

  // ------------------------------------------------------------------
  // Internal: evaluation
  // ------------------------------------------------------------------

  /**
   * Core evaluation used by flag handles (the `.get()` path).
   *
   * Connects lazily on first use so `flag.get()` works without an explicit
   * install step.
   * @internal
   */
  _evaluateHandle(flagId: string, defaultValue: any, context: Context[] | null): any {
    let evalDict: Record<string, any>;
    if (context !== null) {
      // Explicit context: register here. (Implicit setContext registers at
      // the entry point, so the request-context branch below doesn't need to.)
      if (this._contexts !== null) {
        void this._contexts.register(context);
      }
      evalDict = contextsToEvalDict(context);
    } else {
      const requestContext = getRequestContext();
      if (requestContext.length > 0) {
        // Per-request context from client.setContext (most specific). Already
        // registered at the setContext call site, so don't re-register here.
        evalDict = contextsToEvalDict(requestContext);
      } else if (this._contextProvider !== null) {
        const contexts = this._contextProvider();
        evalDict = contextsToEvalDict(contexts);
        if (this._contexts !== null) {
          void this._contexts.register(contexts);
        }
      } else {
        evalDict = {};
      }
    }

    // Auto-inject service context if set and not already provided
    if (this._service && !("service" in evalDict)) {
      evalDict["service"] = { key: this._service };
    }

    const ctxHash = hashContext(evalDict);
    const cacheKey = `${flagId}:${ctxHash}`;

    const [hit, cachedValue] = this._cache.get(cacheKey);
    if (hit) {
      const metrics = this._metrics;
      if (metrics) {
        metrics.record("flags.cache_hits", 1, "hits");
        metrics.record("flags.evaluations", 1, "evaluations", { flag: flagId });
      }
      return cachedValue;
    }

    const flagDef = this._flagStore[flagId];
    if (flagDef === undefined) {
      this._cache.put(cacheKey, defaultValue);
      return defaultValue;
    }

    let value = evaluateFlag(flagDef, this._environment, evalDict);
    if (value === null || value === undefined) {
      value = defaultValue;
    }

    this._cache.put(cacheKey, value);
    const metrics = this._metrics;
    if (metrics) {
      metrics.record("flags.cache_misses", 1, "misses");
      metrics.record("flags.evaluations", 1, "evaluations", { flag: flagId });
    }
    return value;
  }

  // ------------------------------------------------------------------
  // Internal: event handlers (called by SharedWebSocket)
  // ------------------------------------------------------------------

  private _handleFlagChanged = (data: Record<string, any>): void => {
    debug("websocket", `flag_changed event received: ${JSON.stringify(data)}`);
    const key = data.id as string | undefined;
    if (!key) return;
    const pre = this._flagStore[key];
    const preJson = pre !== undefined ? JSON.stringify(pre) : null;
    void this._fetchFlagSingleData(key)
      .then((newData) => {
        if (newData === undefined) return;
        const newJson = JSON.stringify(newData);
        this._flagStore[key] = newData;
        this._cache.clear();
        if (preJson !== newJson) {
          this._fireChangeListeners(key, "websocket");
        }
      })
      .catch((err: unknown) => {
        debug(
          "websocket",
          `flag_changed handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  private _handleFlagDeleted = (data: Record<string, any>): void => {
    debug("websocket", `flag_deleted event received: ${JSON.stringify(data)}`);
    const key = data.id as string | undefined;
    if (!key) return;
    const existed = key in this._flagStore;
    delete this._flagStore[key];
    this._cache.clear();
    if (existed) {
      this._fireChangeListeners(key, "websocket", true);
    }
  };

  private _handleFlagsChanged = (_data: Record<string, any>): void => {
    debug("websocket", `flags_changed event received`);
    const preStore = { ...this._flagStore };
    void this._fetchAllFlags()
      .then(() => {
        this._cache.clear();
        const postStore = this._flagStore;
        const allKeys = new Set([...Object.keys(preStore), ...Object.keys(postStore)]);
        const changed: string[] = [];
        for (const key of allKeys) {
          const preJson = preStore[key] !== undefined ? JSON.stringify(preStore[key]) : null;
          const postJson = postStore[key] !== undefined ? JSON.stringify(postStore[key]) : null;
          if (preJson !== postJson) changed.push(key);
        }
        if (changed.length === 0) return;
        // Global listener fires once
        const firstEvent = new FlagChangeEvent({ id: changed[0], source: "websocket" });
        for (const cb of this._globalListeners) {
          try {
            cb(firstEvent);
          } catch {
            // ignore listener errors
          }
        }
        // Per-key listeners fire for each changed key
        for (const key of changed) {
          const deleted = key in preStore && !(key in postStore);
          const event = new FlagChangeEvent({ id: key, source: "websocket", deleted });
          const keyCallbacks = this._keyListeners.get(key);
          if (keyCallbacks) {
            for (const cb of keyCallbacks) {
              try {
                cb(event);
              } catch {
                // ignore listener errors
              }
            }
          }
        }
      })
      .catch((err: unknown) => {
        debug(
          "websocket",
          `flags_changed handler error: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  };

  // ------------------------------------------------------------------
  // Internal: flag store
  // ------------------------------------------------------------------

  /** Fetch a single flag by key and return a store-format dict. @internal */
  private async _fetchFlagSingleData(key: string): Promise<Record<string, any> | undefined> {
    try {
      const result = await this._http.GET("/api/v1/flags/{id}", {
        params: { path: { id: key } },
      });
      if (!result.response.ok) return undefined;
      if (!result.data?.data) return undefined;
      return storeEntry(result.data.data);
    } catch {
      return undefined;
    }
  }

  /** @internal */
  private async _fetchAllFlags(): Promise<void> {
    const flags = await this._fetchFlagsList();
    const store: Record<string, Record<string, any>> = {};
    for (const f of flags) store[f.id] = f;
    this._flagStore = store;
  }

  /** @internal */
  private async _fetchFlagsList(): Promise<Array<Record<string, any>>> {
    const PAGE_SIZE = 1000;
    const all: Array<Record<string, any>> = [];
    let page = 1;
    let lastPageWasFull = true;
    while (lastPageWasFull) {
      let data: components["schemas"]["FlagListResponse"] | undefined;
      try {
        const result = await this._http.GET("/api/v1/flags", {
          params: {
            query: { "page[number]": page, "page[size]": PAGE_SIZE } as unknown as Record<
              string,
              never
            >,
          },
        });
        if (!result.response.ok) await checkError(result.response, result.error);
        data = result.data;
      } catch (err) {
        wrapFetchError(err);
      }
      const rows = data?.data ?? [];
      for (const r of rows) all.push(storeEntry(r));
      lastPageWasFull = rows.length === PAGE_SIZE;
      page++;
    }
    return all;
  }

  // ------------------------------------------------------------------
  // Internal: change listeners
  // ------------------------------------------------------------------

  private _fireChangeListeners(flagId: string | null, source: string, deleted = false): void {
    if (flagId) {
      const event = new FlagChangeEvent({ id: flagId, source, deleted });
      for (const cb of this._globalListeners) {
        try {
          cb(event);
        } catch {
          // ignore listener errors
        }
      }
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
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Release resources — only those this client owns.
   *
   * Tears down the owned WebSocket (opened by a standalone client on first
   * live use). A wired client borrows the parent's transport, WebSocket, and
   * contexts client and closes none of them.
   */
  close(): void {
    if (this._ownsWs && this._wsManager !== null) {
      this._wsManager.stop();
      this._wsManager = null;
      this._ownsWs = false;
    }
  }
}
