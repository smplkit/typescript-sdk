/**
 * Public types for the Flags SDK: Op, Context, FlagDeclaration, Rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Operators supported by `Rule.when`.
 *
 * Customers should prefer `Op.EQ` etc. over raw strings so the IDE
 * can validate calls. Raw strings are still accepted for flexibility.
 */
export enum Op {
  EQ = "==",
  NEQ = "!=",
  LT = "<",
  LTE = "<=",
  GT = ">",
  GTE = ">=",
  IN = "in",
  CONTAINS = "contains",
}

const CONTEXT_FIELDS = new Set([
  "type",
  "key",
  "name",
  "attributes",
  "createdAt",
  "updatedAt",
  // internal
  "_client",
]);

/** @internal */
export interface ContextClient {
  _saveContext(ctx: Context): Promise<Context>;
  delete(id: string): Promise<void>;
}

/**
 * A typed evaluation-context entity.
 *
 * Represents a single entity (user, account, device, etc.). The *type*
 * and *key* identify the entity; *attributes* carry the data that
 * targeting rules evaluate against.
 *
 * Used for both authoring (`flag.get({ context: [...] })`,
 * `client.setContext([...])`, `mgmt.contexts.register([...])`) and
 * reading (`mgmt.contexts.list/get` return populated `Context`
 * instances with `save()` / `delete()` ready to call).
 *
 * Validation happens at construction:
 * - `type` and `key` must be strings (numeric IDs rejected — stringify
 *   them at the SDK boundary).
 * - Unknown property assignment via dotted notation is blocked. Use
 *   `ctx.attributes["plan"] = ...` instead.
 * - Once persisted (`createdAt` is set), `type` and `key` become
 *   immutable.
 *
 * @example
 * ```typescript
 * new Context("user", "user-123", { plan: "enterprise" });
 * new Context("account", "acme", { region: "us" }, { name: "Acme" });
 * ```
 */
export class Context {
  type!: string;
  key!: string;
  name: string | null;
  attributes: Record<string, unknown>;
  createdAt!: string | null;
  updatedAt: string | null;

  /** @internal */
  _client: ContextClient | null;

  constructor(
    type: string,
    key: string,
    attributes?: Record<string, unknown>,
    options?: {
      name?: string;
      createdAt?: string | null;
      updatedAt?: string | null;
    },
  ) {
    if (typeof type !== "string") {
      const got = type === null ? "null" : typeof type;
      throw new TypeError(`Context type must be a string, got ${got}: ${JSON.stringify(type)}`);
    }
    if (typeof key !== "string") {
      const got = key === null ? "null" : typeof key;
      throw new TypeError(
        `Context key must be a string, got ${got}: ${JSON.stringify(key)}. ` +
          "If your identifier is numeric, stringify it at the SDK boundary.",
      );
    }
    // Use defineProperty to install a setter that blocks unknown attribute
    // assignment + locks identity once persisted.
    let _type = type;
    let _key = key;
    let _createdAt: string | null = options?.createdAt ?? null;

    Object.defineProperty(this, "type", {
      get: () => _type,
      set: (v: unknown) => {
        if (_createdAt !== null) {
          throw new Error(
            "Cannot reassign 'type' on a persisted Context (identity is fixed after save). " +
              "Delete and create a new Context if you need a different (type, key).",
          );
        }
        _type = v as string;
      },
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(this, "key", {
      get: () => _key,
      set: (v: unknown) => {
        if (_createdAt !== null) {
          throw new Error(
            "Cannot reassign 'key' on a persisted Context (identity is fixed after save). " +
              "Delete and create a new Context if you need a different (type, key).",
          );
        }
        _key = v as string;
      },
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(this, "createdAt", {
      get: () => _createdAt,
      set: (v: string | null) => {
        _createdAt = v;
      },
      enumerable: true,
      configurable: false,
    });

    this.name = options?.name ?? null;
    this.attributes = { ...(attributes ?? {}) };
    this.updatedAt = options?.updatedAt ?? null;
    this._client = null;

    // Block dotted assignment of unknown fields — silently mis-routes
    // what customers usually mean to put in `attributes`.
    return new Proxy(this, {
      set(target, prop, value): boolean {
        if (typeof prop === "string" && !CONTEXT_FIELDS.has(prop)) {
          throw new Error(
            `Cannot set unknown attribute ${JSON.stringify(prop)} on Context. ` +
              `To add a context attribute use ctx.attributes[${JSON.stringify(prop)}] = ...; ` +
              "to bulk-replace, set ctx.attributes = {...}.",
          );
        }
        (target as any)[prop] = value;
        return true;
      },
    });
  }

  /** Composite `"{type}:{key}"` identifier. */
  get id(): string {
    return `${this.type}:${this.key}`;
  }

  /** Persist this context to the server (create or update). */
  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("Context was constructed without a client; cannot save");
    }
    const updated = await this._client._saveContext(this);
    this._apply(updated);
  }

  /** Delete this context from the server. */
  async delete(): Promise<void> {
    if (this._client === null) {
      throw new Error("Context was constructed without a client; cannot delete");
    }
    await this._client.delete(this.id);
  }

  /** @internal */
  _apply(other: Context): void {
    // Bypass setter guard on identity fields by going through Object.defineProperty refresh.
    const proto = Object.getOwnPropertyDescriptor(this, "type");
    if (proto && proto.set) {
      // Temporarily clear createdAt to bypass the persisted-identity guard
      // for the legitimate post-save copy of fields from the server.
      this.createdAt = null;
      this.type = other.type;
      this.key = other.key;
    }
    this.name = other.name;
    this.attributes = { ...other.attributes };
    this.createdAt = other.createdAt;
    this.updatedAt = other.updatedAt;
  }

  toString(): string {
    return `Context(type=${this.type}, key=${this.key}, name=${this.name})`;
  }
}

/**
 * Describes a flag declaration for buffered registration.
 *
 * Used by `mgmt.flags.register` to queue declarations for bulk
 * registration. `service` and `environment` default to `null`; the
 * runtime client fills them from the active `SmplClient` when it
 * forwards declarations.
 */
export class FlagDeclaration {
  readonly id: string;
  readonly type: string;
  readonly default: unknown;
  readonly service: string | null;
  readonly environment: string | null;

  constructor(fields: {
    id: string;
    type: string;
    default: unknown;
    service?: string | null;
    environment?: string | null;
  }) {
    this.id = fields.id;
    this.type = fields.type;
    this.default = fields.default;
    this.service = fields.service ?? null;
    this.environment = fields.environment ?? null;
    Object.freeze(this);
  }
}

/**
 * Fluent builder for flag targeting rules.
 *
 * @example
 * ```typescript
 * new Rule("Enable for enterprise users", { environment: "staging" })
 *   .when("user.plan", Op.EQ, "enterprise")
 *   .when("account.region", Op.EQ, "us")
 *   .serve(true);
 * ```
 *
 * Multiple `.when()` calls are AND'd. `environment` is required so the
 * target environment is unambiguous when the rule is passed to
 * `Flag.addRule`. `.serve()` finalizes the rule and returns a built
 * dict ready to pass to `addRule`.
 */
export class Rule {
  private readonly _description: string;
  private readonly _conditions: Array<Record<string, any>> = [];
  private readonly _environment: string;

  constructor(description: string, options: { environment: string }) {
    this._description = description;
    if (typeof options?.environment !== "string") {
      throw new TypeError(
        "Rule requires an 'environment' option, e.g. new Rule('desc', { environment: 'staging' })",
      );
    }
    this._environment = options.environment;
  }

  /**
   * Add a condition. Multiple calls are AND'd at the top level.
   *
   * Two forms:
   * - `when(var, op, value)` — convenience for simple comparisons.
   * - `when(expr)` — escape hatch accepting an arbitrary JSON Logic
   *   expression (use this for OR, nested AND/OR, `if`, etc.).
   */
  when(expr: Record<string, any>): Rule;
  when(variable: string, op: Op | string, value: any): Rule;
  when(...args: any[]): Rule {
    if (args.length === 1 && typeof args[0] === "object" && args[0] !== null) {
      this._conditions.push(args[0] as Record<string, any>);
      return this;
    }
    if (args.length === 3) {
      const [variable, op, value] = args;
      const opStr = String(op);
      if (opStr === "contains") {
        this._conditions.push({ in: [value, { var: variable }] });
      } else {
        this._conditions.push({ [opStr]: [{ var: variable }, value] });
      }
      return this;
    }
    throw new TypeError(
      `Rule.when() takes either (var, op, value) or a single JSON Logic dict; got ${args.length} args`,
    );
  }

  /** Finalize the rule with `value` served on match and return the built dict. */
  serve(value: any): Record<string, any> {
    let logic: Record<string, any>;
    if (this._conditions.length === 1) {
      logic = this._conditions[0];
    } else if (this._conditions.length > 1) {
      logic = { and: this._conditions };
    } else {
      logic = {};
    }
    return {
      description: this._description,
      logic,
      value,
      environment: this._environment,
    };
  }
}
