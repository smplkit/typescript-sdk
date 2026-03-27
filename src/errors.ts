/**
 * Structured SDK error types.
 *
 * All smplkit errors extend {@link SmplError}, allowing callers to catch
 * the base class for generic handling or specific subclasses for
 * fine-grained control.
 */

/** Base exception for all smplkit SDK errors. */
export class SmplError extends Error {
  /** The HTTP status code, if the error originated from an HTTP response. */
  public readonly statusCode?: number;

  /** The raw response body, if available. */
  public readonly responseBody?: string;

  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = "SmplError";
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a network request fails (e.g., DNS resolution, connection refused). */
export class SmplConnectionError extends SmplError {
  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message, statusCode, responseBody);
    this.name = "SmplConnectionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when an operation exceeds its timeout. */
export class SmplTimeoutError extends SmplError {
  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message, statusCode, responseBody);
    this.name = "SmplTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when a requested resource does not exist (HTTP 404). */
export class SmplNotFoundError extends SmplError {
  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message, statusCode ?? 404, responseBody);
    this.name = "SmplNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when an operation conflicts with current state (HTTP 409). */
export class SmplConflictError extends SmplError {
  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message, statusCode ?? 409, responseBody);
    this.name = "SmplConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Raised when the server rejects a request due to validation errors (HTTP 422). */
export class SmplValidationError extends SmplError {
  constructor(message: string, statusCode?: number, responseBody?: string) {
    super(message, statusCode ?? 422, responseBody);
    this.name = "SmplValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
