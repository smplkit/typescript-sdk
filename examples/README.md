# smplkit SDK Examples

Runnable examples demonstrating the [smplkit TypeScript SDK](https://github.com/smplkit/typescript-sdk).

> **Note:** These examples require valid smplkit credentials and a live environment — they are not self-contained demos.

## Prerequisites

1. Node.js 18+
2. A valid smplkit API key, provided via one of:
   - `SMPLKIT_API_KEY` environment variable
   - `~/.smplkit` configuration file (see SDK docs)
3. At least one config created in your smplkit account (every account comes with a `common` config by default).

## Config Showcase

**File:** [`config_showcase.ts`](config_showcase.ts)

An end-to-end walkthrough of the Smpl Config SDK covering:

- **Client initialization** — `new SmplClient({ environment: "production", service: "my-service" })`
- **Management-plane CRUD** — create, update, list, get by key, and delete configs
- **Environment overrides** — `setValues()` and `setValue()` for per-environment configuration
- **Multi-level inheritance** — child → parent → common hierarchy setup
- **Runtime value resolution** — `connect()`, `get()`, typed accessors (`getString`, `getInt`, `getBool`)
- **Real-time updates** — WebSocket-driven cache invalidation with change listeners
- **Manual refresh and cache diagnostics** — `refresh()`, `stats()`

### Running

```bash
npx tsx examples/config_showcase.ts
```

The script creates temporary configs, exercises all SDK features, then cleans up after itself.
