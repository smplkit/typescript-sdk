import { describe, it, expect } from "vitest";
import { LogLevel } from "../../../src/logging/types.js";

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
