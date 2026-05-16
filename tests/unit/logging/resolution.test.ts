/**
 * Tests for the level resolution algorithm. Mirrors python-sdk's
 * tests/unit/logging/test_resolution.py — every step of the chain,
 * dot-notation ancestry, cycle protection, fallback, and the
 * debug-source detector.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveLevel,
  _findResolutionSource,
  type GroupCacheEntry,
  type LoggerCacheEntry,
} from "../../../src/logging/_resolution.js";

// ---------------------------------------------------------------------------
// Basic resolution: env override, base level, fallback
// ---------------------------------------------------------------------------

describe("resolveLevel — basic", () => {
  it("logger env override wins over base level", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: "DEBUG",
        group: null,
        managed: true,
        environments: { production: { level: "ERROR" } },
      },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, {})).toBe("ERROR");
  });

  it("falls through to logger base level when no env override", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: "DEBUG",
        group: null,
        managed: true,
        environments: {},
      },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, {})).toBe("DEBUG");
  });

  it("ignores env override for a different environment", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: "DEBUG",
        group: null,
        managed: true,
        environments: { staging: { level: "TRACE" } },
      },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, {})).toBe("DEBUG");
  });

  it("falls back to INFO when nothing matches", () => {
    expect(resolveLevel("unknown.logger", "production", {}, {})).toBe("INFO");
  });
});

// ---------------------------------------------------------------------------
// Group chain: env on group, group base, nested groups, cycle protection
// ---------------------------------------------------------------------------

describe("resolveLevel — group chain", () => {
  it("uses group env override when logger has no level of its own", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: null,
        group: "group-1",
        managed: true,
        environments: {},
      },
    };
    const groups: Record<string, GroupCacheEntry> = {
      "group-1": {
        level: "WARN",
        group: null,
        environments: { production: { level: "ERROR" } },
      },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, groups)).toBe("ERROR");
  });

  it("uses group base level when no group env override", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: null,
        group: "group-1",
        managed: true,
        environments: {},
      },
    };
    const groups: Record<string, GroupCacheEntry> = {
      "group-1": { level: "WARN", group: null, environments: {} },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, groups)).toBe("WARN");
  });

  it("walks nested group chain to find a level", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: null,
        group: "group-child",
        managed: true,
        environments: {},
      },
    };
    const groups: Record<string, GroupCacheEntry> = {
      "group-child": { level: null, group: "group-parent", environments: {} },
      "group-parent": { level: "FATAL", group: null, environments: {} },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, groups)).toBe("FATAL");
  });

  it("does not infinite-loop on a group cycle", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: null,
        group: "group-a",
        managed: true,
        environments: {},
      },
    };
    const groups: Record<string, GroupCacheEntry> = {
      "group-a": { level: null, group: "group-b", environments: {} },
      "group-b": { level: null, group: "group-a", environments: {} },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, groups)).toBe("INFO");
  });
});

// ---------------------------------------------------------------------------
// Dot-notation ancestry
// ---------------------------------------------------------------------------

describe("resolveLevel — dot-notation ancestry", () => {
  it("inherits from a parent logger by dot prefix", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example": { level: "WARN", group: null, managed: true, environments: {} },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, {})).toBe("WARN");
  });

  it("inherits from a grandparent logger by dot prefix", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      com: { level: "ERROR", group: null, managed: true, environments: {} },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, {})).toBe("ERROR");
  });

  it("closest ancestor wins over more distant ancestor", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      com: { level: "ERROR", group: null, managed: true, environments: {} },
      "com.example": { level: "DEBUG", group: null, managed: true, environments: {} },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, {})).toBe("DEBUG");
  });

  it("group on the original logger beats dot-notation ancestor", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example.sql": {
        level: null,
        group: "group-1",
        managed: true,
        environments: {},
      },
      "com.example": { level: "DEBUG", group: null, managed: true, environments: {} },
    };
    const groups: Record<string, GroupCacheEntry> = {
      "group-1": { level: "ERROR", group: null, environments: {} },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, groups)).toBe("ERROR");
  });

  it("ancestor env override applies during walk", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example": {
        level: "DEBUG",
        group: null,
        managed: true,
        environments: { production: { level: "FATAL" } },
      },
    };
    expect(resolveLevel("com.example.sql", "production", loggers, {})).toBe("FATAL");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("resolveLevel — edge cases", () => {
  it("returns fallback when logger is not in cache", () => {
    expect(resolveLevel("nonexistent", "prod", {}, {})).toBe("INFO");
  });

  it("returns fallback when group id is not in cache", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example": {
        level: null,
        group: "missing-group-id",
        managed: true,
        environments: {},
      },
    };
    expect(resolveLevel("com.example", "prod", loggers, {})).toBe("INFO");
  });

  it("treats null environments as empty", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      test: { level: "WARN", group: null, managed: true, environments: null },
    };
    expect(resolveLevel("test", "prod", loggers, {})).toBe("WARN");
  });

  it("treats environments entry that's not an object as empty", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      test: {
        level: "WARN",
        group: null,
        managed: true,
        // Defensive — server should never send this shape, but resolution
        // must not throw if it does.
        environments: { prod: null },
      },
    };
    expect(resolveLevel("test", "prod", loggers, {})).toBe("WARN");
  });

  it("treats env entry with null level as no override", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      test: {
        level: "WARN",
        group: null,
        managed: true,
        environments: { prod: { level: null } },
      },
    };
    expect(resolveLevel("test", "prod", loggers, {})).toBe("WARN");
  });
});

// ---------------------------------------------------------------------------
// _findResolutionSource (debug-only source detector)
// ---------------------------------------------------------------------------

describe("_findResolutionSource", () => {
  const LOGGERS: Record<string, LoggerCacheEntry> = {
    "with.env": {
      level: "DEBUG",
      group: null,
      environments: { production: { level: "ERROR" } },
    },
    "with.base": { level: "WARN", group: null, environments: {} },
    "with.group": { level: null, group: "g1", environments: {} },
    "no.resolution": { level: null, group: null, environments: {} },
  };
  const GROUPS: Record<string, GroupCacheEntry> = {
    g1: { level: "DEBUG", group: null, environments: {} },
  };

  it("identifies env override as the source", () => {
    expect(_findResolutionSource("with.env", "production", LOGGERS, GROUPS)).toBe(
      'env override "production"',
    );
  });

  it("identifies base level as the source", () => {
    expect(_findResolutionSource("with.base", "production", LOGGERS, GROUPS)).toBe("base level");
  });

  it("identifies group as the source", () => {
    expect(_findResolutionSource("with.group", "production", LOGGERS, GROUPS)).toBe('group "g1"');
  });

  it("returns 'unknown' when no resolution succeeds", () => {
    expect(_findResolutionSource("no.resolution", "production", LOGGERS, GROUPS)).toBe("unknown");
  });

  it("returns 'not found' when logger is missing", () => {
    expect(_findResolutionSource("missing", "production", {}, {})).toBe("not found");
  });
});

// ---------------------------------------------------------------------------
// Debug output exercise (covers the isDebugEnabled() branches)
// ---------------------------------------------------------------------------

describe("resolveLevel — debug output", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const originalDebug = process.env.SMPLKIT_DEBUG;

  beforeEach(async () => {
    process.env.SMPLKIT_DEBUG = "1";
    // The _debug module caches the env value at module-load time, so flip
    // the internal flag through the public toggle.
    const mod = await import("../../../src/_debug.js");
    mod.enableDebug();
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalDebug === undefined) delete process.env.SMPLKIT_DEBUG;
    else process.env.SMPLKIT_DEBUG = originalDebug;
  });

  it("emits debug output identifying the resolution source", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      sql: {
        level: "DEBUG",
        group: null,
        environments: { prod: { level: "ERROR" } },
      },
    };
    const result = resolveLevel("sql", "prod", loggers, {});
    expect(result).toBe("ERROR");
    const all = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(all).toContain("[smplkit:resolution]");
    expect(all).toContain("sql");
    expect(all).toContain("ERROR");
  });

  it("emits debug output for fallback case", () => {
    expect(resolveLevel("missing.logger", "prod", {}, {})).toBe("INFO");
    const all = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(all).toContain("system default");
  });

  it("emits debug output for ancestor-resolved case", () => {
    const loggers: Record<string, LoggerCacheEntry> = {
      "com.example": { level: "WARN", group: null, environments: {} },
    };
    expect(resolveLevel("com.example.sql", "prod", loggers, {})).toBe("WARN");
    const all = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(all).toContain('ancestor "com.example"');
  });
});
