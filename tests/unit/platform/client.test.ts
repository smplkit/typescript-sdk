import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createClient from "openapi-fetch";
import {
  PlatformClient,
  EnvironmentsClient,
  ServicesClient,
  ContextsClient,
  ContextTypesClient,
} from "../../../src/platform/client.js";
import { Environment, ContextType, Service } from "../../../src/platform/models.js";
import { EnvironmentClassification, Color } from "../../../src/platform/types.js";
import { Context } from "../../../src/flags/types.js";
import { ContextRegistrationBuffer } from "../../../src/buffer.js";
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

function makeClient(): PlatformClient {
  return new PlatformClient({
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

const SAMPLE_SERVICE = {
  id: "user_service",
  type: "service",
  attributes: {
    name: "User Service",
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-04-01T10:00:00Z",
  },
};

const SAMPLE_BILLING_SERVICE = {
  id: "billing",
  type: "service",
  attributes: {
    name: "Billing",
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
  describe("new()", () => {
    it("returns an Environment with createdAt: null", () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      expect(env).toBeInstanceOf(Environment);
      expect(env.id).toBe("staging");
      expect(env.name).toBe("Staging");
      expect(env.createdAt).toBeNull();
    });

    it("defaults classification to STANDARD", () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      expect(env.classification).toBe(EnvironmentClassification.STANDARD);
    });

    it("accepts a custom classification", () => {
      const env = makeClient().environments.new("preview", {
        name: "Preview",
        classification: EnvironmentClassification.AD_HOC,
      });
      expect(env.classification).toBe(EnvironmentClassification.AD_HOC);
    });

    it("defaults color to null", () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      expect(env.color).toBeNull();
    });

    it("accepts a hex color string", () => {
      const env = makeClient().environments.new("production", {
        name: "Production",
        color: "#ff0000",
      });
      expect(env.color?.hex).toBe("#ff0000");
    });

    it("accepts a Color instance", () => {
      const env = makeClient().environments.new("production", {
        name: "Production",
        color: new Color("#abcdef"),
      });
      expect(env.color?.hex).toBe("#abcdef");
    });
  });

  describe("list()", () => {
    it("returns Environments with classification mapped", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_ENV, SAMPLE_AD_HOC_ENV] }));
      const envs = await makeClient().environments.list();
      expect(envs).toHaveLength(2);
      expect(envs[0]).toBeInstanceOf(Environment);
      expect(envs[0].id).toBe("production");
      expect(envs[0].name).toBe("Production");
      expect(envs[0].classification).toBe(EnvironmentClassification.STANDARD);
      expect(envs[1].classification).toBe(EnvironmentClassification.AD_HOC);
      expect(envs[1].color).toBeNull();
    });

    it("returns an empty array for an empty list", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      expect(await makeClient().environments.list()).toEqual([]);
    });

    it("returns an empty array when the body has no data array", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      expect(await makeClient().environments.list()).toEqual([]);
    });

    it("throws SmplConnectionError on network failure (TypeError)", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().environments.list()).rejects.toThrow(SmplConnectionError);
    });

    it("throws SmplConnectionError for generic errors", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Some unexpected error"));
      await expect(makeClient().environments.list()).rejects.toThrow(SmplConnectionError);
    });

    it("passes pageNumber and pageSize as query params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().environments.list({ pageNumber: 2, pageSize: 50 });
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
      expect(req.url).toMatch(/page(\[|%5B)size(\]|%5D)=50/);
    });

    it("omits pagination query params when not supplied", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().environments.list();
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).not.toMatch(/page(\[|%5B)number(\]|%5D)/);
      expect(req.url).not.toMatch(/page(\[|%5B)size(\]|%5D)/);
    });

    it("surfaces the JSON:API error on a non-ok list response", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("boom", 500));
      await expect(makeClient().environments.list()).rejects.toThrow(/500/);
    });
  });

  describe("get()", () => {
    it("returns an Environment by id and parses color", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      const env = await makeClient().environments.get("production");
      expect(env).toBeInstanceOf(Environment);
      expect(env.id).toBe("production");
      expect(env.color?.hex).toBe("#ff0000");
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().environments.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplNotFoundError when the body has no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(makeClient().environments.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
      await expect(makeClient().environments.get("production")).rejects.toThrow(
        SmplConnectionError,
      );
    });

    it("falls back to null color when the wire color string is invalid", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: {
            id: "broken-color",
            type: "environment",
            attributes: { name: "Broken", color: "not-a-hex", classification: "STANDARD" },
          },
        }),
      );
      const env = await makeClient().environments.get("broken-color");
      expect(env.color).toBeNull();
    });

    it("treats missing attributes as defaults", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: "bare", type: "environment" } }));
      const env = await makeClient().environments.get("bare");
      expect(env.id).toBe("bare");
      expect(env.name).toBe("");
      expect(env.color).toBeNull();
      expect(env.classification).toBe(EnvironmentClassification.STANDARD);
      expect(env.createdAt).toBeNull();
    });
  });

  describe("delete()", () => {
    it("resolves on 200", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await expect(makeClient().environments.delete("staging")).resolves.toBeUndefined();
    });

    it("resolves on 204", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(makeClient().environments.delete("staging")).resolves.toBeUndefined();
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().environments.delete("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().environments.delete("x")).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("Environment.save() — create (createdAt === null)", () => {
    it("POSTs to /api/v1/environments without a `managed` attribute", async () => {
      const env = makeClient().environments.new("staging", { name: "Staging", color: "#aabbcc" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();

      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v1/environments");
      const body = JSON.parse(await req.text());
      expect(body.data.type).toBe("environment");
      expect(body.data.id).toBe("staging");
      expect(body.data.attributes.name).toBe("Staging");
      expect(body.data.attributes.color).toBe("#aabbcc");
      expect(body.data.attributes.classification).toBe("STANDARD");
      expect(body.data.attributes).not.toHaveProperty("managed");
    });

    it("sends null color when no color is set", async () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();
      const body = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
      expect(body.data.attributes.color).toBeNull();
    });

    it("applies response fields after creation", async () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();
      expect(env.id).toBe("production");
      expect(env.createdAt).toBe("2026-04-01T10:00:00Z");
    });

    it("throws SmplConnectionError on network failure during create", async () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(env.save()).rejects.toThrow(SmplConnectionError);
    });

    it("preserves the JSON:API error body on 400 (regression for empty-body bug)", async () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      const errorBody = {
        errors: [
          {
            status: "400",
            code: "environment_unmanaged",
            title: "Environment is unmanaged",
            detail: "Environment 'staging' is unmanaged. Promote it first.",
            meta: { environment: "staging" },
          },
        ],
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(errorBody, 400));
      try {
        await env.save();
        throw new Error("expected save() to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SmplValidationError);
        const se = err as SmplValidationError;
        expect(se.statusCode).toBe(400);
        expect(se.errors).toHaveLength(1);
        expect(se.errors[0].code).toBe("environment_unmanaged");
        expect(se.errors[0].meta).toEqual({ environment: "staging" });
      }
    });

    it("falls back gracefully when the 400 response is not JSON", async () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      mockFetch.mockResolvedValueOnce(textResponse("<html>bad</html>", 400));
      await expect(env.save()).rejects.toThrow(SmplValidationError);
    });

    it("throws SmplValidationError when the create response has no data", async () => {
      const env = makeClient().environments.new("staging", { name: "Staging" });
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(env.save()).rejects.toThrow(SmplValidationError);
    });
  });

  describe("Environment.save() — update (createdAt set)", () => {
    it("PUTs to /api/v1/environments/{id}", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      const env = await client.environments.get("production");
      env.name = "Production Updated";

      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      await env.save();

      const req: Request = mockFetch.mock.calls[1][0];
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/environments/production");
      const body = JSON.parse(await req.text());
      expect(body.data.attributes).not.toHaveProperty("managed");
    });

    it("throws SmplConnectionError on network failure during update", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      const env = await client.environments.get("production");
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(env.save()).rejects.toThrow(SmplConnectionError);
    });

    it("throws SmplValidationError when the update response has no data", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_ENV }));
      const env = await client.environments.get("production");
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(env.save()).rejects.toThrow(SmplValidationError);
    });

    it("throws when _update is called on an Environment with no id", async () => {
      const env = new EnvironmentsClient(
        // build a bare http client just to reach _update directly
        createClient<import("../../../src/generated/app.d.ts").paths>({
          baseUrl: "http://app.test",
        }),
      );
      const bare = new Environment(env, {
        id: null,
        name: "x",
        classification: EnvironmentClassification.STANDARD,
        createdAt: "2026-01-01T00:00:00Z",
      });
      await expect(env._update(bare)).rejects.toThrow("cannot update an Environment with no id");
    });
  });
});

// ===========================================================================
// ServicesClient
// ===========================================================================

describe("ServicesClient", () => {
  describe("new()", () => {
    it("returns a Service with createdAt: null", () => {
      const svc = makeClient().services.new("user_service", { name: "User Service" });
      expect(svc).toBeInstanceOf(Service);
      expect(svc.id).toBe("user_service");
      expect(svc.name).toBe("User Service");
      expect(svc.createdAt).toBeNull();
    });
  });

  describe("list()", () => {
    it("returns a list of Services", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [SAMPLE_SERVICE, SAMPLE_BILLING_SERVICE] }),
      );
      const svcs = await makeClient().services.list();
      expect(svcs).toHaveLength(2);
      expect(svcs[0]).toBeInstanceOf(Service);
      expect(svcs[0].id).toBe("user_service");
      expect(svcs[1].id).toBe("billing");
    });

    it("returns an empty array for an empty list", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      expect(await makeClient().services.list()).toEqual([]);
    });

    it("treats missing service attributes as defaults", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: "bare", type: "service" }] }));
      const svcs = await makeClient().services.list();
      expect(svcs[0].id).toBe("bare");
      expect(svcs[0].name).toBe("");
      expect(svcs[0].createdAt).toBeNull();
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().services.list()).rejects.toThrow(SmplConnectionError);
    });

    it("passes pageNumber and pageSize as query params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().services.list({ pageNumber: 2, pageSize: 50 });
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toMatch(/page(\[|%5B)number(\]|%5D)=2/);
      expect(req.url).toMatch(/page(\[|%5B)size(\]|%5D)=50/);
    });

    it("omits pagination query params when not supplied", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().services.list();
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).not.toMatch(/page(\[|%5B)number(\]|%5D)/);
    });
  });

  describe("get()", () => {
    it("returns a Service by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_SERVICE }));
      const svc = await makeClient().services.get("user_service");
      expect(svc).toBeInstanceOf(Service);
      expect(svc.id).toBe("user_service");
      expect(svc.name).toBe("User Service");
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().services.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplNotFoundError when the body has no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(makeClient().services.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
      await expect(makeClient().services.get("user_service")).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("delete()", () => {
    it("resolves on 204", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(makeClient().services.delete("user_service")).resolves.toBeUndefined();
    });

    it("resolves on 200", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await expect(makeClient().services.delete("user_service")).resolves.toBeUndefined();
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().services.delete("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().services.delete("x")).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("Service.save() — create", () => {
    it("POSTs a JSON:API body with id and name", async () => {
      const svc = makeClient().services.new("user_service", { name: "User Service" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_SERVICE }));
      await svc.save();
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v1/services");
      const body = JSON.parse(await req.text());
      expect(body.data.type).toBe("service");
      expect(body.data.id).toBe("user_service");
      expect(body.data.attributes.name).toBe("User Service");
    });

    it("applies response fields after creation", async () => {
      const svc = makeClient().services.new("user_service", { name: "User Service" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_SERVICE }));
      await svc.save();
      expect(svc.createdAt).toBe("2026-04-01T10:00:00Z");
    });

    it("throws SmplConnectionError on network failure during create", async () => {
      const svc = makeClient().services.new("user_service", { name: "User Service" });
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(svc.save()).rejects.toThrow(SmplConnectionError);
    });

    it("preserves the JSON:API error body on 409 (duplicate)", async () => {
      const svc = makeClient().services.new("user_service", { name: "User Service" });
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          { errors: [{ status: "409", code: "service_conflict", detail: "already exists" }] },
          409,
        ),
      );
      await expect(svc.save()).rejects.toThrow();
    });

    it("throws SmplValidationError when the create response has no data", async () => {
      const svc = makeClient().services.new("user_service", { name: "User Service" });
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(svc.save()).rejects.toThrow(SmplValidationError);
    });
  });

  describe("Service.save() — update", () => {
    it("PUTs to /api/v1/services/{id}", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_SERVICE }));
      const svc = await client.services.get("user_service");
      svc.name = "Updated";
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_SERVICE }));
      await svc.save();
      const req: Request = mockFetch.mock.calls[1][0];
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/services/user_service");
    });

    it("throws SmplConnectionError on network failure during update", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_SERVICE }));
      const svc = await client.services.get("user_service");
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(svc.save()).rejects.toThrow(SmplConnectionError);
    });

    it("throws SmplValidationError when the update response has no data", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_SERVICE }));
      const svc = await client.services.get("user_service");
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(svc.save()).rejects.toThrow(SmplValidationError);
    });

    it("throws when _update is called on a Service with no id", async () => {
      const svcs = new ServicesClient(
        createClient<import("../../../src/generated/app.d.ts").paths>({
          baseUrl: "http://app.test",
        }),
      );
      const bare = new Service(svcs, { id: null, name: "x", createdAt: "2026-01-01T00:00:00Z" });
      await expect(svcs._update(bare)).rejects.toThrow("cannot update a Service with no id");
    });
  });
});

// ===========================================================================
// ContextTypesClient
// ===========================================================================

describe("ContextTypesClient", () => {
  describe("new()", () => {
    it("returns a ContextType with createdAt: null", () => {
      const ct = makeClient().contextTypes.new("user");
      expect(ct).toBeInstanceOf(ContextType);
      expect(ct.id).toBe("user");
      expect(ct.createdAt).toBeNull();
    });

    it("defaults name to id", () => {
      expect(makeClient().contextTypes.new("user").name).toBe("user");
    });

    it("accepts a custom name", () => {
      expect(makeClient().contextTypes.new("user", { name: "Platform User" }).name).toBe(
        "Platform User",
      );
    });

    it("defaults attributes to an empty object", () => {
      expect(makeClient().contextTypes.new("user").attributes).toEqual({});
    });

    it("accepts custom attributes", () => {
      const ct = makeClient().contextTypes.new("user", { attributes: { plan: { label: "Plan" } } });
      expect(ct.attributes).toEqual({ plan: { label: "Plan" } });
    });
  });

  describe("list()", () => {
    it("returns a list of ContextTypes with attribute metadata", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_CT] }));
      const cts = await makeClient().contextTypes.list();
      expect(cts).toHaveLength(1);
      expect(cts[0]).toBeInstanceOf(ContextType);
      expect(cts[0].id).toBe("user");
      expect(cts[0].attributes).toEqual({ plan: { label: "Plan" }, region: {} });
    });

    it("coerces non-object attribute metadata values to empty objects", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: "weird",
              type: "context_type",
              attributes: { name: "Weird", attributes: { plan: "scalar", region: null } },
            },
          ],
        }),
      );
      const cts = await makeClient().contextTypes.list();
      expect(cts[0].attributes).toEqual({ plan: {}, region: {} });
    });

    it("defaults name to id when name and id are both present but name absent", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [{ id: "device", type: "context_type", attributes: {} }] }),
      );
      const cts = await makeClient().contextTypes.list();
      expect(cts[0].name).toBe("device");
      expect(cts[0].attributes).toEqual({});
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
      await expect(makeClient().contextTypes.list()).rejects.toThrow(SmplConnectionError);
    });

    it("passes pageNumber and pageSize as query params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().contextTypes.list({ pageNumber: 7, pageSize: 30 });
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toMatch(/page(\[|%5B)number(\]|%5D)=7/);
      expect(req.url).toMatch(/page(\[|%5B)size(\]|%5D)=30/);
    });

    it("omits pagination query params when not supplied", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().contextTypes.list();
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).not.toMatch(/page(\[|%5B)number(\]|%5D)/);
    });
  });

  describe("get()", () => {
    it("returns a ContextType by id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      const ct = await makeClient().contextTypes.get("user");
      expect(ct).toBeInstanceOf(ContextType);
      expect(ct.id).toBe("user");
      expect(ct.name).toBe("User");
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().contextTypes.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplNotFoundError when the body has no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(makeClient().contextTypes.get("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Network error"));
      await expect(makeClient().contextTypes.get("user")).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("delete()", () => {
    it("resolves on 204", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(makeClient().contextTypes.delete("user")).resolves.toBeUndefined();
    });

    it("resolves on 200", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await expect(makeClient().contextTypes.delete("user")).resolves.toBeUndefined();
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().contextTypes.delete("missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().contextTypes.delete("x")).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("ContextType.save() — create", () => {
    it("POSTs a JSON:API body with attributes metadata", async () => {
      const ct = makeClient().contextTypes.new("user", { name: "User" });
      ct.addAttribute("plan", { label: "Plan" });
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      await ct.save();
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/api/v1/context_types");
      const body = JSON.parse(await req.text());
      expect(body.data.type).toBe("context_type");
      expect(body.data.id).toBe("user");
      expect(body.data.attributes.attributes).toEqual({ plan: { label: "Plan" } });
    });

    it("throws SmplConnectionError on network failure during create", async () => {
      const ct = makeClient().contextTypes.new("account", { name: "Account" });
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(ct.save()).rejects.toThrow(SmplConnectionError);
    });

    it("throws SmplValidationError when the create response has no data", async () => {
      const ct = makeClient().contextTypes.new("account", { name: "Account" });
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(ct.save()).rejects.toThrow(SmplValidationError);
    });
  });

  describe("ContextType.save() — update", () => {
    it("PUTs to /api/v1/context_types/{id}", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      const ct = await client.contextTypes.get("user");
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      await ct.save();
      const req: Request = mockFetch.mock.calls[1][0];
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/context_types/user");
    });

    it("throws SmplConnectionError on network failure during update", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      const ct = await client.contextTypes.get("user");
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(ct.save()).rejects.toThrow(SmplConnectionError);
    });

    it("throws SmplValidationError when the update response has no data", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CT }));
      const ct = await client.contextTypes.get("user");
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(ct.save()).rejects.toThrow(SmplValidationError);
    });

    it("throws when _update is called on a ContextType with no id", async () => {
      const cts = new ContextTypesClient(
        createClient<import("../../../src/generated/app.d.ts").paths>({
          baseUrl: "http://app.test",
        }),
      );
      const bare = new ContextType(cts, { id: null, name: "x", createdAt: "2026-01-01T00:00:00Z" });
      await expect(cts._update(bare)).rejects.toThrow("cannot update a ContextType with no id");
    });
  });
});

// ===========================================================================
// ContextsClient
// ===========================================================================

describe("ContextsClient", () => {
  describe("register() + flush()", () => {
    it("buffers a single context without flushing", async () => {
      const client = makeClient();
      await client.contexts.register(new Context("user", "u-1", { plan: "enterprise" }));
      expect(mockFetch).not.toHaveBeenCalled();
      expect(client.contexts.pendingCount).toBe(1);
    });

    it("buffers an array of contexts", async () => {
      const client = makeClient();
      await client.contexts.register([
        new Context("user", "u-1", { plan: "enterprise" }),
        new Context("account", "a-1", { region: "us" }),
      ]);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(client.contexts.pendingCount).toBe(2);
    });

    it("flushes immediately when flush: true", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await client.contexts.register(new Context("user", "u-1", { plan: "enterprise" }), {
        flush: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toContain("/api/v1/contexts/bulk");
      expect(client.contexts.pendingCount).toBe(0);
    });

    it("POSTs the buffered contexts to the bulk endpoint", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await client.contexts.register(new Context("user", "u-1", { plan: "pro" }));
      await client.contexts.register(new Context("account", "a-1", {}));
      await client.contexts.flush();
      const req: Request = mockFetch.mock.calls[0][0];
      const body = JSON.parse(await req.text());
      expect(body.contexts).toHaveLength(2);
      expect(body.contexts[0]).toEqual({ type: "user", key: "u-1", attributes: { plan: "pro" } });
      expect(body.contexts[1].type).toBe("account");
    });

    it("does not POST when the buffer is empty", async () => {
      await makeClient().contexts.flush();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("clears the buffer after flush", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await client.contexts.register(new Context("user", "u-1", {}));
      await client.contexts.flush();
      await client.contexts.flush();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws SmplConnectionError on flush network failure", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await client.contexts.register(new Context("user", "u-1", {}));
      await expect(client.contexts.flush()).rejects.toThrow(SmplConnectionError);
    });

    it("surfaces a non-ok flush response", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(textResponse("nope", 500));
      await client.contexts.register(new Context("user", "u-1", {}));
      await expect(client.contexts.flush()).rejects.toThrow(/500/);
    });

    it("auto-flushes when the pending count crosses the batch threshold", async () => {
      const client = makeClient();
      mockFetch.mockImplementation(() => Promise.resolve(jsonResponse({}, 200)));
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

  describe("pendingCount", () => {
    it("reflects the shared buffer's pending size", async () => {
      const client = makeClient();
      expect(client.contexts.pendingCount).toBe(0);
      await client.contexts.register(new Context("user", "u-1", {}));
      expect(client.contexts.pendingCount).toBe(1);
    });
  });

  describe("constructor wiring", () => {
    it("uses an externally-supplied buffer when provided", () => {
      const buffer = new ContextRegistrationBuffer();
      const http = createClient<import("../../../src/generated/app.d.ts").paths>({
        baseUrl: "http://app.test",
      });
      const contexts = new ContextsClient(http, buffer);
      expect(contexts._buffer).toBe(buffer);
    });

    it("creates its own buffer when none is supplied", () => {
      const http = createClient<import("../../../src/generated/app.d.ts").paths>({
        baseUrl: "http://app.test",
      });
      const contexts = new ContextsClient(http);
      expect(contexts._buffer).toBeInstanceOf(ContextRegistrationBuffer);
    });
  });

  describe("_saveContext (Context.save() flow — always PUT)", () => {
    it("PUTs to the composite id and applies the response", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));
      const ctx = new Context("user", "u-123", { plan: "free" });
      ctx._client = client.contexts;
      await ctx.save();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.method).toBe("PUT");
      expect(req.url).toContain("/api/v1/contexts/user%3Au-123");
      const body = JSON.parse(await req.text());
      expect(body.data.type).toBe("context");
      expect(body.data.id).toBe("user:u-123");
      expect(body.data.attributes.context_type).toBe("user");
      expect(body.data.attributes.name).toBeNull();
      expect(ctx.name).toBe("Alice");
    });

    it("sends the context name when present", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));
      const ctx = new Context("user", "u-123", { plan: "enterprise" }, { name: "Alice" });
      ctx._client = client.contexts;
      await ctx.save();
      const body = JSON.parse(await (mockFetch.mock.calls[0][0] as Request).text());
      expect(body.data.attributes.name).toBe("Alice");
    });

    it("throws SmplValidationError when the PUT response has no data", async () => {
      const client = makeClient();
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      const ctx = new Context("user", "u-123", {});
      ctx._client = client.contexts;
      await expect(ctx.save()).rejects.toThrow(SmplValidationError);
    });

    it("throws SmplConnectionError on network failure during PUT", async () => {
      const client = makeClient();
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const ctx = new Context("user", "u-123", {});
      ctx._client = client.contexts;
      await expect(ctx.save()).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("list()", () => {
    it("returns Contexts filtered by type", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [SAMPLE_CONTEXT] }));
      const entities = await makeClient().contexts.list("user");
      expect(entities).toHaveLength(1);
      expect(entities[0]).toBeInstanceOf(Context);
      expect(entities[0].type).toBe("user");
      expect(entities[0].key).toBe("u-123");
      expect(entities[0].name).toBe("Alice");
      expect(entities[0].attributes).toEqual({ plan: "enterprise" });
    });

    it("parses a composite id with no colon as type-only", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "bare", type: "context", attributes: {} }],
        }),
      );
      const entities = await makeClient().contexts.list("bare");
      expect(entities[0].type).toBe("bare");
      expect(entities[0].key).toBe("");
      expect(entities[0].name).toBeNull();
      expect(entities[0].attributes).toEqual({});
    });

    it("passes the filter[context_type] query param", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().contexts.list("account");
      const req: Request = mockFetch.mock.calls[0][0];
      expect(decodeURIComponent(req.url)).toContain("filter[context_type]=account");
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().contexts.list("user")).rejects.toThrow(SmplConnectionError);
    });

    it("passes pageNumber and pageSize alongside the filter", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().contexts.list("user", { pageNumber: 3, pageSize: 200 });
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toMatch(/page(\[|%5B)number(\]|%5D)=3/);
      expect(req.url).toMatch(/page(\[|%5B)size(\]|%5D)=200/);
      expect(decodeURIComponent(req.url)).toContain("filter[context_type]=user");
    });

    it("omits pagination query params when not supplied", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
      await makeClient().contexts.list("user");
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).not.toMatch(/page(\[|%5B)number(\]|%5D)/);
    });
  });

  describe("get()", () => {
    it("accepts a composite type:key id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));
      const entity = await makeClient().contexts.get("user:u-123");
      expect(entity).toBeInstanceOf(Context);
      expect(entity.type).toBe("user");
      expect(entity.key).toBe("u-123");
    });

    it("accepts separate type and key args", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));
      const entity = await makeClient().contexts.get("user", "u-123");
      expect(entity.type).toBe("user");
      expect(entity.key).toBe("u-123");
    });

    it("uses the composite id in the request URL", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));
      await makeClient().contexts.get("user:u-123");
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toContain("/api/v1/contexts/user%3Au-123");
    });

    it("splits only on the first colon for keys containing colons", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: SAMPLE_CONTEXT }));
      await makeClient().contexts.get("user:a:b:c");
      const req: Request = mockFetch.mock.calls[0][0];
      expect(req.url).toContain(encodeURIComponent("user:a:b:c"));
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().contexts.get("user:missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplNotFoundError when the body has no data", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await expect(makeClient().contexts.get("user:missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws when the composite id is missing a colon", async () => {
      await expect(makeClient().contexts.get("user")).rejects.toThrow("type:key");
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().contexts.get("user:u-1")).rejects.toThrow(SmplConnectionError);
    });
  });

  describe("delete()", () => {
    it("deletes by composite id", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(makeClient().contexts.delete("user:u-123")).resolves.toBeUndefined();
    });

    it("deletes by separate type and key", async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(makeClient().contexts.delete("user", "u-123")).resolves.toBeUndefined();
    });

    it("resolves on 200", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}, 200));
      await expect(makeClient().contexts.delete("user:u-1")).resolves.toBeUndefined();
    });

    it("throws SmplNotFoundError on 404", async () => {
      mockFetch.mockResolvedValueOnce(textResponse("Not found", 404));
      await expect(makeClient().contexts.delete("user:missing")).rejects.toThrow(SmplNotFoundError);
    });

    it("throws SmplConnectionError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(makeClient().contexts.delete("user:u-1")).rejects.toThrow(SmplConnectionError);
    });
  });
});

// ===========================================================================
// PlatformClient construction + lifecycle
// ===========================================================================

describe("PlatformClient", () => {
  it("exposes environments, services, contexts, contextTypes", () => {
    const client = makeClient();
    expect(client.environments).toBeInstanceOf(EnvironmentsClient);
    expect(client.services).toBeInstanceOf(ServicesClient);
    expect(client.contexts).toBeInstanceOf(ContextsClient);
    expect(client.contextTypes).toBeInstanceOf(ContextTypesClient);
  });

  it("standalone construction owns its own context buffer", () => {
    const client = makeClient();
    expect(client._contextBuffer).toBeInstanceOf(ContextRegistrationBuffer);
    expect(client.contexts._buffer).toBe(client._contextBuffer);
  });

  it("standalone construction strips a trailing slash from a supplied baseUrl", async () => {
    const client = new PlatformClient({
      apiKey: API_KEY,
      baseUrl: "http://app.test///",
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.environments.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.url).toBe("http://app.test/api/v1/environments");
  });

  it("standalone construction sends the Authorization bearer header", async () => {
    const client = makeClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.environments.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("standalone construction merges extraHeaders without overriding Authorization", async () => {
    const client = new PlatformClient({
      apiKey: API_KEY,
      baseDomain: "test",
      scheme: "http",
      extraHeaders: { "X-Tenant": "acme", Authorization: "should-be-overridden" },
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.environments.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.headers.get("x-tenant")).toBe("acme");
    expect(req.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it("wired construction borrows the supplied app transport and buffer", async () => {
    const appTransport = createClient<import("../../../src/generated/app.d.ts").paths>({
      baseUrl: "http://app.wired",
      headers: { Authorization: "Bearer wired" },
    });
    const buffer = new ContextRegistrationBuffer();
    const client = new PlatformClient({ appTransport, contextBuffer: buffer });
    expect(client._contextBuffer).toBe(buffer);
    expect(client.contexts._buffer).toBe(buffer);

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await client.environments.list();
    const req: Request = mockFetch.mock.calls[0][0];
    expect(req.url).toBe("http://app.wired/api/v1/environments");
  });

  it("close() is a no-op that does not throw", () => {
    expect(() => makeClient().close()).not.toThrow();
  });
});
