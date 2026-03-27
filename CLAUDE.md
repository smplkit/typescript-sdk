# smplkit TypeScript SDK

## Repository structure

Two-layer architecture:
- `src/generated/` — Auto-generated type definitions from OpenAPI specs. Do not edit manually.
- `src/` (excluding `generated/`) — Hand-crafted SDK wrapper. This is the public API.

## Regenerating types

```bash
npm run generate
```

This regenerates ALL types from ALL specs in `openapi/`. Do NOT edit files under `generated/` manually — they will be overwritten on next generation.

## Commits

Commit directly to main with conventional commit messages. No branches or PRs.

## Testing

```bash
npm test                # run tests
npm run test:coverage   # run tests with coverage
```

Target 90%+ coverage on the SDK wrapper layer. Generated code coverage is not enforced.

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

Publishing is automated:

1. Every push to main triggers the publish workflow, which runs `semantic-release`.
2. If conventional commits warrant a version bump, semantic-release creates a git tag and GitHub release.
3. The same workflow then builds and publishes to npm.

- **Do not create tags manually.** Semantic-release owns versioning.
- **Conventional commits drive version bumps:** `feat:` -> minor, `fix:` -> patch, `BREAKING CHANGE:` -> major.
