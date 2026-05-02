/**
 * Structured SDK error types.
 *
 * All smplkit errors extend {@link SmplkitError}, allowing callers to catch
 * the base class for generic handling or specific subclasses for
 * fine-grained control. The TypeScript SDK uses a "Smplkit" prefix to
 * disambiguate from JavaScript's built-in `Error`/`TypeError`/etc.; the
 * names line up 1:1 with Python's flat hierarchy (`Error`, `NotFoundError`,
 * `ConflictError`, `ConnectionError`, `TimeoutError`, `ValidationError`).
 */

/** A single error object from a JSON:API error response. */
export interface ApiErrorDetail {
  status?: string;
  title?: string;
  detail?: string;
  source?: Record<string, unknown>;
}

/** Base exception for all smplkit SDK errors. */
export class SmplkitError extends Error {
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
    this.name = "SmplkitError";
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
export class SmplkitConnectionError extends SmplkitError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode, responseBody, errors);
    this.name = "SmplkitConnectionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when an operation exceeds its timeout. */
export class SmplkitTimeoutError extends SmplkitError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode, responseBody, errors);
    this.name = "SmplkitTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a requested resource does not exist (HTTP 404). */
export class SmplkitNotFoundError extends SmplkitError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode ?? 404, responseBody, errors);
    this.name = "SmplkitNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when an operation conflicts with current state (HTTP 409). */
export class SmplkitConflictError extends SmplkitError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode ?? 409, responseBody, errors);
    this.name = "SmplkitConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when the server rejects a request due to validation errors (HTTP 400/422). */
export class SmplkitValidationError extends SmplkitError {
  constructor(
    message: string,
    statusCode?: number,
    responseBody?: string,
    errors?: ApiErrorDetail[],
  ) {
    super(message, statusCode ?? 422, responseBody, errors);
    this.name = "SmplkitValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

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

// ---------------------------------------------------------------------------
// Backwards-compat aliases — to be removed once all runtime callers migrate.
// @internal
// ---------------------------------------------------------------------------

/** @deprecated Use {@link SmplkitError}. */
export const SmplError = SmplkitError;
/** @deprecated Use {@link SmplkitConnectionError}. */
export const SmplConnectionError = SmplkitConnectionError;
/** @deprecated Use {@link SmplkitTimeoutError}. */
export const SmplTimeoutError = SmplkitTimeoutError;
/** @deprecated Use {@link SmplkitNotFoundError}. */
export const SmplNotFoundError = SmplkitNotFoundError;
/** @deprecated Use {@link SmplkitConflictError}. */
export const SmplConflictError = SmplkitConflictError;
/** @deprecated Use {@link SmplkitValidationError}. */
export const SmplValidationError = SmplkitValidationError;
/** @deprecated Use {@link ApiErrorDetail}. */
export type ApiErrorObject = ApiErrorDetail;

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
      throw new SmplkitValidationError(message, statusCode, body, errors);
    case 404:
      throw new SmplkitNotFoundError(message, statusCode, body, errors);
    case 409:
      throw new SmplkitConflictError(message, statusCode, body, errors);
    default:
      throw new SmplkitError(message, statusCode, body, errors);
  }
}
