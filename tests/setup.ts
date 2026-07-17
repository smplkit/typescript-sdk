/**
 * Global test setup — runs once per test file (vitest `setupFiles`).
 *
 * The dev machine (or CI) may carry real `SMPLKIT_*` values, and standalone
 * sub-clients now resolve environment/service from them. Scrub the whole
 * namespace so resolution outcomes in unit tests are deterministic; tests
 * that need a value stub it explicitly (`vi.stubEnv`).
 */
for (const key of Object.keys(process.env)) {
  if (key.startsWith("SMPLKIT_")) delete process.env[key];
}
