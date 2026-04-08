/**
 * Smpl Logging SDK Showcase — Runtime
 * ======================================
 *
 * Demonstrates the smplkit TypeScript SDK's runtime experience for Smpl Logging:
 *
 * - Client initialization (`SmplClient`)
 * - Registering change listeners BEFORE start (global and scoped)
 * - Starting the logging runtime: `client.logging.start()`
 * - Management methods work without start()
 * - Global onChange listener: fires for any logger change
 * - Scoped onChange listener: fires only for a specific logger key
 * - Live WebSocket-driven updates
 *
 * This is the SDK experience that 99% of customers will use. Loggers are
 * created and configured via the Console UI (or the management API shown
 * in `logging_management_showcase.ts`). This script focuses entirely on
 * the runtime: starting the logger watcher, reacting to changes, and
 * verifying that management methods work independently of runtime state.
 *
 * Prerequisites:
 *   - `npm install @smplkit/sdk`
 *   - A valid smplkit API key, provided via one of:
 *       - SMPLKIT_API_KEY environment variable
 *       - ~/.smplkit configuration file (see SDK docs)
 *   - The smplkit Logging service running and reachable
 *
 * Usage:
 *   npx tsx examples/logging_runtime_showcase.ts
 */

import { SmplClient, LogLevel } from "@smplkit/sdk";

// Demo scaffolding — creates loggers so this showcase can run standalone.
// In a real app, loggers are created via the Console UI.
import { setupDemoLoggers, teardownDemoLoggers } from "./logging_runtime_setup.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // ======================================================================
  // 2. MANAGEMENT METHODS WORK WITHOUT start()
  // ======================================================================
  //
  // Management methods (new, get, list, delete, save) do not require
  // start(). They make direct HTTP calls to the Logging API. You can
  // create, inspect, and manage loggers without ever calling start().
  //
  // start() is only needed for the runtime: WebSocket-driven live
  // updates and change listener dispatch.
  // ======================================================================

  section("2. Management Without start()");

  // Create demo loggers BEFORE calling start
  console.log("  Setting up demo loggers...");
  const demo = await setupDemoLoggers(client);
  console.log("  Demo loggers ready.\n");

  // Management queries work without start()
  const loggers = await client.logging.list();
  step(`Listed ${loggers.length} loggers (no start() needed)`);
  for (const l of loggers) {
    step(`  ${l.key} — level=${l.level}, managed=${l.managed}`);
  }

  const groups = await client.logging.listGroups();
  step(`Listed ${groups.length} groups (no start() needed)`);
  for (const g of groups) {
    step(`  ${g.key} — level=${g.level}`);
  }

  // Fetch a specific logger
  const sqlLogger = await client.logging.get("sqlalchemy.engine");
  step(`Fetched sqlalchemy.engine: level=${sqlLogger.level}, group=${sqlLogger.group}`);

  // ======================================================================
  // 3. REGISTER CHANGE LISTENERS BEFORE start()
  // ======================================================================
  //
  // Change listeners can (and should) be registered before start().
  // This ensures no events are missed during initialization.
  //
  // Two listener forms:
  //   onChange(callback)         — global: fires for any logger change
  //   onChange(key, callback)    — scoped: fires only for that logger key
  // ======================================================================

  section("3. Register Change Listeners (Before start)");

  // Global listener — fires for ANY logger change
  const globalChanges: Array<{ key: string; level: unknown; source: string }> = [];
  client.logging.onChange((event) => {
    globalChanges.push({ key: event.key, level: event.level, source: event.source });
    console.log(
      `    [GLOBAL] Logger '${event.key}' changed: level=${event.level} (via ${event.source})`,
    );
  });
  step("Global change listener registered");

  // Scoped listener — fires only for sqlalchemy.engine
  const sqlChanges: Array<{ key: string; level: unknown }> = [];
  client.logging.onChange("sqlalchemy.engine", (event) => {
    sqlChanges.push({ key: event.key, level: event.level });
    console.log(`    [SQL] sqlalchemy.engine changed: level=${event.level}`);
  });
  step("Scoped change listener registered for 'sqlalchemy.engine'");

  // Scoped listener for httpx — should NOT fire for sqlalchemy changes
  const httpxChanges: Array<{ key: string; level: unknown }> = [];
  client.logging.onChange("httpx", (event) => {
    httpxChanges.push({ key: event.key, level: event.level });
    console.log(`    [HTTPX] httpx changed: level=${event.level}`);
  });
  step("Scoped change listener registered for 'httpx'");

  // ======================================================================
  // 4. START THE LOGGING RUNTIME
  // ======================================================================
  //
  // start() does two things:
  //   1. Wires the shared WebSocket for logger_changed events
  //   2. Marks the runtime as active
  //
  // After start(), logger changes pushed via WebSocket will trigger
  // the registered onChange listeners.
  //
  // start() is idempotent — safe to call multiple times.
  // ======================================================================

  section("4. Start the Logging Runtime");

  await client.logging.start();
  step("client.logging.start() completed — WebSocket wired for live updates");

  // Calling start() again is safe (idempotent)
  await client.logging.start();
  step("Second start() call is a no-op (idempotent)");

  // ======================================================================
  // 5. SIMULATE LIVE UPDATES
  // ======================================================================
  //
  // In production, changes made via the Console UI or management API
  // are pushed to connected SDK instances via WebSocket. Here we
  // simulate that by modifying loggers via the management API and
  // waiting for the WebSocket event to arrive.
  // ======================================================================

  section("5. Simulate Live Updates");

  // Modify sqlalchemy.engine via management API
  const sqlRefresh = await client.logging.get("sqlalchemy.engine");
  sqlRefresh.setLevel(LogLevel.DEBUG);
  await sqlRefresh.save();
  step("Updated sqlalchemy.engine level to DEBUG via management API");

  // Give the WebSocket a moment to deliver the event
  await sleep(2000);

  step(`Global changes received: ${globalChanges.length}`);
  step(`SQL-scoped changes received: ${sqlChanges.length}`);
  step(`HTTPX-scoped changes received: ${httpxChanges.length}`);

  // Modify httpx via management API
  const httpxRefresh = await client.logging.get("httpx");
  httpxRefresh.setLevel(LogLevel.ERROR);
  await httpxRefresh.save();
  step("Updated httpx level to ERROR via management API");

  await sleep(2000);

  step(`Global changes received: ${globalChanges.length}`);
  step(`SQL-scoped changes received: ${sqlChanges.length}`);
  step(`HTTPX-scoped changes received: ${httpxChanges.length}`);

  // ======================================================================
  // 6. VERIFY LISTENER SCOPING
  // ======================================================================
  section("6. Verify Listener Scoping");

  step("Global listener should have received all changes");
  step(`  Global total: ${globalChanges.length}`);
  for (const c of globalChanges) {
    step(`    ${c.key}: level=${c.level} (via ${c.source})`);
  }

  step("SQL-scoped listener should only have sqlalchemy.engine changes");
  step(`  SQL total: ${sqlChanges.length}`);

  step("HTTPX-scoped listener should only have httpx changes");
  step(`  HTTPX total: ${httpxChanges.length}`);

  // ======================================================================
  // 7. CLEANUP
  // ======================================================================
  section("7. Cleanup");

  await teardownDemoLoggers(client, demo);
  step("Demo loggers and groups deleted");

  client.close();
  step("SmplClient closed (WebSocket disconnected)");

  // ======================================================================
  // DONE
  // ======================================================================
  section("ALL DONE");
  console.log("  The Logging Runtime showcase completed successfully.\n");
}

main().catch(console.error);
process.exit(0);
