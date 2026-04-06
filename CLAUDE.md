# smplkit TypeScript SDK

See `~/.claude/CLAUDE.md` for universal rules (git workflow, testing, code quality, SDK conventions, etc.).

## Repository Structure

- `src/generated/` — Auto-generated type definitions from OpenAPI specs. Do not edit manually.
- `src/` (excluding `generated/`) — Hand-crafted SDK wrapper. This is the public API.

## Regenerating Types

```bash
npm run generate
```

## Testing

```bash
npm test                # run tests
npm run test:coverage   # run tests with coverage
```

## Building

```bash
npm run build
```

Produces dual ESM/CJS output in `dist/`.

## Linting & Formatting

```bash
npm run lint        # check lint
npm run lint:fix    # auto-fix lint issues
npm run format      # format with prettier
npm run format:check # check formatting
```

## Node.js Version Policy

The SDK supports Node.js 18 through 22. Development uses Node.js 22 (the latest LTS).

- `engines.node >= 18` in package.json is the enforced minimum.
- CI runs the full test suite against 18, 20, and 22 on every push.

## Package Naming

- **npm package name:** `@smplkit/sdk` (install via `npm install @smplkit/sdk`)
- **Import:** `import { SmplkitClient } from "@smplkit/sdk"`

## Publishing

Publishes to npm via semantic-release on push to main.
