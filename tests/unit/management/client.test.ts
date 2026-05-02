import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmplManagementClient } from "../../../src/management/client.js";
import { Environment, ContextType, AccountSettings } from "../../../src/management/models.js";
import { EnvironmentClassification } from "../../../src/management/types.js";
import { Context } from "../../../src/flags/types.js";
import {
  SmplNotFoundError,
  SmplConnectionError,
  SmplValidationError,
} from "../../../src/errors.js";

// ---------------------------------------------------------------------------
// Shared fetch mock
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const API_KEY = "sk_test";

function makeClient(): SmplManagementClient {
  return new SmplManagementClient({
    apiKey: API_KEY,
    baseDomain: "test",
    scheme: "http",
  });
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

// ---------------------------------------------------------------------------
// Sample resources
// ---------------------------------------------------------------------------

const SAMPLE_ENV = {
  id: "production",
  type: "environment",
  attributes: {
    name: "Production",
    color: "#ff0000",
    classification: "STANDARD",
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

const SAMPLE_AD_HOC_ENV = {
  id: "preview-123",
  type: "environment",
  attributes: {
    name: "Preview 123",
    color: null,
    classification: "AD_HOC",
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

const SAMPLE_CT = {
  id: "user",
  type: "context_type",
  attributes: {
    name: "User",
    attributes: { plan: { label: "Plan" }, region: {} },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

const SAMPLE_CONTEXT = {
  id: "user:u-123",
  type: "context",
  attributes: {
    name: "Alice",
    attributes: { plan: "enterprise" },
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

// ===========================================================================
// EnvironmentsClient
// ===========================================================================

describe("EnvironmentsClient", () => {
  // -----------------------------------------------------------------------
  // new()
  // -----------------------------------------------------------------------

  describe("new()", () => {
    it("should return an Environment with createdAt: null", () => {
      const client = makeClient();
      const env = client.environments.new("staging", { name: "Staging" });
      expect(env).toBeInstanceOf(Environment);
      expect(env.id).toBe("staging");
      expect(env.name).toBe("Staging");
      expect(env.createdAt).toBeNull();
    });

    it("should default classification to STANDARD", () => {
      const client = makeClient();
      const env = client.environments.new("staging", { name: "Staging" });
      expect(env.classification).toBe(EnvironmentClassification.STANDARD);
    });

    it("should accept custom classification", () => {
      const client = makeClient();
      const env = client.environments.new("preview", {
        name: "Preview",
        classification: EnvironmentClassification.AD_HOC,
      });
      expect(env.classification).toBe(EnvironmentClassification.AD_HOC);
    });

    it("should default color to null", () => {
      const client = makeClient();
      const env = client.environments.new("staging", { name: "Staging" });
      expect(env.color).toBeNull();
    });

    it("should accept color", () => {
      const client = makeClient();
      const env = client.environments.new("production", { name: "Production", color: "#ff0000" });
      expect(env.color?.hex).toBe("#ff0000");
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe("list()", () => {
    it("should return list of Environments", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_ENV, SAMPLE_AD_HOC_ENV] }));

      const envs = await client.environments.list();

      expect(envs).toHaveLength(2);
      expect(envs[0]).toBeInstanceOf(Environment);
      expect(envs[0].id).toBe("production");
      expect(envs[0].name).toBe("Production");
      expect(envs[0].classification).toBe(EnvironmentClassification.STANDARD);
      expect(envs[1].classification).toBe(EnvironmentClassification.AD_HOC);
    });

    it("should return empty array for empty list", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      const envs = await client.environments.list();
      expect(envs).toEqual([]);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(client.environments.list()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplConnectionError for generic errors", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new Error("Some unexpected error"));
      await expect(client.environments.list()).rejects.toThrow(SmplConnectionError);
    });
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe("get()", () => {
    it("should return an Environment by id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));

      const env = await client.environments.get("production");

      expect(env).toBeInstanceOf(Environment);
      expect(env.id).toBe("production");
      expect(env.color?.hex).toBe("#ff0000");
    });

    it("should throw SmplNotFoundError on 404", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(client.environments.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
      await expect(client.environments.get("production")).rejects.toThrow(SmplConnectionError);
    });

    it("should silently fall back to null color when the wire color string is invalid", async () => {
      const client = makeClient();
      const malformedEnv = {
        id: "broken-color",
        type: "environment",
        attributes: {
          name: "Broken Color",
          color: "not-a-valid-hex",
          classification: "STANDARD",
          created_at: "2026-04-01T10:00:00Z",
          updated_at: "2026-04-01T10:00:00Z",
        },
      };
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: malformedEnv }));

      const env = await client.environments.get("broken-color");

      expect(env.color).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // delete()
  // -----------------------------------------------------------------------

  describe("delete()", () => {
    it("should resolve on 200", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await expect(client.environments.delete("staging")).resolves.toBeUndefined();
    });

    it("should resolve on 204", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(client.environments.delete("staging")).resolves.toBeUndefined();
    });

    it("should throw SmplNotFoundError on 404", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(client.environments.delete("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // Environment.save() via _create / _update
  // -----------------------------------------------------------------------

  describe("Environment.save() — create (createdAt === null)", () => {
    it("should POST to /api/v1/environments", async () => {
      const client = makeClient();
      const env = client.environments.new("staging", { name: "Staging" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();

      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v1/environments");
    });

    it("should throw SmplConnectionError on network failure during create", async () => {
      const client = makeClient();
      const env = client.environments.new("staging", { name: "Staging" });
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(env.save()).rejects.toThrow(SmplConnectionError);
    });

    it("should send JSON:API body", async () => {
      const client = makeClient();
      const env = client.environments.new("staging", { name: "Staging", color: "#aabbcc" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();

      const req: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await req.text());
      expect(body.data.type).toBe("environment");
      expect(body.data.id).toBe("staging");
      expect(body.data.attributes.name).toBe("Staging");
      expect(body.data.attributes.color).toBe("#aabbcc");
    });

    it("should apply response fields after creation", async () => {
      const client = makeClient();
      const env = client.environments.new("staging", { name: "Staging" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();

      expect(env.id).toBe("production");
      expect(env.createdAt).toBe("2026-04-01T10:00:00Z");
    });
  });

  describe("Environment.save() — update (createdAt set)", () => {
    it("should PUT to /api/v1/environments/{id}", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      const env = await client.environments.get("production");
      env.name = "Production Updated";

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();

      const req: Request = mockFetch.mock.calls[1][0];
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/environments/production");
    });

    it("should throw SmplConnectionError on network failure during update", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      const env = await client.environments.get("production");

      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(env.save()).rejects.toThrow(SmplConnectionError);
    });
  });
});

// ===========================================================================
// ContextTypesClient
// ===========================================================================

describe("ContextTypesClient", () => {
  describe("new()", () => {
    it("should return a ContextType with createdAt: null", () => {
      const client = makeClient();
      const ct = client.contextTypes.new("user");
      expect(ct).toBeInstanceOf(ContextType);
      expect(ct.id).toBe("user");
      expect(ct.createdAt).toBeNull();
    });

    it("should default name to id when not provided", () => {
      const client = makeClient();
      const ct = client.contextTypes.new("user");
      expect(ct.name).toBe("user");
    });

    it("should accept custom name", () => {
      const client = makeClient();
      const ct = client.contextTypes.new("user", { name: "Platform User" });
      expect(ct.name).toBe("Platform User");
    });

    it("should default attributes to empty object", () => {
      const client = makeClient();
      const ct = client.contextTypes.new("user");
      expect(ct.attributes).toEqual({});
    });
  });

  describe("list()", () => {
    it("should return list of ContextTypes", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_CT] }));

      const cts = await client.contextTypes.list();

      expect(cts).toHaveLength(1);
      expect(cts[0]).toBeInstanceOf(ContextType);
      expect(cts[0].id).toBe("user");
      expect(cts[0].attributes).toEqual({ plan: { label: "Plan" }, region: {} });
    });

    it("should throw SmplConnectionError on network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
      await expect(client.contextTypes.list()).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("get()", () => {
    it("should return a ContextType by id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));

      const ct = await client.contextTypes.get("user");

      expect(ct).toBeInstanceOf(ContextType);
      expect(ct.id).toBe("user");
      expect(ct.name).toBe("User");
    });

    it("should throw SmplNotFoundError on 404", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(client.contextTypes.get("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  describe("delete()", () => {
    it("should resolve on 204", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(client.contextTypes.delete("user")).resolves.toBeUndefined();
    });

    it("should throw SmplNotFoundError on 404", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(client.contextTypes.delete("missing")).rejects.toThrow(SmplNotFoundError);
    });
  });

  describe("ContextType.save() — create", () => {
    it("should POST to /api/v1/context_types", async () => {
      const client = makeClient();
      const ct = client.contextTypes.new("account", { name: "Account" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      await ct.save();

      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v1/context_types");
    });

    it("should throw SmplConnectionError on network failure during create", async () => {
      const client = makeClient();
      const ct = client.contextTypes.new("account", { name: "Account" });
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(ct.save()).rejects.toThrow(SmplConnectionError);
    });

    it("should send JSON:API body with attributes", async () => {
      const client = makeClient();
      const ct = client.contextTypes.new("user", { name: "User" });
      ct.addAttribute("plan", { label: "Plan" });

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      await ct.save();

      const req: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await req.text());
      expect(body.data.type).toBe("context_type");
      expect(body.data.id).toBe("user");
      expect(body.data.attributes.attributes).toEqual({ plan: { label: "Plan" } });
    });
  });

  describe("ContextType.save() — update", () => {
    it("should PUT to /api/v1/context_types/{id}", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      const ct = await client.contextTypes.get("user");

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      await ct.save();

      const req: Request = mockFetch.mock.calls[1][0];
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/context_types/user");
    });

    it("should throw SmplConnectionError on network failure during update", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      const ct = await client.contextTypes.get("user");

      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(ct.save()).rejects.toThrow(SmplConnectionError);
    });
  });
});

// ===========================================================================
// ContextsClient
// ===========================================================================

describe("ContextsClient", () => {
  // -----------------------------------------------------------------------
  // register() + flush()
  // -----------------------------------------------------------------------

  describe("register()", () => {
    it("should buffer a single context without flushing", async () => {
      const client = makeClient();
      const ctx = new Context("user", "u-1", { plan: "enterprise" });

      await client.contexts.register(ctx);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should buffer an array of contexts", async () => {
      const client = makeClient();
      const ctxs = [
        new Context("user", "u-1", { plan: "enterprise" }),
        new Context("account", "a-1", { region: "us" }),
      ];

      await client.contexts.register(ctxs);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should flush immediately when flush: true", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      const ctx = new Context("user", "u-1", { plan: "enterprise" });

      await client.contexts.register(ctx, { flush: true });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toContain("/api/v1/contexts/bulk");
    });
  });

  describe("flush()", () => {
    it("should POST buffered contexts to bulk endpoint", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await client.contexts.register(new Context("user", "u-1", { plan: "pro" }));
      await client.contexts.register(new Context("account", "a-1", {}));

      await client.contexts.flush();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const req: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await req.text());
      expect(body.contexts).toHaveLength(2);
      expect(body.contexts[0].type).toBe("user");
      expect(body.contexts[0].key).toBe("u-1");
      expect(body.contexts[1].type).toBe("account");
    });

    it("should not POST when buffer is empty", async () => {
      const client = makeClient();
      await client.contexts.flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should clear buffer after flush", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await client.contexts.register(new Context("user", "u-1", {}));
      await client.contexts.flush();

      // Second flush should be a no-op
      await client.contexts.flush();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await client.contexts.register(new Context("user", "u-1", {}));
      await expect(client.contexts.flush()).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("pendingCount", () => {
    it("reflects the buffer's pending size", async () => {
      const client = makeClient();
      expect(client.contexts.pendingCount).toBe(0);
      await client.contexts.register(new Context("user", "u-1", {}));
      expect(client.contexts.pendingCount).toBe(1);
      await client.contexts.register(new Context("account", "a-1", {}));
      expect(client.contexts.pendingCount).toBe(2);
    });

    it("auto-flushes when the pending count crosses the batch threshold", async () => {
      const client = makeClient();
      // Use mockImplementation so each fetch call returns a fresh response.
      mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
      // 100 unique contexts triggers the auto-flush branch in register().
      const ctxs = Array.from(
        { length: 100 },
        (_, i) => new Context("user", `u-${i}`, { plan: "free" }),
      );

      await client.contexts.register(ctxs);

      // wait for the fire-and-forget flush to settle
      await new Promise((r) => setTimeout(r, 0));

      expect(mockFetch).toHaveBeenCalled();
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toContain("/api/v1/contexts/bulk");
    });
  });

  describe("_saveContext (Context.save() flow)", () => {
    it("uses bulk endpoint then GET when context has no createdAt (create)", async () => {
      const client = makeClient();
      // register([ctx], { flush: true }) does a POST to /contexts/bulk.
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      // The follow-up GET fetches the freshly-saved context.
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));

      const ctx = new Context("user", "u-123", { plan: "free" });
      // Wire the context to the management client so save() can route through.
      // @ts-expect-error — internal wiring for the test
      ctx._client = client.contexts;

      await ctx.save();

      // Two HTTP calls: bulk POST + GET
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const bulkReq: Request = mockFetch.mock.calls[0][0];
      expect(bulkReq.method).toBe("POST");
      expect(bulkReq.url).toContain("/api/v1/contexts/bulk");

      const getReq: Request = mockFetch.mock.calls[1][0];
      expect(getReq.method).toBe("GET");
      expect(getReq.url).toContain("/api/v1/contexts/user%3Au-123");
    });

    it("uses PUT when context has createdAt (update)", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));

      const ctx = new Context(
        "user",
        "u-123",
        { plan: "enterprise" },
        { name: "Alice", createdAt: "2026-04-01T10:00:00Z" },
      );
      // @ts-expect-error — internal wiring for the test
      ctx._client = client.contexts;

      await ctx.save();

      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/contexts/user%3Au-123");
    });

    it("throws SmplValidationError when the PUT response has no data", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));

      const ctx = new Context("user", "u-123", {}, { createdAt: "2026-04-01T10:00:00Z" });
      // @ts-expect-error — internal wiring for the test
      ctx._client = client.contexts;

      await expect(ctx.save()).rejects.toThrow(SmplValidationError);
    });

    it("throws SmplConnectionError on network failure during PUT", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const ctx = new Context("user", "u-123", {}, { createdAt: "2026-04-01T10:00:00Z" });
      // @ts-expect-error — internal wiring for the test
      ctx._client = client.contexts;

      await expect(ctx.save()).rejects.toThrow(SmplConnectionError);
    });
  });

  // -----------------------------------------------------------------------
  // list()
  // -----------------------------------------------------------------------

  describe("list()", () => {
    it("should return list of Contexts filtered by type", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_CONTEXT] }));

      const entities = await client.contexts.list("user");

      expect(entities).toHaveLength(1);
      expect(entities[0]).toBeInstanceOf(Context);
      expect(entities[0].type).toBe("user");
      expect(entities[0].key).toBe("u-123");
      expect(entities[0].name).toBe("Alice");
      expect(entities[0].attributes).toEqual({ plan: "enterprise" });
    });

    it("should pass filter[context_type] query param", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await client.contexts.list("account");

      const req: Request = mockFetch.mock.calls[0][0];
      expect(decodeURIComponent(req.url)).toContain("filter[context_type]=account");
    });

    it("should throw SmplConnectionError on network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(client.contexts.list("user")).rejects.toThrow(SmplConnectionError);
    });
  });

  // -----------------------------------------------------------------------
  // get()
  // -----------------------------------------------------------------------

  describe("get()", () => {
    it("should accept composite type:key id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));

      const entity = await client.contexts.get("user:u-123");

      expect(entity).toBeInstanceOf(Context);
      expect(entity.type).toBe("user");
      expect(entity.key).toBe("u-123");
    });

    it("should accept separate type and key args", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));

      const entity = await client.contexts.get("user", "u-123");

      expect(entity.type).toBe("user");
      expect(entity.key).toBe("u-123");
    });

    it("should use composite id in request URL", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));

      await client.contexts.get("user:u-123");

      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toContain("/api/v1/contexts/user%3Au-123");
    });

    it("should throw SmplNotFoundError on 404", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(client.contexts.get("user:missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw when composite id is missing colon", async () => {
      const client = makeClient();
      await expect(client.contexts.get("user")).rejects.toThrow("type:key");
    });
  });

  // -----------------------------------------------------------------------
  // delete()
  // -----------------------------------------------------------------------

  describe("delete()", () => {
    it("should delete by composite id", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(client.contexts.delete("user:u-123")).resolves.toBeUndefined();
    });

    it("should delete by separate type and key", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(client.contexts.delete("user", "u-123")).resolves.toBeUndefined();
    });

    it("should throw SmplNotFoundError on 404", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(client.contexts.delete("user:missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(client.contexts.delete("user:u-1")).rejects.toThrow(SmplConnectionError);
    });
  });
});

// ===========================================================================
// AccountSettingsClient
// ===========================================================================

describe("AccountSettingsClient", () => {
  describe("get()", () => {
    it("should return AccountSettings", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ environment_order: ["production", "staging"] }),
      );

      const settings = await client.accountSettings.get();

      expect(settings).toBeInstanceOf(AccountSettings);
      expect(settings.environmentOrder).toEqual(["production", "staging"]);
    });

    it("should GET /api/v1/accounts/current/settings", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      await client.accountSettings.get();

      const [url] = mockFetch.mock.calls[0];
      expect(typeof url).toBe("string");
      expect(url).toContain("/api/v1/accounts/current/settings");
    });

    it("should include Authorization header", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}));

      await client.accountSettings.get();

      const [, init] = mockFetch.mock.calls[0];
      expect(init.headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    });

    it("should throw SmplConnectionError on network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(client.accountSettings.get()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplValidationError on 422", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("Unprocessable", 422));
      await expect(client.accountSettings.get()).rejects.toThrow(SmplValidationError);
    });
  });

  describe("_save() error handling", () => {
    it("should throw SmplConnectionError on network failure during save", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const settings = await client.accountSettings.get();

      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(settings.save()).rejects.toThrow(SmplConnectionError);
    });

    it("should throw SmplValidationError on 422 during save", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const settings = await client.accountSettings.get();

      mockFetch.mockResolvedValueOnce(textResponse("Unprocessable", 422));
      await expect(settings.save()).rejects.toThrow(SmplValidationError);
    });
  });

  describe("AccountSettings.save()", () => {
    it("should PUT updated data back to server", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ environment_order: ["production"] }));
      const settings = await client.accountSettings.get();

      settings.environmentOrder = ["production", "staging"];
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ environment_order: ["production", "staging"] }),
      );
      await settings.save();

      const [url, init] = mockFetch.mock.calls[1];
      expect(init.method).toBe("PUT");
      expect(typeof url).toBe("string");
      expect(url).toContain("/api/v1/accounts/current/settings");
      const body = JSON.parse(init.body as string);
      expect(body.environment_order).toEqual(["production", "staging"]);
    });

    it("should apply response data after save", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      const settings = await client.accountSettings.get();

      settings.environmentOrder = ["development"];
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ environment_order: ["development", "production"] }),
      );
      await settings.save();

      expect(settings.environmentOrder).toEqual(["development", "production"]);
    });
  });
});

// ===========================================================================
// SmplManagementClient construction
// ===========================================================================

describe("SmplManagementClient", () => {
  it("should expose environments, contexts, contextTypes, accountSettings", () => {
    const client = makeClient();
    expect(client.environments).toBeDefined();
    expect(client.contexts).toBeDefined();
    expect(client.contextTypes).toBeDefined();
    expect(client.accountSettings).toBeDefined();
  });
});
