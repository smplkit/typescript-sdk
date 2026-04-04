# smplkit TypeScript SDK

[![npm Version](https://img.shields.io/npm/v/@smplkit/sdk)](https://www.npmjs.com/package/@smplkit/sdk) [![Build](https://github.com/smplkit/typescript-sdk/actions/workflows/ci-cd.yml/badge.svg)](https://github.com/smplkit/typescript-sdk/actions) [![Coverage](https://codecov.io/gh/smplkit/typescript-sdk/branch/main/graph/badge.svg)](https://codecov.io/gh/smplkit/typescript-sdk) [![License](https://img.shields.io/npm/l/@smplkit/sdk)](LICENSE) [![Docs](https://img.shields.io/badge/docs-docs.smplkit.com-blue)](https://docs.smplkit.com)

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
