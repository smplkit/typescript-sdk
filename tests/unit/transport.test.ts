import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transport } from "../../src/transport.js";
import {
  SmplConnectionError,
  SmplConflictError,
  SmplError,
  SmplNotFoundError,
  SmplTimeoutError,
  SmplValidationError,
} from "../../src/errors.js";

// Mock global fetch
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("Transport", () => {
  const transport = new Transport({
    apiKey: "sk_api_test",
  });

  describe("get", () => {
    it("should send a GET request with auth headers", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await transport.get("https://config.smplkit.com/api/v1/configs");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://config.smplkit.com/api/v1/configs");
      expect(options.method).toBe("GET");
      expect(options.headers.Authorization).toBe("Bearer sk_api_test");
      expect(options.headers["User-Agent"]).toMatch(/smplkit-typescript-sdk/);
    });

    it("should append query parameters", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await transport.get("https://config.smplkit.com/api/v1/configs", { "filter[key]": "common" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("filter%5Bkey%5D=common");
    });

    it("should parse JSON response", async () => {
      const body = { data: { id: "abc", type: "config", attributes: {} } };
      mockFetch.mockResolvedValueOnce(jsonResponse(body));

      const result = await transport.get("https://config.smplkit.com/api/v1/configs/abc");
      expect(result).toEqual(body);
    });
  });

  describe("post", () => {
    it("should send a POST request with JSON body", async () => {
      const requestBody = { data: { type: "config", attributes: { name: "test" } } };
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: { id: "new-id", type: "config", attributes: { name: "test" } } }),
      );

      await transport.post("https://config.smplkit.com/api/v1/configs", requestBody);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/vnd.api+json");
      expect(JSON.parse(options.body)).toEqual(requestBody);
    });
  });

  describe("put", () => {
    it("should send a PUT request with JSON body", async () => {
      const requestBody = { data: { type: "config", attributes: { name: "updated" } } };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: "abc", type: "config" } }));

      await transport.put("https://config.smplkit.com/api/v1/configs/abc", requestBody);

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe("PUT");
    });
  });

  describe("delete", () => {
    it("should send a DELETE request", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await transport.delete("https://config.smplkit.com/api/v1/configs/abc");

      const [, options] = mockFetch.mock.calls[0];
      expect(options.method).toBe("DELETE");
      expect(result).toEqual({});
    });
  });

  describe("error mapping", () => {
    it("should throw SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      await expect(
        transport.get("https://config.smplkit.com/api/v1/configs/missing"),
      ).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConflictError on 409", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Conflict", 409));

      await expect(
        transport.delete("https://config.smplkit.com/api/v1/configs/has-children"),
      ).rejects.toThrow(SmplConflictError);
    });

    it("should throw SmplValidationError on 422", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Validation failed", 422));

      await expect(
        transport.post("https://config.smplkit.com/api/v1/configs", {
          data: { type: "config", attributes: {} },
        }),
      ).rejects.toThrow(SmplValidationError);
    });

    it("should throw SmplError on other 4xx/5xx", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Internal Server Error", 500));

      await expect(transport.get("https://config.smplkit.com/api/v1/configs")).rejects.toThrow(
        SmplError,
      );
    });

    it("should include status code and body in error", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not Found", 404));

      try {
        await transport.get("https://config.smplkit.com/api/v1/configs/missing");
        expect.fail("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(SmplNotFoundError);
        const smplError = error as SmplNotFoundError;
        expect(smplError.statusCode).toBe(404);
        expect(smplError.responseBody).toBe("Not Found");
      }
    });

    it("should throw SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("fetch failed"));

      await expect(transport.get("https://config.smplkit.com/api/v1/configs")).rejects.toThrow(
        SmplConnectionError,
      );
    });

    it("should throw SmplTimeoutError on abort", async () => {
      mockFetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

      await expect(transport.get("https://config.smplkit.com/api/v1/configs")).rejects.toThrow(
        SmplTimeoutError,
      );
    });

    it("should throw SmplConnectionError on unknown errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("unexpected"));

      await expect(transport.get("https://config.smplkit.com/api/v1/configs")).rejects.toThrow(
        SmplConnectionError,
      );
    });

    it("should throw SmplConnectionError with String(error) when thrown value is not an Error", async () => {
      mockFetch.mockRejectedValueOnce("plain string error");

      await expect(transport.get("https://config.smplkit.com/api/v1/configs")).rejects.toThrow(
        SmplConnectionError,
      );
    });

    it("should throw SmplError on invalid JSON response", async () => {
      mockFetch.mockResolvedValueOnce(new Response("not json", { status: 200 }));

      await expect(transport.get("https://config.smplkit.com/api/v1/configs")).rejects.toThrow(
        SmplError,
      );
    });
  });
});
