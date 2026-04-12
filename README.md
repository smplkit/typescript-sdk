# smplkit TypeScript SDK

[![npm Version](https://img.shields.io/npm/v/@smplkit/sdk)](https://www.npmjs.com/package/@smplkit/sdk) [![Build](https://github.com/smplkit/typescript-sdk/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/smplkit/typescript-sdk/actions) [![Coverage](https://codecov.io/gh/smplkit/typescript-sdk/branch/main/graph/badge.svg)](https://codecov.io/gh/smplkit/typescript-sdk) [![License](https://img.shields.io/npm/l/@smplkit/sdk)](LICENSE) [![Docs](https://img.shields.io/badge/docs-docs.smplkit.com-blue)](https://docs.smplkit.com)

The official TypeScript SDK for [smplkit](https://www.smplkit.com) — simple application infrastructure that just works.

## Installation

```bash
npm install @smplkit/sdk
```

## Requirements

- Node.js 18+

## Quick Start

```typescript
import { SmplClient } from "@smplkit/sdk";

// Option 1: Explicit API key
const client = new SmplClient({ apiKey: "sk_api_..." });

// Option 2: Environment variable (SMPLKIT_API_KEY)
// export SMPLKIT_API_KEY=sk_api_...
const client2 = new SmplClient();

// Option 3: Configuration file (~/.smplkit)
// [default]
// api_key = sk_api_...
const client3 = new SmplClient();
```

## Configuration

The API key is resolved using the following priority:

1. **Explicit argument:** Pass `apiKey` in the constructor options.
2. **Environment variable:** Set `SMPLKIT_API_KEY`.
3. **Configuration file:** Add `api_key` under `[default]` in `~/.smplkit`:

```ini
# ~/.smplkit

[default]
api_key = sk_api_your_key_here
```

If none of these are set, the SDK throws `SmplError` with a message listing all three methods.

```typescript
const client = new SmplClient({
  apiKey: "sk_api_...",
  timeout: 30_000, // default (ms)
});
```

## Config

### Runtime (resolve config values)

```typescript
// Resolve config values for a service
const config = await client.config.get("my-service");
console.log(config.getString("timeout"));
console.log(config.getNumber("retries"));

// Subscribe to live updates
client.config.subscribe("my-service", (config) => {
  console.log("Config updated:", config.getString("timeout"));
});
```

### Management (CRUD)

```typescript
// Create a config
const cfg = client.config.management.new("my-service", {
  name: "My Service",
  description: "Configuration for my service",
});
await cfg.save();

// List configs
const configs = await client.config.management.list();

// Get a config by id
const fetched = await client.config.management.get("my-service");

// Delete a config
await client.config.management.delete("my-service");
```

## Flags

### Runtime (evaluate flags)

```typescript
import { SmplClient, Rule } from "@smplkit/sdk";

const client = new SmplClient({ environment: "production", service: "my-service" });

// Declare a flag
const checkoutFlag = client.flags.booleanFlag("checkout-v2", { default: false });

// Start the client (connects and fetches flags)
await client.flags.initialize();

// Evaluate with context
const enabled = await checkoutFlag.get({ user: { plan: "enterprise" } });
console.log("checkout-v2:", enabled);

client.close();
```

### Management (CRUD)

```typescript
// Create flags
const boolFlag = client.flags.management.newBooleanFlag("checkout-v2", {
  default: false,
  description: "Controls rollout of the new checkout experience.",
});

// Add targeting rules
boolFlag.addRule(
  new Rule("Enable for enterprise users")
    .environment("production")
    .when("user.plan", "==", "enterprise")
    .serve(true)
    .build(),
);

// Configure environments
boolFlag.setEnvironmentEnabled("production", true);
boolFlag.setEnvironmentDefault("production", false);

await boolFlag.save();

// Other factory methods
const strFlag = client.flags.management.newStringFlag("banner-color", {
  default: "red",
  values: [{ name: "Red", value: "red" }, { name: "Blue", value: "blue" }],
});
const numFlag = client.flags.management.newNumberFlag("max-retries", { default: 3 });
const jsonFlag = client.flags.management.newJsonFlag("ui-theme", {
  default: { mode: "light" },
});

// List / get / delete
const flags = await client.flags.management.list();
const flag = await client.flags.management.get("checkout-v2");
await client.flags.management.delete("checkout-v2");
```

## Logging

### Runtime (live log level management)

```typescript
const client = new SmplClient({ environment: "production", service: "my-service" });

// Register an adapter for your logging library
client.logging.registerAdapter(myAdapter);

// Start the logging runtime (connects and fetches log levels)
await client.logging.start();

client.logging.onChange((loggers) => {
  console.log("Log levels updated:", loggers.map((l) => `${l.id}=${l.level}`));
});
```

### Management (CRUD)

```typescript
// Create a logger
const logger = client.logging.management.new("sqlalchemy.engine", { managed: true });
logger.setLevel(LogLevel.WARN);
logger.setEnvironmentLevel("production", LogLevel.ERROR);
await logger.save();

// Create a log group
const group = client.logging.management.newGroup("sql", { name: "SQL Loggers" });
group.setLevel(LogLevel.WARN);
await group.save();

// Assign logger to group
logger.group = group.id;
await logger.save();

// List / get / delete
const loggers = await client.logging.management.list();
const fetched = await client.logging.management.get("Sqlalchemy.Engine");
await client.logging.management.delete("Sqlalchemy.Engine");

const groups = await client.logging.management.listGroups();
const fetchedGroup = await client.logging.management.getGroup(group.id);
await client.logging.management.deleteGroup(group.id);
```

## Error Handling

All SDK errors extend `SmplError`:

```typescript
import { SmplError, SmplNotFoundError } from "@smplkit/sdk";

try {
  const flag = await client.flags.management.get("nonexistent");
} catch (err) {
  if (err instanceof SmplNotFoundError) {
    console.log("Not found:", err.message);
  } else if (err instanceof SmplError) {
    console.log("SDK error:", err.statusCode, err.responseBody);
  }
}
```

| Error                  | Cause                        |
|------------------------|------------------------------|
| `SmplNotFoundError`    | HTTP 404 — resource not found |
| `SmplConflictError`    | HTTP 409 — conflict           |
| `SmplValidationError`  | HTTP 422 — validation error   |
| `SmplTimeoutError`     | Request timed out             |
| `SmplConnectionError`  | Network connectivity issue    |
| `SmplError`            | Any other SDK error           |

## Documentation

- [Getting Started](https://docs.smplkit.com/getting-started)
- [TypeScript SDK Guide](https://docs.smplkit.com/sdks/typescript)
- [API Reference](https://docs.smplkit.com/api)

## License

MIT
