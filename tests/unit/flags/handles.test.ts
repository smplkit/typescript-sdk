/**
 * Typed flag handles: the async declaration methods on FlagsClient
 * (`booleanFlag` / `stringFlag` / `numberFlag` / `jsonFlag`) and the typed
 * `.get()` coercion on each {@link Flag} subclass.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Flag, BooleanFlag, StringFlag, NumberFlag, JsonFlag } from "../../../src/flags/models.js";
import { makeWiredClient, flagListResponse } from "./_helpers.js";
import type { FlagsClient } from "../../../src/flags/client.js";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedStore(client: FlagsClient, store: Record<string, Record<string, unknown>>): void {
  (client as any)._flagStore = store;
  (client as any)._connected = true;
}

function makeHandle(client: FlagsClient, type: string, id: string, def: unknown): any {
  const fields = {
    id,
    name: id,
    type,
    default: def,
    values: null,
    description: null,
    environments: {},
    createdAt: null,
    updatedAt: null,
  };
  switch (type) {
    case "STRING":
      return new StringFlag(client as any, fields as any);
    case "NUMERIC":
      return new NumberFlag(client as any, fields as any);
    case "JSON":
      return new JsonFlag(client as any, fields as any);
    default:
      return new BooleanFlag(client as any, fields as any);
  }
}

describe("Typed flag handle declarations", () => {
  it("booleanFlag() connects lazily and returns a BooleanFlag", async () => {
    const { client, ensureStarted } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    const handle = await client.booleanFlag("b", false);
    expect(handle).toBeInstanceOf(BooleanFlag);
    expect(handle.id).toBe("b");
    expect(handle.default).toBe(false);
    expect(ensureStarted).toHaveBeenCalled();
  });

  it("stringFlag() returns a StringFlag", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    expect(await client.stringFlag("s", "default")).toBeInstanceOf(StringFlag);
  });

  it("numberFlag() returns a NumberFlag", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    expect(await client.numberFlag("n", 0)).toBeInstanceOf(NumberFlag);
  });

  it("jsonFlag() returns a JsonFlag", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    expect(await client.jsonFlag("j", {})).toBeInstanceOf(JsonFlag);
  });

  it("records the declaration on the discovery buffer", async () => {
    const { client } = makeWiredClient({ service: "svc", environment: "prod" });
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    await client.booleanFlag("dark-mode", true);
    const batch = (client as any)._buffer.peek();
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      id: "dark-mode",
      type: "BOOLEAN",
      default: true,
      service: "svc",
      environment: "prod",
    });
  });

  it("registers the handle so it is reachable for live updates", async () => {
    const { client } = makeWiredClient();
    mockFetch.mockResolvedValueOnce(flagListResponse([]));
    const handle = await client.stringFlag("theme", "light");
    expect((client as any)._handles["theme"]).toBe(handle);
  });
});

describe("BooleanFlag.get()", () => {
  it("returns the stored boolean when the type matches", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "my-flag": {
        id: "my-flag",
        default: true,
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    const h = makeHandle(client, "BOOLEAN", "my-flag", false);
    expect(h.get()).toBe(true);
    expect(typeof h.get()).toBe("boolean");
  });

  it("returns the code default on a type mismatch", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "my-flag": {
        id: "my-flag",
        default: "not a bool",
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    expect(makeHandle(client, "BOOLEAN", "my-flag", false).get()).toBe(false);
  });
});

describe("StringFlag.get()", () => {
  it("returns the stored string when the type matches", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      color: {
        id: "color",
        default: "blue",
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    const h = makeHandle(client, "STRING", "color", "red");
    expect(h.get()).toBe("blue");
    expect(typeof h.get()).toBe("string");
  });

  it("returns the code default on a type mismatch", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      color: { id: "color", default: 42, environments: { staging: { enabled: true, rules: [] } } },
    });
    expect(makeHandle(client, "STRING", "color", "red").get()).toBe("red");
  });
});

describe("NumberFlag.get()", () => {
  it("returns the stored number when the type matches", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      retries: {
        id: "retries",
        default: 5,
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    const h = makeHandle(client, "NUMERIC", "retries", 3);
    expect(h.get()).toBe(5);
    expect(typeof h.get()).toBe("number");
  });

  it("returns the code default on a type mismatch", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      retries: {
        id: "retries",
        default: "not a number",
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    expect(makeHandle(client, "NUMERIC", "retries", 3).get()).toBe(3);
  });
});

describe("JsonFlag.get()", () => {
  it("returns the stored object when the type matches", () => {
    const { client } = makeWiredClient();
    const theme = { mode: "dark", accent: "#fff" };
    seedStore(client, {
      theme: {
        id: "theme",
        default: theme,
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    expect(makeHandle(client, "JSON", "theme", { mode: "light" }).get()).toEqual(theme);
  });

  it("returns the code default on a string mismatch", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      theme: {
        id: "theme",
        default: "not an object",
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    const def = { mode: "light" };
    expect(makeHandle(client, "JSON", "theme", def).get()).toEqual(def);
  });

  it("returns the code default on an array mismatch", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      theme: {
        id: "theme",
        default: [1, 2, 3],
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    const def = { mode: "light" };
    expect(makeHandle(client, "JSON", "theme", def).get()).toEqual(def);
  });

  it("returns the code default on a null mismatch", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      theme: {
        id: "theme",
        default: null,
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    const def = { mode: "light" };
    expect(makeHandle(client, "JSON", "theme", def).get()).toEqual(def);
  });
});

describe("Flag.get() (base class)", () => {
  it("evaluates via the base Flag class directly", () => {
    const { client } = makeWiredClient();
    seedStore(client, {
      "my-flag": {
        id: "my-flag",
        default: "hello",
        environments: { staging: { enabled: true, rules: [] } },
      },
    });
    const flag = new Flag(client as any, {
      id: "my-flag",
      name: "My Flag",
      type: "STRING",
      default: "fallback",
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    expect(flag.get()).toBe("hello");
  });

  it("returns the code default when the flag is not in the store", () => {
    const { client } = makeWiredClient();
    seedStore(client, {});
    expect(makeHandle(client, "BOOLEAN", "nonexistent", false).get()).toBe(false);
  });

  it("throws when the client is null", () => {
    const flag = new Flag(null, {
      id: "my-flag",
      name: "My Flag",
      type: "BOOLEAN",
      default: false,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    expect(() => flag.get()).toThrow(/cannot evaluate/);
  });

  it("throws when the id is null (unsaved flag)", () => {
    const { client } = makeWiredClient();
    const flag = new Flag(client as any, {
      id: null,
      name: "Unsaved Flag",
      type: "BOOLEAN",
      default: false,
      values: [],
      description: null,
      environments: {},
      createdAt: null,
      updatedAt: null,
    });
    expect(() => flag.get()).toThrow(/Flag has no id/);
  });
});
