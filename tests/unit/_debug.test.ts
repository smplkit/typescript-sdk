/**
 * Tests for the internal SMPLKIT_DEBUG module.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// 1. _parseDebugEnv — env-string parsing (no module reload needed)
// ---------------------------------------------------------------------------

describe("_parseDebugEnv", () => {
  let parseDebugEnv: (value: string) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/_debug.js");
    parseDebugEnv = mod._parseDebugEnv;
  });

  it.each(["1", "true", "TRUE", "True", "yes", "YES", "Yes"])(
    "returns true for truthy value: %s",
    (value) => {
      expect(parseDebugEnv(value)).toBe(true);
    },
  );

  it.each(["0", "false", "FALSE", "no", "NO", "", "  ", "2", "on", "enable"])(
    "returns false for falsy value: %s",
    (value) => {
      expect(parseDebugEnv(value)).toBe(false);
    },
  );

  it("strips leading and trailing whitespace before checking", () => {
    expect(parseDebugEnv("  1  ")).toBe(true);
    expect(parseDebugEnv("  true  ")).toBe(true);
    expect(parseDebugEnv("  false  ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. enableDebug() — programmatic activation
// ---------------------------------------------------------------------------

describe("enableDebug", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enables debug when called, even if SMPLKIT_DEBUG is unset", async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "");
    vi.resetModules();
    const mod = await import("../../src/_debug.js");
    expect(mod.isDebugEnabled()).toBe(false);
    mod.enableDebug();
    expect(mod.isDebugEnabled()).toBe(true);
  });

  it("allows debug() to emit output after enableDebug() is called", async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "");
    vi.resetModules();
    const mod = await import("../../src/_debug.js");
    mod.enableDebug();
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mod.debug("lifecycle", "enabled programmatically");
    expect(write).toHaveBeenCalled();
    write.mockRestore();
  });

  it("is idempotent — calling twice keeps debug enabled", async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "");
    vi.resetModules();
    const mod = await import("../../src/_debug.js");
    mod.enableDebug();
    mod.enableDebug();
    expect(mod.isDebugEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. isDebugEnabled() — reads module-level cache
// ---------------------------------------------------------------------------

describe("isDebugEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns false when SMPLKIT_DEBUG is unset", async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "");
    vi.resetModules();
    const { isDebugEnabled } = await import("../../src/_debug.js");
    expect(isDebugEnabled()).toBe(false);
  });

  it("returns true when SMPLKIT_DEBUG=1", async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "1");
    vi.resetModules();
    const { isDebugEnabled } = await import("../../src/_debug.js");
    expect(isDebugEnabled()).toBe(true);
  });

  it("returns true when SMPLKIT_DEBUG=true", async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "true");
    vi.resetModules();
    const { isDebugEnabled } = await import("../../src/_debug.js");
    expect(isDebugEnabled()).toBe(true);
  });

  it("returns true when SMPLKIT_DEBUG=yes", async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "yes");
    vi.resetModules();
    const { isDebugEnabled } = await import("../../src/_debug.js");
    expect(isDebugEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. debug() — no-op when disabled
// ---------------------------------------------------------------------------

describe("debug() — no-op when disabled", () => {
  let debugMod: typeof import("../../src/_debug.js");

  beforeEach(async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "");
    vi.resetModules();
    debugMod = await import("../../src/_debug.js");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("writes nothing to stderr when disabled", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    debugMod.debug("websocket", "this should not appear");
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("writes nothing to stdout when disabled", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    debugMod.debug("lifecycle", "silent");
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 4. debug() — output format when enabled
// ---------------------------------------------------------------------------

describe("debug() — output format when enabled", () => {
  let debugMod: typeof import("../../src/_debug.js");

  beforeEach(async () => {
    vi.stubEnv("SMPLKIT_DEBUG", "1");
    vi.resetModules();
    debugMod = await import("../../src/_debug.js");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("writes to stderr", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    debugMod.debug("websocket", "connected to wss://example.com");
    expect(write).toHaveBeenCalled();
    write.mockRestore();
  });

  it("output starts with [smplkit:{subsystem}]", () => {
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    debugMod.debug("websocket", "some message");
    expect(output).toMatch(/^\[smplkit:websocket\]/);
    vi.restoreAllMocks();
  });

  it("output includes the subsystem tag", () => {
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    debugMod.debug("api", "GET /api/v1/loggers");
    expect(output).toContain("[smplkit:api]");
    vi.restoreAllMocks();
  });

  it("output includes the message", () => {
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    debugMod.debug("lifecycle", "SmplClient.close() called");
    expect(output).toContain("SmplClient.close() called");
    vi.restoreAllMocks();
  });

  it("output ends with a newline", () => {
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    debugMod.debug("adapter", "applying level DEBUG");
    expect(output).toMatch(/\n$/);
    vi.restoreAllMocks();
  });

  it("output contains an ISO-8601 timestamp with T", () => {
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    debugMod.debug("resolution", "resolving level");
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    vi.restoreAllMocks();
  });

  it("output structure is [smplkit:{subsystem}] {timestamp} {message}\\n", () => {
    let output = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
    debugMod.debug("discovery", "new logger: foo.bar");
    const parts = output.trim().split(" ");
    expect(parts[0]).toBe("[smplkit:discovery]");
    expect(parts[1]).toContain("T"); // ISO-8601 timestamp contains T
    expect(output.trim().endsWith("new logger: foo.bar")).toBe(true);
    vi.restoreAllMocks();
  });

  it("does not write to stdout", () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    debugMod.debug("api", "GET /test");
    expect(stdoutWrite).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each(["lifecycle", "websocket", "api", "discovery", "resolution", "adapter", "registration"])(
    "all subsystems render correctly: %s",
    (subsystem) => {
      let output = "";
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        output += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      });
      debugMod.debug(subsystem, "test");
      expect(output).toContain(`[smplkit:${subsystem}]`);
      vi.restoreAllMocks();
    },
  );
});
