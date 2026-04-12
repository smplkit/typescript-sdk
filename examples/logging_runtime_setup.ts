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
  for (const id of ["sqlalchemy.engine", "httpx", "celery.worker"]) {
    try { await client.logging.management.delete(id); } catch { /* not present — ignore */ }
  }
  try {
    const existingGroups = await client.logging.management.listGroups();
    for (const g of existingGroups) {
      if (g.name === "SQL Loggers") {
        try { await client.logging.management.deleteGroup(g.id); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // 1. Create log group: sql
  const sqlGroup = client.logging.management.newGroup("sql", { name: "SQL Loggers" });
  sqlGroup.setLevel(LogLevel.WARN);
  sqlGroup.setEnvironmentLevel("production", LogLevel.ERROR);
  sqlGroup.setEnvironmentLevel("staging", LogLevel.DEBUG);
  await sqlGroup.save();

  // 2. Create logger: sqlalchemy.engine (assigned to sql group)
  const sqlLogger = client.logging.management.new("sqlalchemy.engine", { managed: true });
  sqlLogger.setLevel(LogLevel.WARN);
  sqlLogger.setEnvironmentLevel("production", LogLevel.ERROR);
  sqlLogger.group = sqlGroup.id;
  await sqlLogger.save();

  // 3. Create logger: httpx
  const httpxLogger = client.logging.management.new("httpx", {
    name: "HTTPX Client",
    managed: true,
  });
  httpxLogger.setLevel(LogLevel.INFO);
  httpxLogger.setEnvironmentLevel("production", LogLevel.WARN);
  await httpxLogger.save();

  // 4. Create logger: celery.worker
  const celeryLogger = client.logging.management.new("celery.worker", {
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
      await client.logging.management.delete(logger.id);
    } catch {
      // ignore
    }
  }

  // Delete groups
  for (const group of demo.groups) {
    try {
      await client.logging.management.deleteGroup(group.id);
    } catch {
      // ignore
    }
  }
}
