/**
 * Smpl Logging SDK Showcase — Management API
 * =============================================
 *
 * Demonstrates the smplkit TypeScript SDK's management plane for Smpl Logging:
 *
 * - Client initialization (`SmplClient`)
 * - Logger CRUD: new() → setLevel → setEnvironmentLevel → save()
 * - Fetch by id: `client.logging.get()`
 * - Mutate and update existing loggers
 * - List and delete loggers
 * - Log Group CRUD: newGroup() → setLevel → save()
 * - Fetch, mutate, list, and delete log groups
 * - Assigning a logger to a group
 * - Level clearing methods: clearLevel, clearEnvironmentLevel, clearAllEnvironmentLevels
 *
 * Most customers will manage loggers via the Console UI. This showcase
 * demonstrates the programmatic equivalent — useful for infrastructure-
 * as-code, CI/CD pipelines, setup scripts, and automated testing.
 *
 * For the runtime experience (start, live updates, change listeners),
 * see `logging_runtime_showcase.ts`.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *       - SMPLKIT_API_KEY environment variable
 *       - ~/.smplkit configuration file (see SDK docs)
 *   - The smplkit Logging service running and reachable
 *
 * Usage:
 *   npx tsx examples/logging_management_showcase.ts
 */

import { SmplClient, LogLevel } from "@smplkit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function section(title: string): void {
  console.log();
  console.log("=".repeat(60));
  console.log(`  ${title}`);
  console.log("=".repeat(60));
  console.log();
}

function step(description: string): void {
  console.log(`  → ${description}`);
}

async function main(): Promise<void> {
  // ======================================================================
  // 1. SDK INITIALIZATION
  // ======================================================================
  section("1. SDK Initialization");

  const client = new SmplClient({
    environment: "production",
    service: "showcase-service",
  });
  step("SmplClient initialized (environment=production)");

  // Pre-cleanup: delete any loggers and groups from previous runs.
  // Server assigns IDs from the logger name, not the client-provided key.
  for (const id of ["Sqlalchemy.Engine", "HTTPX Client", "Celery Worker"]) {
    try { await client.logging.delete(id); } catch { /* not present — ignore */ }
  }
  try {
    const existingGroups = await client.logging.listGroups();
    for (const g of existingGroups) {
      if (["SQL Loggers", "SQL Loggers (Updated)", "Infrastructure Loggers"].includes(g.name)) {
        try { await client.logging.deleteGroup(g.id); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // ======================================================================
  // 2. CREATE LOGGERS
  // ======================================================================
  //
  // client.logging.new(key, options) creates an unsaved Logger.
  // Use sync mutation methods to configure it, then call save() to
  // persist. Mutations (setLevel, setEnvironmentLevel, etc.) are
  // local only — no HTTP until save().
  // ======================================================================

  // ------------------------------------------------------------------
  // 2a. Create a managed logger: sqlalchemy.engine
  // ------------------------------------------------------------------
  section("2a. Create Logger: sqlalchemy.engine");

  const sqlLogger = client.logging.new("sqlalchemy.engine", { managed: true });
  step(`Created unsaved logger: id=${sqlLogger.id}`);
  step(`  managed=${sqlLogger.managed}`);

  // Sync local mutations — no network calls
  sqlLogger.setLevel(LogLevel.WARN);
  step(`Set base level: ${sqlLogger.level}`);

  sqlLogger.setEnvironmentLevel("production", LogLevel.ERROR);
  step(`Set production level: ERROR`);

  sqlLogger.setEnvironmentLevel("staging", LogLevel.DEBUG);
  step(`Set staging level: DEBUG`);

  // Persist — POST (new logger)
  await sqlLogger.save();
  step(`Saved: id=${sqlLogger.id} (POST — new logger)`);

  // ------------------------------------------------------------------
  // 2b. Create a second logger: httpx
  // ------------------------------------------------------------------
  section("2b. Create Logger: httpx");

  const httpxLogger = client.logging.new("httpx", {
    name: "HTTPX Client",
    managed: true,
  });
  httpxLogger.setLevel(LogLevel.INFO);
  httpxLogger.setEnvironmentLevel("production", LogLevel.WARN);
  await httpxLogger.save();
  step(`Created httpx logger: id=${httpxLogger.id}, level=${httpxLogger.level}`);

  // ------------------------------------------------------------------
  // 2c. Create a third logger: celery.worker
  // ------------------------------------------------------------------
  section("2c. Create Logger: celery.worker");

  const celeryLogger = client.logging.new("celery.worker", {
    name: "Celery Worker",
    managed: true,
  });
  celeryLogger.setLevel(LogLevel.INFO);
  celeryLogger.setEnvironmentLevel("production", LogLevel.WARN);
  celeryLogger.setEnvironmentLevel("staging", LogLevel.DEBUG);
  await celeryLogger.save();
  step(`Created celery.worker logger: id=${celeryLogger.id}`);

  // ======================================================================
  // 3. FETCH AND UPDATE A LOGGER
  // ======================================================================
  section("3. Fetch and Update a Logger");

  // Fetch by id (use server-assigned id from save())
  const fetched = await client.logging.get(sqlLogger.id);
  step(`Fetched: id=${fetched.id}, level=${fetched.level}`);
  step(`  environments: ${JSON.stringify(fetched.environments)}`);

  // Mutate and save
  fetched.name = "SQLAlchemy Engine (Updated)";
  fetched.setLevel(LogLevel.INFO);
  fetched.setEnvironmentLevel("development", LogLevel.TRACE);
  await fetched.save();
  step(`Updated: name=${fetched.name}, level=${fetched.level}`);
  step(`  environments: ${JSON.stringify(fetched.environments)}`);

  // ======================================================================
  // 4. LEVEL CLEARING METHODS
  // ======================================================================
  section("4. Level Clearing Methods");

  // clearEnvironmentLevel — remove one environment override
  fetched.clearEnvironmentLevel("development");
  step(`Cleared development override`);
  step(`  environments: ${JSON.stringify(fetched.environments)}`);

  // clearLevel — remove the base level (falls back to inherited/default)
  fetched.clearLevel();
  step(`Cleared base level: level=${fetched.level}`);

  // clearAllEnvironmentLevels — remove all environment overrides
  fetched.clearAllEnvironmentLevels();
  step(`Cleared all environment levels`);
  step(`  environments: ${JSON.stringify(fetched.environments)}`);

  // Restore levels for subsequent sections
  fetched.setLevel(LogLevel.WARN);
  fetched.setEnvironmentLevel("production", LogLevel.ERROR);
  await fetched.save();
  step("Restored levels for subsequent sections");

  // ======================================================================
  // 5. LIST AND DELETE LOGGERS
  // ======================================================================
  section("5a. List All Loggers");

  const loggers = await client.logging.list();
  step(`Total loggers: ${loggers.length}`);
  for (const l of loggers) {
    const groupInfo = l.group ? ` (group: ${l.group})` : "";
    step(`  ${l.id} — level=${l.level}${groupInfo}`);
  }

  // ------------------------------------------------------------------
  section("5b. Delete a Logger");

  await client.logging.delete(celeryLogger.id);
  step("Deleted celery.worker");

  const afterDelete = await client.logging.list();
  step(`Loggers after delete: ${afterDelete.length}`);

  // ======================================================================
  // 6. CREATE LOG GROUPS
  // ======================================================================
  //
  // Log groups organize loggers. A group has its own base level and
  // environment overrides. Loggers assigned to a group inherit the
  // group's level when they don't have their own explicit level.
  // ======================================================================

  section("6a. Create Log Group: sql");

  const sqlGroup = client.logging.newGroup("sql", { name: "SQL Loggers" });
  step(`Created unsaved group: id=${sqlGroup.id}`);

  sqlGroup.setLevel(LogLevel.WARN);
  step(`Set group base level: ${sqlGroup.level}`);

  sqlGroup.setEnvironmentLevel("production", LogLevel.ERROR);
  step("Set group production level: ERROR");

  sqlGroup.setEnvironmentLevel("staging", LogLevel.DEBUG);
  step("Set group staging level: DEBUG");

  await sqlGroup.save();
  step(`Saved: id=${sqlGroup.id}`);

  // ------------------------------------------------------------------
  section("6b. Create Log Group: infrastructure");

  const infraGroup = client.logging.newGroup("infrastructure", {
    name: "Infrastructure Loggers",
  });
  infraGroup.setLevel(LogLevel.INFO);
  infraGroup.setEnvironmentLevel("production", LogLevel.WARN);
  await infraGroup.save();
  step(`Created infrastructure group: id=${infraGroup.id}`);

  // ======================================================================
  // 7. FETCH AND UPDATE A LOG GROUP
  // ======================================================================
  section("7. Fetch and Update a Log Group");

  const fetchedGroup = await client.logging.getGroup(sqlGroup.id);
  step(`Fetched: id=${fetchedGroup.id}, level=${fetchedGroup.level}`);

  fetchedGroup.name = "SQL Loggers (Updated)";
  fetchedGroup.setLevel(LogLevel.INFO);
  await fetchedGroup.save();
  step(`Updated: name=${fetchedGroup.name}, level=${fetchedGroup.level}`);

  // ======================================================================
  // 8. ASSIGN LOGGER TO GROUP
  // ======================================================================
  //
  // Assigning a logger to a group is a direct mutation on the logger's
  // `group` property (which holds the group UUID). Save to persist.
  // ======================================================================

  section("8. Assign Logger to Group");

  const sqlLoggerRefresh = await client.logging.get(sqlLogger.id);
  step(`Before: sqlalchemy.engine group = ${sqlLoggerRefresh.group}`);

  sqlLoggerRefresh.group = sqlGroup.id;
  await sqlLoggerRefresh.save();
  step(`After: sqlalchemy.engine group = ${sqlLoggerRefresh.group}`);

  // Assign httpx to infrastructure group
  const httpxRefresh = await client.logging.get(httpxLogger.id);
  httpxRefresh.group = infraGroup.id;
  await httpxRefresh.save();
  step(`Assigned httpx to infrastructure group: ${httpxRefresh.group}`);

  // ======================================================================
  // 9. LIST AND DELETE LOG GROUPS
  // ======================================================================
  section("9a. List All Log Groups");

  const groups = await client.logging.listGroups();
  step(`Total groups: ${groups.length}`);
  for (const g of groups) {
    step(`  ${g.id} — level=${g.level}, name=${g.name}`);
  }

  // ------------------------------------------------------------------
  section("9b. Delete a Log Group");

  // Unassign loggers from the group first
  httpxRefresh.group = null;
  await httpxRefresh.save();
  step("Unassigned httpx from infrastructure group");

  await client.logging.deleteGroup(infraGroup.id);
  step("Deleted infrastructure group");

  const afterGroupDelete = await client.logging.listGroups();
  step(`Groups after delete: ${afterGroupDelete.length}`);

  // ======================================================================
  // 10. CLEANUP
  // ======================================================================
  section("10. Cleanup");

  // Unassign loggers from remaining groups
  sqlLoggerRefresh.group = null;
  await sqlLoggerRefresh.save();
  step("Unassigned sqlalchemy.engine from sql group");

  // Delete loggers (use server-assigned ids)
  await client.logging.delete(sqlLogger.id);
  step("Deleted sqlalchemy.engine");

  await client.logging.delete(httpxLogger.id);
  step("Deleted httpx");

  // celery.worker was already deleted in section 5b — ignore if gone
  try { await client.logging.delete(celeryLogger.id); } catch { /* already deleted */ }
  step("Deleted celery.worker");

  // Delete remaining groups
  await client.logging.deleteGroup(sqlGroup.id);
  step("Deleted sql group");

  client.close();
  step("SmplClient closed");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Logging Management showcase completed successfully.");
  console.log("  All loggers and groups have been cleaned up.\n");
}

main()
  .catch(console.error)
  .finally(() => process.exit(0));
