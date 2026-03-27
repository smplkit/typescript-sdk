import { describe, expect, it } from "vitest";
import {
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
} from "../../src/errors.js";

describe("SmplError", () => {
  it("should have the correct name", () => {
    const error = new SmplError("test");
    expect(error.name).toBe("SmplError");
  });

  it("should store the message", () => {
    const error = new SmplError("something went wrong");
    expect(error.message).toBe("something went wrong");
  });

  it("should store statusCode and responseBody", () => {
    const error = new SmplError("fail", 500, '{"error":"internal"}');
    expect(error.statusCode).toBe(500);
    expect(error.responseBody).toBe('{"error":"internal"}');
  });

  it("should default statusCode and responseBody to undefined", () => {
    const error = new SmplError("fail");
    expect(error.statusCode).toBeUndefined();
    expect(error.responseBody).toBeUndefined();
  });

  it("should be an instance of Error", () => {
    const error = new SmplError("test");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SmplError);
  });
});

describe("SmplConnectionError", () => {
  it("should extend SmplError", () => {
    const error = new SmplConnectionError("connection refused");
    expect(error).toBeInstanceOf(SmplError);
    expect(error).toBeInstanceOf(SmplConnectionError);
    expect(error).toBeInstanceOf(Error);
  });

  it("should have the correct name", () => {
    const error = new SmplConnectionError("fail");
    expect(error.name).toBe("SmplConnectionError");
  });
});

describe("SmplTimeoutError", () => {
  it("should extend SmplError", () => {
    const error = new SmplTimeoutError("timed out");
    expect(error).toBeInstanceOf(SmplError);
    expect(error).toBeInstanceOf(SmplTimeoutError);
  });

  it("should have the correct name", () => {
    const error = new SmplTimeoutError("fail");
    expect(error.name).toBe("SmplTimeoutError");
  });
});

describe("SmplNotFoundError", () => {
  it("should extend SmplError", () => {
    const error = new SmplNotFoundError("not found");
    expect(error).toBeInstanceOf(SmplError);
    expect(error).toBeInstanceOf(SmplNotFoundError);
  });

  it("should default statusCode to 404", () => {
    const error = new SmplNotFoundError("not found");
    expect(error.statusCode).toBe(404);
  });

  it("should have the correct name", () => {
    const error = new SmplNotFoundError("fail");
    expect(error.name).toBe("SmplNotFoundError");
  });
});

describe("SmplConflictError", () => {
  it("should extend SmplError", () => {
    const error = new SmplConflictError("conflict");
    expect(error).toBeInstanceOf(SmplError);
    expect(error).toBeInstanceOf(SmplConflictError);
  });

  it("should default statusCode to 409", () => {
    const error = new SmplConflictError("conflict");
    expect(error.statusCode).toBe(409);
  });

  it("should have the correct name", () => {
    const error = new SmplConflictError("fail");
    expect(error.name).toBe("SmplConflictError");
  });
});

describe("SmplValidationError", () => {
  it("should extend SmplError", () => {
    const error = new SmplValidationError("invalid");
    expect(error).toBeInstanceOf(SmplError);
    expect(error).toBeInstanceOf(SmplValidationError);
  });

  it("should default statusCode to 422", () => {
    const error = new SmplValidationError("invalid");
    expect(error.statusCode).toBe(422);
  });

  it("should have the correct name", () => {
    const error = new SmplValidationError("fail");
    expect(error.name).toBe("SmplValidationError");
  });
});
