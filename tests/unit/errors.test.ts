import { describe, expect, it } from "vitest";
import {
  SmplError,
  SmplConnectionError,
  SmplTimeoutError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
  throwForStatus,
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

describe("SmplError errors array", () => {
  it("should default errors to empty array", () => {
    const error = new SmplError("test");
    expect(error.errors).toEqual([]);
  });

  it("should store provided errors", () => {
    const apiErrors = [{ status: "400", detail: "bad request" }];
    const error = new SmplError("test", 400, "", apiErrors);
    expect(error.errors).toEqual(apiErrors);
  });

  it("should produce single-error toString output", () => {
    const apiErrors = [
      { status: "400", title: "Validation Error", detail: "The 'name' field is required.", source: { pointer: "/data/attributes/name" } },
    ];
    const error = new SmplValidationError("The 'name' field is required.", 400, "", apiErrors);
    const str = error.toString();
    expect(str).toContain("SmplValidationError: The 'name' field is required.");
    expect(str).toContain("Error: ");
    expect(str).toContain('"status":"400"');
    expect(str).toContain('"detail":"The \'name\' field is required."');
    expect(str).not.toContain("Errors:");
  });

  it("should produce multi-error toString output", () => {
    const apiErrors = [
      { status: "400", title: "Validation Error", detail: "The 'name' field is required.", source: { pointer: "/data/attributes/name" } },
      { status: "400", title: "Validation Error", detail: "The 'id' field is required.", source: { pointer: "/data/id" } },
    ];
    const error = new SmplValidationError("The 'name' field is required. (and 1 more error)", 400, "", apiErrors);
    const str = error.toString();
    expect(str).toContain("SmplValidationError:");
    expect(str).toContain("Errors:");
    expect(str).toContain("[0]");
    expect(str).toContain("[1]");
    expect(str).toContain('"detail":"The \'name\' field is required."');
    expect(str).toContain('"detail":"The \'id\' field is required."');
  });

  it("should produce plain toString when no errors", () => {
    const error = new SmplError("plain message");
    expect(error.toString()).toBe("SmplError: plain message");
  });
});

describe("throwForStatus", () => {
  it("should throw SmplValidationError with parsed details for single 400 error", () => {
    const body = JSON.stringify({
      errors: [
        {
          status: "400",
          title: "Validation Error",
          detail: "The 'name' field is required.",
          source: { pointer: "/data/attributes/name" },
        },
      ],
    });

    try {
      throwForStatus(400, body);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SmplValidationError);
      const e = error as SmplValidationError;
      expect(e.message).toBe("The 'name' field is required.");
      expect(e.statusCode).toBe(400);
      expect(e.errors).toHaveLength(1);
      expect(e.errors[0].detail).toBe("The 'name' field is required.");
      expect(e.errors[0].source).toEqual({ pointer: "/data/attributes/name" });
      const str = e.toString();
      expect(str).toContain("SmplValidationError:");
      expect(str).toContain('"status":"400"');
    }
  });

  it("should throw SmplValidationError with multi-error message for multiple 400 errors", () => {
    const body = JSON.stringify({
      errors: [
        {
          status: "400",
          title: "Validation Error",
          detail: "The 'name' field is required.",
          source: { pointer: "/data/attributes/name" },
        },
        {
          status: "400",
          title: "Validation Error",
          detail: "The 'id' field is required.",
          source: { pointer: "/data/id" },
        },
      ],
    });

    try {
      throwForStatus(400, body);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SmplValidationError);
      const e = error as SmplValidationError;
      expect(e.message).toContain("(and 1 more error)");
      expect(e.errors).toHaveLength(2);
      const str = e.toString();
      expect(str).toContain("[0]");
      expect(str).toContain("[1]");
    }
  });

  it("should throw SmplNotFoundError with server's detail for 404", () => {
    const body = JSON.stringify({
      errors: [
        {
          status: "404",
          title: "Not Found",
          detail: "Config 'abc' does not exist.",
        },
      ],
    });

    try {
      throwForStatus(404, body);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SmplNotFoundError);
      const e = error as SmplNotFoundError;
      expect(e.message).toBe("Config 'abc' does not exist.");
      expect(e.statusCode).toBe(404);
      expect(e.errors).toHaveLength(1);
    }
  });

  it("should throw SmplConflictError with server's detail for 409", () => {
    const body = JSON.stringify({
      errors: [
        {
          status: "409",
          title: "Conflict",
          detail: "Config has child configs.",
        },
      ],
    });

    try {
      throwForStatus(409, body);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SmplConflictError);
      const e = error as SmplConflictError;
      expect(e.message).toBe("Config has child configs.");
      expect(e.statusCode).toBe(409);
      expect(e.errors).toHaveLength(1);
    }
  });

  it("should throw SmplError with HTTP status in message for non-JSON 502 response", () => {
    const body = "Bad Gateway";

    try {
      throwForStatus(502, body);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SmplError);
      // Should NOT be a subclass
      expect(error).not.toBeInstanceOf(SmplValidationError);
      expect(error).not.toBeInstanceOf(SmplNotFoundError);
      expect(error).not.toBeInstanceOf(SmplConflictError);
      const e = error as SmplError;
      expect(e.message).toContain("502");
      expect(e.statusCode).toBe(502);
      expect(e.errors).toEqual([]);
    }
  });

  it("should throw SmplValidationError for 422 with JSON:API errors", () => {
    const body = JSON.stringify({
      errors: [
        {
          status: "422",
          title: "Unprocessable Entity",
          detail: "Value must be a string.",
        },
      ],
    });

    try {
      throwForStatus(422, body);
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SmplValidationError);
      const e = error as SmplValidationError;
      expect(e.message).toBe("Value must be a string.");
      expect(e.statusCode).toBe(422);
    }
  });

  it("should fall back to title when detail is absent", () => {
    const body = JSON.stringify({
      errors: [{ status: "400", title: "Bad Request" }],
    });

    try {
      throwForStatus(400, body);
      expect.fail("should have thrown");
    } catch (error) {
      const e = error as SmplValidationError;
      expect(e.message).toBe("Bad Request");
    }
  });

  it("should fall back to HTTP status when detail and title are absent", () => {
    const body = JSON.stringify({
      errors: [{ status: "400" }],
    });

    try {
      throwForStatus(400, body);
      expect.fail("should have thrown");
    } catch (error) {
      const e = error as SmplValidationError;
      expect(e.message).toBe("HTTP 400");
    }
  });

  it("should handle empty errors array as non-JSON body", () => {
    const body = JSON.stringify({ errors: [] });

    try {
      throwForStatus(500, body);
      expect.fail("should have thrown");
    } catch (error) {
      const e = error as SmplError;
      expect(e.message).toContain("HTTP 500");
    }
  });

  it("should pluralize 'errors' when more than 2 extra errors", () => {
    const body = JSON.stringify({
      errors: [
        { detail: "Error 1" },
        { detail: "Error 2" },
        { detail: "Error 3" },
      ],
    });

    try {
      throwForStatus(400, body);
      expect.fail("should have thrown");
    } catch (error) {
      const e = error as SmplValidationError;
      expect(e.message).toBe("Error 1 (and 2 more errors)");
    }
  });
});
