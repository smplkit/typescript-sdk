# smplkit SDK Examples

Runnable examples demonstrating the [smplkit TypeScript SDK](https://github.com/smplkit/typescript-sdk).

> **Note:** These examples require valid smplkit credentials and a live environment — they are not self-contained demos.

## Prerequisites

1. Install the SDK:

   ```bash
   npm install @smplkit/sdk
   ```

2. A valid smplkit API key (create one in the [smplkit console](https://www.smplkit.com)).
3. At least one config created in your smplkit account (every account comes with a `common` config by default).

## Config Showcase

**File:** [`config_showcase.ts`](config_showcase.ts)

An end-to-end walkthrough of the Smpl Config SDK covering:

- **Client initialization** — `SmplkitClient`
- **Management-plane CRUD** — create, update, list, and delete configs
- **Environment overrides** — per-environment value layering via `setValues` and `setValue`
- **Multi-level inheritance** — child → parent → common config hierarchy
- **Management verification** — re-fetch and inspect stored values and overrides
- **Cleanup** — delete temporary configs and reset common

> **Note:** Runtime-plane features (connect, get, typed accessors, WebSocket updates) are not yet implemented in the TypeScript SDK. Those sections are marked as skipped in the showcase output. See the [Python SDK showcase](https://github.com/smplkit/python-sdk/tree/main/examples) for the full runtime experience.

### Running

```bash
export SMPLKIT_API_KEY="sk_api_..."
npx tsx examples/config_showcase.ts
```

The script creates temporary configs, exercises every available SDK feature, then cleans up after itself.
