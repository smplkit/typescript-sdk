# smplkit TypeScript SDK

The official TypeScript SDK for [smplkit](https://www.smplkit.com) — simple application infrastructure that just works.

## Installation

```bash
npm install smplkit-sdk
```

## Requirements

- Node.js 18+

## Quick Start

```typescript
import { SmplClient } from "smplkit-sdk";

const client = new SmplClient({ apiKey: "sk_api_..." });

// Get a config by key
const config = await client.config.getByKey("user_service");

// List all configs
const configs = await client.config.list();

// Create a config
const newConfig = await client.config.create({
  name: "My Service",
  key: "my_service",
  description: "Configuration for my service",
  values: { timeout: 30, retries: 3 },
});

// Delete a config
await client.config.delete(newConfig.id);
```

## Configuration

```typescript
const client = new SmplClient({
  apiKey: "sk_api_...",
  timeout: 30_000, // default (ms)
});
```

## Error Handling

All SDK errors extend `SmplError`:

```typescript
import { SmplError, SmplNotFoundError } from "smplkit-sdk";

try {
  const config = await client.config.getByKey("nonexistent");
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
