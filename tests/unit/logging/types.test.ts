import { describe, it, expect } from "vitest";
import {
  LogLevel,
  LoggerSource,
  LoggerEnvironment,
  convertLoggerEnvironments,
} from "../../../src/logging/types.js";

describe("LogLevel", () => {
  it("should define TRACE", () => {
    expect(LogLevel.TRACE).toBe("TRACE");
  });

  it("should define DEBUG", () => {
    expect(LogLevel.DEBUG).toBe("DEBUG");
  });

  it("should define INFO", () => {
    expect(LogLevel.INFO).toBe("INFO");
  });

  it("should define WARN", () => {
    expect(LogLevel.WARN).toBe("WARN");
  });

  it("should define ERROR", () => {
    expect(LogLevel.ERROR).toBe("ERROR");
  });

  it("should define FATAL", () => {
    expect(LogLevel.FATAL).toBe("FATAL");
  });

  it("should define SILENT", () => {
    expect(LogLevel.SILENT).toBe("SILENT");
  });

  it("should have exactly 7 members", () => {
    const values = Object.values(LogLevel);
    expect(values).toHaveLength(7);
  });

  it("should be usable as string values", () => {
    const level: string = LogLevel.INFO;
    expect(level).toBe("INFO");
  });
});

describe("LoggerSource", () => {
  it("should set name, service, environment, and resolvedLevel", () => {
    const src = new LoggerSource("sqlalchemy.engine", {
      service: "api",
      environment: "production",
      resolvedLevel: LogLevel.WARN,
    });
    expect(src.name).toBe("sqlalchemy.engine");
    expect(src.service).toBe("api");
    expect(src.environment).toBe("production");
    expect(src.resolvedLevel).toBe(LogLevel.WARN);
  });

  it("should default level to null when not provided", () => {
    const src = new LoggerSource("app.server", {
      service: "app",
      environment: "staging",
      resolvedLevel: LogLevel.DEBUG,
    });
    expect(src.level).toBeNull();
  });

  it("should accept explicit level", () => {
    const src = new LoggerSource("app.server", {
      service: "app",
      environment: "staging",
      resolvedLevel: LogLevel.WARN,
      level: LogLevel.ERROR,
    });
    expect(src.level).toBe(LogLevel.ERROR);
  });

  it("should accept null level explicitly", () => {
    const src = new LoggerSource("app.server", {
      service: "app",
      environment: "staging",
      resolvedLevel: LogLevel.INFO,
      level: null,
    });
    expect(src.level).toBeNull();
  });
});

describe("convertLoggerEnvironments", () => {
  it("returns empty object for null/undefined input", () => {
    expect(convertLoggerEnvironments(null)).toEqual({});
    expect(convertLoggerEnvironments(undefined)).toEqual({});
  });

  it("preserves existing LoggerEnvironment instances unchanged", () => {
    const env = new LoggerEnvironment({ level: LogLevel.WARN });
    const result = convertLoggerEnvironments({ production: env });
    expect(result.production).toBe(env);
  });

  it("constructs LoggerEnvironment from wire object with valid level", () => {
    const result = convertLoggerEnvironments({ production: { level: "WARN" } });
    expect(result.production).toBeInstanceOf(LoggerEnvironment);
    expect(result.production.level).toBe(LogLevel.WARN);
  });

  it("returns LoggerEnvironment with null level when wire object has missing level", () => {
    const result = convertLoggerEnvironments({ production: {} });
    expect(result.production).toBeInstanceOf(LoggerEnvironment);
    expect(result.production.level).toBeNull();
  });

  it("returns LoggerEnvironment with null level when wire object has invalid level string", () => {
    const result = convertLoggerEnvironments({ production: { level: "NOT_A_LEVEL" } });
    expect(result.production).toBeInstanceOf(LoggerEnvironment);
    expect(result.production.level).toBeNull();
  });

  it("returns LoggerEnvironment with null level when wire object level is non-string", () => {
    const result = convertLoggerEnvironments({ production: { level: 42 } });
    expect(result.production).toBeInstanceOf(LoggerEnvironment);
    expect(result.production.level).toBeNull();
  });

  it("returns LoggerEnvironment for non-object env data (string)", () => {
    const result = convertLoggerEnvironments({ production: "WARN" as unknown as object });
    expect(result.production).toBeInstanceOf(LoggerEnvironment);
    expect(result.production.level).toBeNull();
  });

  it("returns LoggerEnvironment for non-object env data (null)", () => {
    const result = convertLoggerEnvironments({ production: null as unknown as object });
    expect(result.production).toBeInstanceOf(LoggerEnvironment);
    expect(result.production.level).toBeNull();
  });

  it("returns LoggerEnvironment for non-object env data (number)", () => {
    const result = convertLoggerEnvironments({ production: 5 as unknown as object });
    expect(result.production).toBeInstanceOf(LoggerEnvironment);
    expect(result.production.level).toBeNull();
  });
});
