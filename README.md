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

`SmplClient` requires `apiKey`, `environment`, and `service`. Each can come from the constructor, an environment variable, or `~/.smplkit`.

```typescript
import { SmplClient } from "@smplkit/sdk";

const client = new SmplClient({
  apiKey: "sk_api_...",
  environment: "production",
  service: "my-service",
});

// Block until cache is warm and the live-updates WebSocket is connected.
// Optional but recommended at process start so the first reads hit cache.
await client.waitUntilReady();

// ... do work ...

client.close(); // releases the WebSocket and stops background timers
```

If `SMPLKIT_API_KEY` / `SMPLKIT_ENVIRONMENT` / `SMPLKIT_SERVICE` are set (or a `~/.smplkit` profile supplies them), `new SmplClient()` works with no arguments.

## Configuration

Settings are resolved in order of precedence:

1. **Constructor options** — highest priority.
2. **Environment variables** — `SMPLKIT_API_KEY`, `SMPLKIT_ENVIRONMENT`, `SMPLKIT_SERVICE`, `SMPLKIT_BASE_DOMAIN`, `SMPLKIT_SCHEME`, `SMPLKIT_DEBUG`, `SMPLKIT_DISABLE_TELEMETRY`, `SMPLKIT_PROFILE`.
3. **Configuration file** (`~/.smplkit`) — INI-format with profile support.
4. **Built-in defaults**.

### Configuration File

`~/.smplkit` supports a `[common]` section (applied to every profile) plus named profiles:

```ini
[common]
environment = production
service = my-app

[default]
api_key = sk_api_abc123

[local]
base_domain = localhost
scheme = http
api_key = sk_api_local_xyz
environment = development
debug = true
```

```typescript
const client = new SmplClient({ profile: "local" });
```

For the complete reference, see the [Configuration Guide](https://docs.smplkit.com/getting-started/configuration).

## Config

### Runtime — resolve config values

`client.config.get(key)` returns a `LiveConfigProxy`: a read-only, dict-like view that always reflects the latest server-pushed values.

```typescript
const cfg = await client.config.get("user-service");

// Dict-style access — both forms work
console.log(cfg.get("database.host"));
console.log(cfg["max_retries"]);
for (const key of Object.keys(cfg)) console.log(key, cfg[key]);

// Per-config and per-item change listeners
cfg.onChange((event) => console.log(`${event.itemKey}: ${event.oldValue} -> ${event.newValue}`));
cfg.onChange("max_retries", (event) => console.log("retries changed:", event.newValue));

// Or attach a global listener that fires for any config change
client.config.onChange((event) => console.log(`${event.configId}.${event.itemKey} changed`));

// Manual re-fetch (useful after suspecting drift)
await client.config.refresh();
```

You can also pass a model class as the second argument; the proxy reconstructs the model from the latest values on every read so attribute access type-checks against your model:

```typescript
class UserServiceConfig {
  database!: { host: string; port: number };
  max_retries!: number;
  constructor(data: any) {
    Object.assign(this, data);
  }
}
const typed = await client.config.get("user-service", UserServiceConfig);
console.log(typed.database.host);
```

### Management (CRUD)

CRUD lives under `client.manage.config.*`. You can also construct a standalone `SmplManagementClient` for setup scripts or admin tooling.

```typescript
// Author a config — `set*` mutations are local until `.save()` is called.
const cfg = client.manage.config.new("my-service", {
  name: "My Service",
  description: "Configuration for my service",
});
cfg.setString("database.host", "localhost");
cfg.setNumber("max_retries", 3);
cfg.setBoolean("enable_signup", true);
cfg.setJson("feature_matrix", { v2: true });

// Per-environment override
cfg.setNumber("max_retries", 5, { environment: "production" });
await cfg.save();

// Read / list / delete
const fetched = await client.manage.config.get("my-service");
const all = await client.manage.config.list();
await client.manage.config.delete("my-service");
```

Configs support a single level of inheritance via `parent`:

```typescript
const child = client.manage.config.new("user-service", {
  name: "User Service",
  parent: "my-service", // or pass a Config instance
});
```

## Flags

### Runtime — evaluate flags

```typescript
import { SmplClient, Context } from "@smplkit/sdk";

const client = new SmplClient({ environment: "production", service: "my-service" });
await client.waitUntilReady();

// Declare typed flag handles. The default is returned when smplkit is
// unreachable or the flag does not exist.
const checkoutV2 = client.flags.booleanFlag("checkout-v2", false);
const bannerColor = client.flags.stringFlag("banner-color", "red");
const maxRetries = client.flags.numberFlag("max-retries", 3);

// Evaluate with explicit per-call context
const enabled = checkoutV2.get({
  context: [
    new Context("user", "alice@acme.com", { plan: "enterprise" }),
    new Context("account", "1234", { region: "us" }),
  ],
});

// Or register an ambient context provider that fires per evaluation
client.flags.setContextProvider(() => [
  new Context("user", currentUser.email, { plan: currentUser.plan }),
]);
const colour = bannerColor.get(); // uses the provider
```

`flag.get()` is synchronous — `initialize()` (or `waitUntilReady()`) populates the local store; subsequent reads hit cache and never block.

#### Listening for changes

```typescript
client.flags.onChange((event) => console.log(`${event.id} changed`));
client.flags.onChange("banner-color", (event) => console.log("banner-color updated"));

// Manual re-fetch
await client.flags.refresh();

// Cache stats (cacheHits / cacheMisses)
const stats = client.flags.stats();
```

### Management (CRUD)

```typescript
import { Rule, Op } from "@smplkit/sdk";

const flag = client.manage.flags.newBooleanFlag("checkout-v2", {
  default: false,
  description: "Controls rollout of the new checkout experience.",
});

// Targeting rule — `environment` is required on the Rule constructor
flag.addRule(
  new Rule("Enable for enterprise users", { environment: "production" })
    .when("user.plan", Op.EQ, "enterprise")
    .when("account.region", Op.EQ, "us")
    .serve(true),
);

// Per-environment defaults and kill-switch
flag.setDefault(false, { environment: "production" });
flag.disableRules({ environment: "staging" }); // kill switch
flag.enableRules({ environment: "production" });

await flag.save();

// Other typed factories
const banner = client.manage.flags.newStringFlag("banner-color", {
  default: "red",
  values: [
    { name: "Red", value: "red" },
    { name: "Blue", value: "blue" },
  ],
});
const retries = client.manage.flags.newNumberFlag("max-retries", { default: 3 });
const theme = client.manage.flags.newJsonFlag("ui-theme", { default: { mode: "light" } });

// CRUD
const all = await client.manage.flags.list();
const fetched = await client.manage.flags.get("checkout-v2");
await client.manage.flags.delete("checkout-v2");
```

### Contexts

Bulk-register context entities so the platform knows about them (used in the targeting UI, dashboards, etc.):

```typescript
await client.manage.contexts.register([
  new Context("user", "alice@acme.com", { plan: "enterprise" }),
  new Context("account", "1234", { region: "us" }),
]);
await client.manage.contexts.flush(); // or pass `{ flush: true }` to register
```

## Logging

### Runtime — live log level management

`install()` auto-discovers winston and pino loggers, hooks new-logger creation, applies server-managed levels, and subscribes to live updates over the shared WebSocket.

```typescript
import { SmplClient, LogLevel } from "@smplkit/sdk";

const client = new SmplClient({ environment: "production", service: "my-service" });
await client.logging.install();

client.logging.onChange((event) => {
  console.log(`${event.id}: ${event.level} (source=${event.source})`);
});

// Force a manual re-sync (e.g. after suspecting drift)
await client.logging.refresh();
```

**Adapter coverage.** Winston named loggers (`winston.loggers.*`) and the default winston logger are auto-discovered at install time. Pino has no global registry, so only loggers created through `pino()` / `logger.child()` after `install()` runs are tracked — pre-existing pino loggers must be recreated or explicitly registered via `client.manage.loggers.register([...])`. There is no console adapter; use a supported framework (winston or pino) to bring loggers under management.

You can also register a custom adapter:

```typescript
client.logging.registerAdapter(myAdapter); // must implement LoggingAdapter
await client.logging.install();
```

### Management (CRUD)

Loggers and log groups have separate namespaces:

```typescript
// Loggers
const sql = client.manage.loggers.new("sqlalchemy.engine", { managed: true });
sql.setLevel(LogLevel.WARN);
sql.setLevel(LogLevel.ERROR, { environment: "production" });
await sql.save();

const all = await client.manage.loggers.list();
const fetched = await client.manage.loggers.get("sqlalchemy.engine");
await client.manage.loggers.delete("sqlalchemy.engine");

// Log groups (a way to bulk-set levels across many loggers)
const group = client.manage.logGroups.new("sql", { name: "SQL Loggers" });
group.setLevel(LogLevel.WARN);
await group.save();

await client.manage.logGroups.list();
await client.manage.logGroups.get("sql");
await client.manage.logGroups.delete("sql");
```

## Standalone management client

For setup scripts, CI tooling, and admin utilities you don't need the runtime plane (no WebSocket, no metrics thread, no logger discovery). Construct `SmplManagementClient` directly:

```typescript
import { SmplManagementClient } from "@smplkit/sdk";

const manage = new SmplManagementClient(); // resolves apiKey from env / ~/.smplkit
await manage.environments.list();
await manage.config.new("my-service", { name: "My Service" }).save();
await manage.close(); // flushes any buffered context/flag/logger registrations
```

The runtime `client.manage` and a standalone `SmplManagementClient` expose the same surface: `config`, `flags`, `loggers`, `logGroups`, `contexts`, `contextTypes`, `environments`, `accountSettings`.

## Error Handling

All SDK errors extend `SmplError` (also re-exported as `SmplkitError` for callers that prefer the longer prefix).

```typescript
import { SmplError, SmplNotFoundError } from "@smplkit/sdk";

try {
  await client.manage.flags.get("nonexistent");
} catch (err) {
  if (err instanceof SmplNotFoundError) {
    console.log("Not found:", err.message);
  } else if (err instanceof SmplError) {
    console.log("SDK error:", err.statusCode, err.responseBody);
    console.log("Structured details:", err.errors);
  }
}
```

| Error                 | Cause                              |
| --------------------- | ---------------------------------- |
| `SmplNotFoundError`   | HTTP 404 — resource not found      |
| `SmplConflictError`   | HTTP 409 — conflict                |
| `SmplValidationError` | HTTP 422 — validation error        |
| `SmplTimeoutError`    | Request timed out                  |
| `SmplConnectionError` | Network connectivity issue         |
| `SmplError`           | Base class for any other SDK error |

## Debug Logging

Set `SMPLKIT_DEBUG` to enable verbose diagnostic output to stderr — useful when troubleshooting WebSocket connectivity, level resolution, or initialization.

```bash
SMPLKIT_DEBUG=1 node my-app.js
```

Accepted values: `1`, `true`, `yes` (case-insensitive). Any other value (or unset) disables debug output. You can also enable it programmatically via `new SmplClient({ debug: true })`.

## Documentation

- [Getting Started](https://docs.smplkit.com/getting-started)
- [TypeScript SDK Guide](https://docs.smplkit.com/sdks/typescript)
- [API Reference](https://docs.smplkit.com/api)

## License

MIT
