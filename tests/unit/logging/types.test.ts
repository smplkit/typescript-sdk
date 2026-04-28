import { describe, it, expect } from "vitest";
import { LogLevel, LoggerSource } from "../../../src/logging/types.js";

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
      resolved_level: LogLevel.WARN,
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
      resolved_level: LogLevel.DEBUG,
    });
    expect(src.level).toBeNull();
  });

  it("should accept explicit level", () => {
    const src = new LoggerSource("app.server", {
      service: "app",
      environment: "staging",
      resolved_level: LogLevel.WARN,
      level: LogLevel.ERROR,
    });
    expect(src.level).toBe(LogLevel.ERROR);
  });

  it("should accept null level explicitly", () => {
    const src = new LoggerSource("app.server", {
      service: "app",
      environment: "staging",
      resolved_level: LogLevel.INFO,
      level: null,
    });
    expect(src.level).toBeNull();
  });
});
