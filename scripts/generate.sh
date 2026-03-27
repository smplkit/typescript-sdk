#!/usr/bin/env bash
# Generate TypeScript types from OpenAPI specs.
#
# Usage:
#   npm run generate
#
# This regenerates ALL types from ALL specs in openapi/.
# Do NOT edit files under src/generated/ manually — they will be
# overwritten on next generation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OPENAPI_DIR="${PROJECT_ROOT}/openapi"
GENERATED_DIR="${PROJECT_ROOT}/src/generated"

# Clean previous output
rm -rf "${GENERATED_DIR}"
mkdir -p "${GENERATED_DIR}"

# Generate types for each spec
for spec in "${OPENAPI_DIR}"/*.json; do
  name=$(basename "${spec}" .json)
  echo "Generating types for ${name}..."
  npx openapi-typescript "${spec}" -o "${GENERATED_DIR}/${name}.d.ts"
done

echo "Done. Generated types are in ${GENERATED_DIR}/"
