/**
 * Management sub-client: `mgmt.flags.*` — CRUD on Flag resources.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import createClient from "openapi-fetch";
import type { components } from "../generated/flags.d.ts";
import {
  SmplkitError,
  SmplkitConflictError,
  SmplkitConnectionError,
  SmplkitNotFoundError,
  SmplkitValidationError,
  throwForStatus,
} from "../errors.js";
import {
  Flag,
  BooleanFlag,
  StringFlag,
  NumberFlag,
  JsonFlag,
  FlagValue,
  FlagRule,
  FlagEnvironment,
} from "../flags/models.js";
import type { Context } from "../flags/types.js";
import { FlagDeclaration } from "../flags/types.js";
import { keyToDisplayName } from "../helpers.js";

type FlagsHttp = ReturnType<typeof createClient<import("../generated/flags.d.ts").paths>>;

const FLAG_REGISTRATION_FLUSH_SIZE = 50;

/** @internal */
async function checkError(response: Response): Promise<never> {
  const body = await response.text().catch(() => "");
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

/** @internal */
function flagToBody(flag: Flag): { data: { id: string | null; type: "flag"; attributes: any } } {
  return {
    data: {
      id: flag.id,
      type: "flag",
      attributes: {
        name: flag.name,
        description: flag.description ?? "",
        type: flag.type,
        default: flag.default,
        values: flag.values?.map((v) => ({ name: v.name, value: v.value })),
        ...(Object.keys(flag.environments).length > 0
          ? { environments: environmentsToWire(flag._envsRaw()) }
          : {}),
      },
    },
  };
}

/** @internal */
function resourceToFlag(
  resource: components["schemas"]["FlagResource"],
  client: ManagementFlagsClient,
): Flag {
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

/** @internal */
function _flagSubclassFor(
  type: string,
  client: ManagementFlagsClient,
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

/**
 * Buffer pending flag declarations for bulk registration. @internal
 */
export class FlagRegistrationBuffer {
  private _seen = new Set<string>();
  private _pending: Array<components["schemas"]["FlagBulkItem"]> = [];

  add(decl: FlagDeclaration): void {
    if (this._seen.has(decl.id)) return;
    this._seen.add(decl.id);
    this._pending.push({
      id: decl.id,
      type: decl.type,
      default: decl.default,
      service: decl.service ?? undefined,
      environment: decl.environment ?? undefined,
    } as components["schemas"]["FlagBulkItem"]);
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

/**
 * `mgmt.flags.*` — CRUD client for flags + bulk registration buffer.
 */
export class ManagementFlagsClient {
  /** @internal */
  readonly _buffer = new FlagRegistrationBuffer();

  /** @internal */
  constructor(private readonly _http: FlagsHttp) {}

  /** Construct an unsaved {@link BooleanFlag}. Call `.save()` to persist. */
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

  /** Construct an unsaved {@link StringFlag}. Call `.save()` to persist. */
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

  /** Construct an unsaved {@link NumberFlag}. Call `.save()` to persist. */
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

  /** Construct an unsaved {@link JsonFlag}. Call `.save()` to persist. */
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

  /** Fetch a flag by id. */
  async get(id: string): Promise<Flag> {
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitNotFoundError(`Flag with id ${JSON.stringify(id)} not found`);
    }
    return resourceToFlag(data.data, this);
  }

  /** List all flags. */
  async list(): Promise<Flag[]> {
    let data: components["schemas"]["FlagListResponse"] | undefined;
    try {
      const result = await this._http.GET("/api/v1/flags", {});
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data) return [];
    return data.data.map((r) => resourceToFlag(r, this));
  }

  /** Delete a flag by id. */
  async delete(id: string): Promise<void> {
    return this._deleteFlag(id);
  }

  /** @internal — called by `Flag.delete()`. */
  async _deleteFlag(id: string): Promise<void> {
    try {
      const result = await this._http.DELETE("/api/v1/flags/{id}", {
        params: { path: { id } },
      });
      if (!result.response.ok && result.response.status !== 204) {
        await checkError(result.response);
        /* v8 ignore next — checkError is `Promise<never>` so the closing brace is unreachable */
      }
    } catch (err) {
      wrapFetchError(err);
    }
  }

  /**
   * Queue flag declaration(s) for bulk registration; optionally flush.
   *
   * Threshold-based flushing fires when 50+ pending; the periodic
   * timer on {@link SmplClient} also drains it every 60s.
   */
  async register(
    items: FlagDeclaration | FlagDeclaration[],
    options: { flush?: boolean } = {},
  ): Promise<void> {
    const arr = Array.isArray(items) ? items : [items];
    for (const decl of arr) this._buffer.add(decl);
    if (options.flush) {
      await this.flush();
      return;
    }
    if (this._buffer.pendingCount >= FLAG_REGISTRATION_FLUSH_SIZE) {
      void this.flush();
    }
  }

  /** Send any pending flag declarations to the server. */
  async flush(): Promise<void> {
    const batch = this._buffer.drain();
    if (batch.length === 0) return;
    try {
      await this._http.POST("/api/v1/flags/bulk", { body: { flags: batch } });
    } catch {
      // Re-queue on failure? For now: same behavior as Python — log and move on.
    }
  }

  /** Number of declarations awaiting flush. */
  get pendingCount(): number {
    return this._buffer.pendingCount;
  }

  /** @internal — called by `Flag.save()` for new resources. */
  async _createFlag(flag: Flag): Promise<Flag> {
    const body = flagToBody(flag);
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.POST("/api/v1/flags", { body });
      if (!result.response.ok) await checkError(result.response);
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
    const body = flagToBody(flag);
    let data: components["schemas"]["FlagResponse"] | undefined;
    try {
      const result = await this._http.PUT("/api/v1/flags/{id}", {
        params: { path: { id: flag.id } },
        body,
      });
      if (!result.response.ok) await checkError(result.response);
      data = result.data;
    } catch (err) {
      wrapFetchError(err);
    }
    if (!data || !data.data) {
      throw new SmplkitValidationError(`Failed to update flag ${flag.id}`);
    }
    return resourceToFlag(data.data, this);
  }

  /** @internal — flag models constructed via `mgmt.flags.*` cannot evaluate. */
  _evaluateHandle(_id: string, _defaultValue: unknown, _context: Context[] | null): unknown {
    throw new Error(
      "Flag models constructed via mgmt.flags.* cannot be evaluated. " +
        "Use client.flags.booleanFlag(...) etc. on a runtime SmplClient instead.",
    );
  }
}

/** @internal */
function _coerceValues(
  values?: Array<FlagValue | { name: string; value: unknown }>,
): FlagValue[] | null {
  if (values === undefined) return null;
  return values.map((v) => (v instanceof FlagValue ? v : new FlagValue(v)));
}
