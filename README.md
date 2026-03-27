# smplkit

Official TypeScript SDK for the [smplkit](https://docs.smplkit.com) platform.

## Installation

```bash
npm install @smplkit/sdk
```

## Quick Start

```typescript
import { SmplkitClient } from "@smplkit/sdk";

const client = new SmplkitClient({ apiKey: "sk_api_..." });

// Fetch a config by key
const config = await client.config.get({ key: "user_service" });
console.log(config.values);

// List all configs
const configs = await client.config.list();

// Create a config
const newConfig = await client.config.create({
  name: "Payment Service",
  key: "payment_service",
  description: "Configuration for the payment service",
  values: { timeout: 30, retries: 3 },
});

// Delete a config
await client.config.delete(newConfig.id);
```

## Configuration

```typescript
const client = new SmplkitClient({
  apiKey: "sk_api_...",                        // Required
  baseUrl: "https://config.smplkit.com",       // Optional (default shown)
  timeout: 30000,                               // Optional, in milliseconds (default: 30000)
});
```

## Error Handling

All SDK errors extend `SmplError`:

```typescript
import {
  SmplError,
  SmplNotFoundError,
  SmplConflictError,
  SmplValidationError,
  SmplConnectionError,
  SmplTimeoutError,
} from "@smplkit/sdk";

try {
  const config = await client.config.get({ key: "nonexistent" });
} catch (error) {
  if (error instanceof SmplNotFoundError) {
    console.log("Config not found");
  } else if (error instanceof SmplValidationError) {
    console.log("Invalid request:", error.message);
  } else if (error instanceof SmplConnectionError) {
    console.log("Network error:", error.message);
  } else if (error instanceof SmplTimeoutError) {
    console.log("Request timed out");
  } else if (error instanceof SmplError) {
    console.log("SDK error:", error.statusCode, error.message);
  }
}
```

## Documentation

Full documentation is available at [docs.smplkit.com](https://docs.smplkit.com).

## License

MIT
