/**
 * Demo setup helper for the logging runtime showcase.
 *
 * Creates and configures demo loggers and groups so the runtime showcase
 * can run standalone.  Imported by `logging_runtime_showcase.ts`.
 */

import { SmplClient, LogLevel } from "@smplkit/sdk";
import type { Logger, LogGroup } from "@smplkit/sdk";

/**
 * Create and configure demo loggers and groups for the runtime showcase.
 *
 * Creates:
 *   - Log group: "sql" (SQL Loggers)
 *   - Logger: "sqlalchemy.engine" (managed, assigned to sql group)
 *   - Logger: "httpx" (managed)
 *   - Logger: "celery.worker" (managed)
 *
 * Returns `{ loggers, groups }` for cleanup.
 */
export async function setupDemoLoggers(
  client: SmplClient,
): Promise<{ loggers: Logger[]; groups: LogGroup[] }> {
  // Pre-cleanup: delete any loggers and groups from previous runs.
  // Server assigns IDs from the logger name, not the client-provided key.
  for (const id of ["Sqlalchemy.Engine", "HTTPX Client", "Celery Worker"]) {
    try { await client.logging.delete(id); } catch { /* not present — ignore */ }
  }
  try {
    const existingGroups = await client.logging.listGroups();
    for (const g of existingGroups) {
      if (g.name === "SQL Loggers") {
        try { await client.logging.deleteGroup(g.id); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // 1. Create log group: sql
  const sqlGroup = client.logging.newGroup("sql", { name: "SQL Loggers" });
  sqlGroup.setLevel(LogLevel.WARN);
  sqlGroup.setEnvironmentLevel("production", LogLevel.ERROR);
  sqlGroup.setEnvironmentLevel("staging", LogLevel.DEBUG);
  await sqlGroup.save();

  // 2. Create logger: sqlalchemy.engine (assigned to sql group)
  const sqlLogger = client.logging.new("sqlalchemy.engine", { managed: true });
  sqlLogger.setLevel(LogLevel.WARN);
  sqlLogger.setEnvironmentLevel("production", LogLevel.ERROR);
  sqlLogger.group = sqlGroup.id;
  await sqlLogger.save();

  // 3. Create logger: httpx
  const httpxLogger = client.logging.new("httpx", {
    name: "HTTPX Client",
    managed: true,
  });
  httpxLogger.setLevel(LogLevel.INFO);
  httpxLogger.setEnvironmentLevel("production", LogLevel.WARN);
  await httpxLogger.save();

  // 4. Create logger: celery.worker
  const celeryLogger = client.logging.new("celery.worker", {
    name: "Celery Worker",
    managed: true,
  });
  celeryLogger.setLevel(LogLevel.INFO);
  celeryLogger.setEnvironmentLevel("production", LogLevel.WARN);
  celeryLogger.setEnvironmentLevel("staging", LogLevel.DEBUG);
  await celeryLogger.save();

  return {
    loggers: [sqlLogger, httpxLogger, celeryLogger],
    groups: [sqlGroup],
  };
}

/**
 * Delete the demo loggers and groups created by setupDemoLoggers.
 */
export async function teardownDemoLoggers(
  client: SmplClient,
  demo: { loggers: Logger[]; groups: LogGroup[] },
): Promise<void> {
  // Unassign loggers from groups and delete them
  for (const logger of demo.loggers) {
    try {
      if (logger.group) {
        logger.group = null;
        await logger.save();
      }
      await client.logging.delete(logger.id);
    } catch {
      // ignore
    }
  }

  // Delete groups
  for (const group of demo.groups) {
    try {
      await client.logging.deleteGroup(group.id);
    } catch {
      // ignore
    }
  }
}
