/**
 * Public types for the Flags SDK: Context, Rule.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A typed evaluation context entity.
 *
 * Represents a single entity (user, account, device, etc.) in the
 * evaluation context.  The *type* and *key* identify the entity;
 * *attributes* carry the data that JSON Logic rules target.
 *
 * @example
 * ```typescript
 * new Context("user", "user-123", { plan: "enterprise", firstName: "Alice" })
 * new Context("user", "user-123", { plan: "enterprise" }, { name: "Alice Smith" })
 * ```
 */
export class Context {
  readonly type: string;
  readonly key: string;
  readonly name: string | null;
  readonly attributes: Record<string, unknown>;

  constructor(
    type: string,
    key: string,
    attributes?: Record<string, unknown>,
    options?: { name?: string },
  ) {
    this.type = type;
    this.key = key;
    this.name = options?.name ?? null;
    this.attributes = { ...(attributes ?? {}) };
  }

  toString(): string {
    return `Context(type=${this.type}, key=${this.key}, name=${this.name})`;
  }
}

/**
 * Fluent builder for flag targeting rules.
 *
 * @example
 * ```typescript
 * new Rule("Enable for enterprise users")
 *     .when("user.plan", "==", "enterprise")
 *     .when("account.region", "==", "us")
 *     .serve(true)
 *     .build()
 * ```
 *
 * Multiple `.when()` calls are combined with AND logic.
 */
export class Rule {
  private _description: string;
  private _conditions: Record<string, any>[] = [];
  private _value: any = null;
  private _environment: string | null = null;

  constructor(description: string) {
    this._description = description;
  }

  /** Tag this rule with an environment key (used by `addRule`). */
  environment(envKey: string): Rule {
    this._environment = envKey;
    return this;
  }

  /** Add a condition.  Multiple calls are AND'd. */
  when(variable: string, op: string, value: any): Rule {
    if (op === "contains") {
      // JSON Logic "in" with reversed operands: value in var
      this._conditions.push({ in: [value, { var: variable }] });
    } else {
      this._conditions.push({ [op]: [{ var: variable }, value] });
    }
    return this;
  }

  /** Set the value returned when this rule matches. */
  serve(value: any): Rule {
    this._value = value;
    return this;
  }

  /** Finalize and return the rule as a plain object. */
  build(): Record<string, any> {
    let logic: Record<string, any>;
    if (this._conditions.length === 1) {
      logic = this._conditions[0];
    } else if (this._conditions.length > 1) {
      logic = { and: this._conditions };
    } else {
      logic = {};
    }

    const result: Record<string, any> = {
      description: this._description,
      logic,
      value: this._value,
    };

    if (this._environment !== null) {
      result.environment = this._environment;
    }

    return result;
  }
}
