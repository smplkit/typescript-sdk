/**
 * Structured SDK error types.
 *
 * All smplkit errors extend {@link SmplError}. The TypeScript SDK keeps
 * the `Smpl` prefix on its public error names because TypeScript's
 * built-in `Error`/`TypeError`/etc. preclude bare names. The Python
 * canonical names (`Error`, `NotFoundError`, ...) line up via
 * `Smpl{X}Error` ↔ Python `{X}Error`. The `Smplkit{X}Error` names are
 * exported as aliases (introduced in PR #103) for callers that prefer
 * the longer prefix.
 */

/** A single error object from a JSON:API error response. */
export interface ApiErrorDetail {
  status?: string;
  title?: string;
  detail?: string;
  source?: Record<string, unknown>;
}

/** Base exception for all smplkit SDK errors. */
export class SmplError extends Error {
  /** The HTTP status code, if the error originated from an HTTP response. */
  public readonly statusCode?: number;

  /** The raw response body, if available. */
  public readonly responseBody?: string;

  /** Structured JSON:API error objects from the server response, if available. */
  public readonly errors: ReadonlyArray<ApiErrorDetail>;

  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = "SmplError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    this.errors = errors ?? [];
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toString(): string {
    if (this.errors.length === 0) {
      return `${this.name}: ${this.message}`;
    }
    if (this.errors.length === 1) {
      return `${this.name}: ${this.message}\nError: ${JSON.stringify(this.errors[0])}`;
    }
    const lines = this.errors.map((e, i) => `  [${i}] ${JSON.stringify(e)}`);
    return `${this.name}: ${this.message}\nErrors:\n${lines.join("\n")}`;
  }
}

/** Raised when a network request fails (e.g., DNS resolution, connection refused). */
export class SmplConnectionError extends SmplError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode, responseBody, errors);
    this.name = "SmplConnectionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when an operation exceeds its timeout. */
export class SmplTimeoutError extends SmplError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode, responseBody, errors);
    this.name = "SmplTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a requested resource does not exist (HTTP 404). */
export class SmplNotFoundError extends SmplError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode ?? 404, responseBody, errors);
    this.name = "SmplNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when an operation conflicts with current state (HTTP 409). */
export class SmplConflictError extends SmplError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode ?? 409, responseBody, errors);
    this.name = "SmplConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when the server rejects a request due to validation errors (HTTP 400/422). */
export class SmplValidationError extends SmplError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode ?? 422, responseBody, errors);
    this.name = "SmplValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// `Smplkit*` aliases — added in PR #103 for callers that prefer the
// longer prefix (matches the package name `@smplkit/sdk`). They are
// the same classes; `Smpl*` remains the canonical export.
// ---------------------------------------------------------------------------

export { SmplError as SmplkitError };
export { SmplConnectionError as SmplkitConnectionError };
export { SmplTimeoutError as SmplkitTimeoutError };
export { SmplNotFoundError as SmplkitNotFoundError };
export { SmplConflictError as SmplkitConflictError };
export { SmplValidationError as SmplkitValidationError };

/** @deprecated Use {@link ApiErrorDetail}. */
export type ApiErrorObject = ApiErrorDetail;

// ---------------------------------------------------------------------------
// Shared helper: parse JSON:API error body and throw the right exception
// ---------------------------------------------------------------------------

/**
 * Parse a JSON:API error response body into structured error objects.
 * @internal
 */
function parseJsonApiErrors(body: string): ApiErrorDetail[] {
  try {
    const parsed = JSON.parse(body);
    if (parsed && Array.isArray(parsed.errors)) {
      return parsed.errors.map((e: Record<string, unknown>) => ({
        ...(e.status !== undefined ? { status: String(e.status) } : {}),
        ...(e.title !== undefined ? { title: String(e.title) } : {}),
        ...(e.detail !== undefined ? { detail: String(e.detail) } : {}),
        ...(e.source !== undefined && typeof e.source === "object" && e.source !== null
          ? { source: e.source as Record<string, unknown> }
          : {}),
      }));
    }
  } catch {
    // Not JSON — return empty
  }
  return [];
}

/**
 * Derive a human-readable message from parsed JSON:API error objects.
 * Falls back to `HTTP {statusCode}` when no detail/title/status is available.
 * @internal
 */
function deriveMessage(errors: ApiErrorDetail[], statusCode: number, body?: string): string {
  if (errors.length === 0) {
    return body ? `HTTP ${statusCode}: ${body}` : `HTTP ${statusCode}`;
  }
  const first = errors[0];
  const base =
    first.detail ?? first.title ?? (first.status ? `HTTP ${first.status}` : `HTTP ${statusCode}`);
  if (errors.length > 1) {
    return `${base} (and ${errors.length - 1} more error${errors.length - 1 > 1 ? "s" : ""})`;
  }
  return base;
}

/**
 * Parse an HTTP error response and throw the appropriate typed SDK exception.
 *
 * @internal
 */
export function throwForStatus(statusCode: number, body: string): never {
  const errors = parseJsonApiErrors(body);
  const message = deriveMessage(errors, statusCode, body);

  switch (statusCode) {
    case 400:
    case 422:
      throw new SmplValidationError(message, statusCode, body, errors);
    case 404:
      throw new SmplNotFoundError(message, statusCode, body, errors);
    case 409:
      throw new SmplConflictError(message, statusCode, body, errors);
    default:
      throw new SmplError(message, statusCode, body, errors);
  }
}
