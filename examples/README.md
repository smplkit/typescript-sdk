# smplkit SDK Examples

Runnable examples demonstrating the [smplkit TypeScript SDK](https://github.com/smplkit/typescript-sdk).

> **Note:** These examples require valid smplkit credentials and a live environment — they are not self-contained demos.

## Prerequisites

1. Node.js 18+
2. A valid smplkit API key, provided via one of:
   - `SMPLKIT_API_KEY` environment variable
   - `~/.smplkit` configuration file (see SDK docs)
3. At least two environments configured (e.g., `staging`, `production`).

## Structure

There is **one** client per product, reached from `SmplClient`: `client.config`,
`client.flags`, `client.logging`, `client.audit`, and `client.jobs`.
Management/CRUD lives directly on each product client — `client.config.new/get/list/delete`,
the `client.flags.newBooleanFlag` builders, and `client.logging.loggers` /
`client.logging.logGroups`. Each product can also be used via a standalone
client (`AuditClient`, `JobsClient`). TypeScript has a single Promise-based
client — there is no separate management client.

Config/Flags/Logging keep a **management** + **runtime** showcase pair (the two
sides — CRUD vs. evaluation — are genuinely different). Audit and Jobs have **one**
showcase each — they have no runtime/management split (one client, full surface).

| Product     | Management                                                                  | Runtime                       | Setup                     |
| ----------- | --------------------------------------------------------------------------- | ----------------------------- | ------------------------- |
| **Flags**   | `flags_management_showcase.ts`                                              | `flags_runtime_showcase.ts`   | `flags_runtime_setup.ts`  |
| **Config**  | `config_management_showcase.ts`                                             | `config_runtime_showcase.ts`  | `config_runtime_setup.ts` |
| **Logging** | `logging_management_showcase.ts`                                            | `logging_runtime_showcase.ts` | _(none)_                  |
| **Audit**   | `audit_showcase.ts` — single; events, discovery, categories, and forwarders |                               | _(none)_                  |
| **Jobs**    | `jobs_showcase.ts` — single; job CRUD, runs                                 |                               | _(none)_                  |

**Management showcases** demonstrate the programmatic CRUD API directly on the
product client: creating resources with `new*()` + `save()`, fetching with
`get(id)`, listing, mutating, and deleting. No `install()` needed — management
methods are stateless HTTP calls.

**Runtime showcases** demonstrate the developer experience: code-first
declarations (`client.config.bind` / the `client.flags.*Flag` handles /
`client.logging.install()`), local evaluation, live updates via WebSocket, and
change listeners. Config and Flags auto-connect lazily on first runtime use;
Logging keeps an explicit `await client.logging.install()`. Each runtime
showcase imports its setup helper to create server-side state, then cleans up
after itself.

## Running

```bash
# Single-client products (Audit, Jobs — full surface, no runtime/management split)
npx tsx examples/audit_showcase.ts
npx tsx examples/jobs_showcase.ts

# Management / CRUD (directly on client.config / client.flags / client.logging)
npx tsx examples/flags_management_showcase.ts
npx tsx examples/config_management_showcase.ts
npx tsx examples/logging_management_showcase.ts

# Runtime (imports its setup helper automatically)
npx tsx examples/flags_runtime_showcase.ts
npx tsx examples/config_runtime_showcase.ts
npx tsx examples/logging_runtime_showcase.ts
```

Each script creates temporary resources, exercises all SDK features, then cleans up after itself.
