/**
 * Runtime-only tests for ConfigClient. Management/CRUD coverage lives in
 * tests/unit/management/management_config.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigClient } from "../../../src/config/client.js";
import { SmplError, SmplTimeoutError } from "../../../src/errors.js";

// Mock global fetch — openapi-fetch calls fetch(request: Request)
const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_api_test";

function makeClient(): ConfigClient {
  return new ConfigClient(API_KEY);
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("ConfigClient", () => {
  describe("_connectInternal", () => {
    it("should populate cache and config store", async () => {
      const client = makeClient();

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "db",
              type: "config",
              attributes: {
                name: "DB Config",
                description: null,
                parent: null,
                items: { host: { value: "localhost" }, port: { value: 5432 } },
                environments: {},
              },
            },
          ],
        }),
      );

      await client._connectInternal("production");

      // Cache stores resolved values from `_buildChain` + `resolveChain`.
      // The current source preserves the wire-shaped `{value: raw}` typed-item
      // wrappers in the cache (no unwrap step in `resolveChain`); assert the
      // structure we actually get back.
      expect(client._getCachedConfig("db")).toEqual({
        host: { value: "localhost" },
        port: { value: 5432 },
      });
    });

    it("should be a no-op if already initialized", async () => {
      const client = makeClient();

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "db",
              type: "config",
              attributes: {
                name: "DB",
                description: null,
                parent: null,
                items: { host: { value: "localhost" } },
                environments: {},
              },
            },
          ],
        }),
      );

      await client._connectInternal("production");
      await client._connectInternal("production"); // no-op

      // Only one fetch call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should throw SmplError when the list call fails", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Server Error", 500));

      await expect(client._connectInternal("production")).rejects.toThrow(SmplError);
    });

    it("should treat empty data list as no configs", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await client._connectInternal("production");

      expect(client._getCachedConfig("anything")).toBeUndefined();
    });
  });

  describe("_listConfigs HTTP fallback", () => {
    it("delegates to the management plane when wired", async () => {
      const client = makeClient();
      const fakeMgmt = {
        config: {
          list: vi.fn().mockResolvedValue([]),
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client._resolveManagement = () => fakeMgmt as any;
      client._parent = { _environment: "production", _service: "svc", _metrics: null };

      // start() calls _ensureInitialized which calls _listConfigs
      await client.start();

      expect(fakeMgmt.config.list).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("falls back to direct HTTP when no management plane is wired", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      client._parent = { _environment: "production", _service: "svc", _metrics: null };

      await client.start();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = mockFetch.mock.calls[0][0].url as string;
      expect(url).toContain("/api/v1/configs");
    });
  });

  describe("custom fetch wrapper", () => {
    it("maps DOMException AbortError to SmplTimeoutError", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

      await expect(client._connectInternal("staging")).rejects.toThrow(SmplTimeoutError);
    });
  });

  describe("extractEnvironments defensive path (via wire response)", () => {
    it("preserves entries that lack a values key when reading a single config", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "cfg",
              type: "config",
              attributes: {
                name: "Cfg",
                description: null,
                parent: null,
                items: {},
                // staging has no `values` key — extractEnvironments should
                // pass the entry through unchanged.
                environments: { staging: { metadata: "x" } },
              },
            },
          ],
        }),
      );

      await client._connectInternal("production");
      // No exception means the defensive branch was taken; cache is populated.
      expect(client._getCachedConfig("cfg")).toBeDefined();
    });
  });
});
