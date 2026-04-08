# smplkit SDK Examples

Runnable examples demonstrating the [smplkit TypeScript SDK](https://github.com/smplkit/typescript-sdk).

> **Note:** These examples require valid smplkit credentials and a live environment — they are not self-contained demos.

## Prerequisites

1. Node.js 18+
2. A valid smplkit API key, provided via one of:
   - `SMPLKIT_API_KEY` environment variable
   - `~/.smplkit` configuration file (see SDK docs)
3. At least one environment configured in your smplkit account.

## Config Showcase

### Management API

**File:** [`config_management_showcase.ts`](config_management_showcase.ts)

Demonstrates the management plane for Smpl Config:

- Client initialization (`SmplClient`)
- Factory method: `client.config.new()` for unsaved configs
- Direct mutation of items, environments, and metadata
- Persist via `save()` (POST if new, PUT if existing)
- Fetch, list, and delete configs by key
- Parent-child config hierarchy

```bash
npx tsx examples/config_management_showcase.ts
```

### Runtime API

**File:** [`config_runtime_showcase.ts`](config_runtime_showcase.ts)

Demonstrates the runtime experience for Smpl Config:

- Value resolution: `client.config.resolve()` for flat dict
- Typed resolution: `resolve()` with a model class
- Live proxy: `client.config.subscribe()` for auto-updating access
- Change listeners at three levels: global, config-scoped, item-scoped
- Manual refresh: `client.config.refresh()`

```bash
npx tsx examples/config_runtime_showcase.ts
```

## Flags Showcase

### Management API

**File:** [`flags_management_showcase.ts`](flags_management_showcase.ts)

Demonstrates the management plane for Smpl Flags:

- Creating flags (BOOLEAN, STRING, NUMERIC, JSON) via FlagType
- Rule builder: fluent API for constructing JSON Logic rules
- Configuring values, environments, and rules
- Updating flag definitions
- Listing, inspecting, and deleting flags
- Managing context types

```bash
npx tsx examples/flags_management_showcase.ts
```

### Runtime API

**File:** [`flags_runtime_showcase.ts`](flags_runtime_showcase.ts)

Demonstrates the runtime evaluation for Smpl Flags:

- Typed flag declarations with code-level defaults
- Context providers and typed context entities
- Local JSON Logic evaluation (no network per call)
- Resolution caching and cache stats
- Real-time updates via WebSocket and change listeners
- Environment comparison
- Explicit context overrides

```bash
npx tsx examples/flags_runtime_showcase.ts
```

## Logging Showcase

### Management API

**File:** [`logging_management_showcase.ts`](logging_management_showcase.ts)

Demonstrates the management plane for Smpl Logging:

- Logger CRUD: `new()` → `setLevel()` → `setEnvironmentLevel()` → `save()`
- Fetch, mutate, list, and delete loggers by key
- Level clearing: `clearLevel()`, `clearEnvironmentLevel()`, `clearAllEnvironmentLevels()`
- Log Group CRUD: `newGroup()` → `setLevel()` → `save()`
- Fetch, mutate, list, and delete log groups
- Assigning loggers to groups

```bash
npx tsx examples/logging_management_showcase.ts
```

### Runtime API

**File:** [`logging_runtime_showcase.ts`](logging_runtime_showcase.ts)

Demonstrates the runtime experience for Smpl Logging:

- Registering change listeners before `start()` (global and scoped)
- Starting the logging runtime: `client.logging.start()`
- Management methods work without `start()`
- Global onChange listener: fires for any logger change
- Scoped onChange listener: fires only for a specific logger key
- Live WebSocket-driven updates

```bash
npx tsx examples/logging_runtime_showcase.ts
```
