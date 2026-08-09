/**
 * Shared test helpers for the flags module.
 *
 * The fused {@link FlagsClient} supports two construction shapes:
 *
 * - **Wired** — `new FlagsClient({ parent, transport, contexts, metrics })`.
 *   The parent must implement the full {@link FlagsParent} interface
 *   (`_environment`, `_service`, `_ensureStarted()`, `_ensureStream()`).
 * - **Standalone** — `new FlagsClient({ apiKey, environment, baseUrl, ... })`.
 *   It builds its own flags transport, its own contexts seam, and (on first
 *   live use) opens and owns its own live event stream.
 *
 * These helpers cover both shapes. HTTP is stubbed by overriding
 * `globalThis.fetch`; the wired transport is a real `openapi-fetch` client
 * pointed at a fake base URL so it exercises the same request path as
 * production.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { vi } from "vitest";
import createClient from "openapi-fetch";
import { FlagsClient, type FlagsParent } from "../../../src/flags/client.js";
import type { EventStream } from "../../../src/event_stream.js";

export type WsCallback = (data: Record<string, unknown>) => void;

/** A stand-in for {@link EventStream} that records `on`/`off` and replays. */
export interface MockEventStream {
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  onReconnect: ReturnType<typeof vi.fn>;
  offReconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  connectionStatus: string;
  _listeners: Record<string, WsCallback[]>;
  _emit: (event: string, data: Record<string, unknown>) => void;
  /** Invoke every registered reconnect-refetch callback (simulates a successful reconnect). */
  _fireReconnect: () => void;
}

export function createMockEventStream(): MockEventStream {
  const listeners: Record<string, WsCallback[]> = {};
  const reconnectCallbacks: Array<() => void> = [];
  return {
    on: vi.fn((event: string, cb: WsCallback) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    off: vi.fn((event: string, cb: WsCallback) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter((l) => l !== cb);
      }
    }),
    start: vi.fn(),
    stop: vi.fn(),
    onReconnect: vi.fn((cb: () => void) => {
      reconnectCallbacks.push(cb);
    }),
    offReconnect: vi.fn((cb: () => void) => {
      const idx = reconnectCallbacks.indexOf(cb);
      if (idx !== -1) reconnectCallbacks.splice(idx, 1);
    }),
    connectionStatus: "connected",
    _listeners: listeners,
    _emit: (event: string, data: Record<string, unknown>) => {
      for (const cb of listeners[event] ?? []) cb(data);
    },
    _fireReconnect: () => {
      for (const cb of [...reconnectCallbacks]) cb();
    },
  };
}

/** A stand-in for `client.platform.contexts` — records register/flush calls. */
export interface MockContexts {
  register: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
}

export function createMockContexts(): MockContexts {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

const FLAGS_TEST_BASE = "https://flags.test.smplkit.com";

/** Build a real openapi-fetch flags transport pointed at a fake base URL. */
export function makeFlagsTransport(): any {
  return createClient<import("../../../src/generated/flags.d.ts").paths>({
    baseUrl: FLAGS_TEST_BASE,
    headers: { Authorization: "Bearer sk_test", Accept: "application/json" },
  });
}

export interface WiredHarness {
  client: FlagsClient;
  ws: MockEventStream;
  contexts: MockContexts;
  ensureStarted: ReturnType<typeof vi.fn>;
  ensureStream: ReturnType<typeof vi.fn>;
  parent: FlagsParent;
}

/**
 * Build a wired {@link FlagsClient} with a full {@link FlagsParent} mock,
 * a mock live event stream, and a mock contexts seam.
 */
export function makeWiredClient(
  options: {
    environment?: string | null;
    service?: string | null;
    metrics?: any;
    contexts?: MockContexts | null;
  } = {},
): WiredHarness {
  const ws = createMockEventStream();
  const contexts = options.contexts === null ? null : (options.contexts ?? createMockContexts());
  const ensureStarted = vi.fn();
  const ensureStream = vi.fn(() => ws as unknown as EventStream);
  const parent: FlagsParent = {
    _environment: options.environment ?? "staging",
    _service: options.service ?? null,
    _ensureStarted: ensureStarted,
    _ensureStream: ensureStream,
  };
  const client = new FlagsClient({
    parent,
    transport: makeFlagsTransport(),
    contexts: contexts as any,
    metrics: options.metrics ?? null,
  });
  return { client, ws, contexts: contexts as MockContexts, ensureStarted, ensureStream, parent };
}

/** JSON:API-shaped 200 response. */
export function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Plain text response with an explicit status. */
export function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

/** Build a JSON:API flag list response from compact flag specs. */
export function flagListResponse(
  flags: Array<{
    id: string;
    type?: string;
    default?: unknown;
    environments?: Record<string, unknown>;
    values?: Array<{ name: string; value: unknown }> | null;
    name?: string;
    description?: string | null;
  }>,
): Response {
  return jsonResponse({
    data: flags.map((f) => ({
      id: f.id,
      type: "flag",
      attributes: {
        name: f.name ?? f.id,
        type: f.type ?? "BOOLEAN",
        default: f.default ?? false,
        values: f.values ?? [],
        description: f.description ?? null,
        environments: f.environments ?? {},
      },
    })),
  });
}

/** Build a JSON:API single-flag response from a compact flag spec. */
export function flagSingleResponse(flag: {
  id: string;
  type?: string;
  default?: unknown;
  environments?: Record<string, unknown>;
  values?: Array<{ name: string; value: unknown }> | null;
  name?: string;
  description?: string | null;
}): Response {
  return jsonResponse({
    data: {
      id: flag.id,
      type: "flag",
      attributes: {
        name: flag.name ?? flag.id,
        type: flag.type ?? "BOOLEAN",
        default: flag.default ?? false,
        values: flag.values ?? [],
        description: flag.description ?? null,
        environments: flag.environments ?? {},
      },
    },
  });
}
