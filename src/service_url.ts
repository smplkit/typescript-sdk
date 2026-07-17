/**
 * Pure config helpers shared by every client.
 *
 * Lives in its own module (rather than `config.ts`) so import graphs that
 * must stay free of Node built-ins — the `@smplkit/sdk/audit` edge entry —
 * can compose service URLs and read environment variables without dragging
 * in the `~/.smplkit` file resolution machinery (`node:fs` / `node:os` /
 * `node:path`).
 */

/** Compose a per-service base URL, e.g. `serviceUrl("https", "audit", "smplkit.com")`. */
export function serviceUrl(scheme: string, subdomain: string, baseDomain: string): string {
  return `${scheme}://${subdomain}.${baseDomain}`;
}

/**
 * Read one `SMPLKIT_*` environment variable, tolerating runtimes with no
 * `process` global (browsers, some edge isolates). Node — and Cloudflare
 * Workers with `nodejs_compat` — expose `process.env`; anywhere it is
 * absent every lookup simply resolves to `undefined` and explicit
 * constructor options carry the configuration instead.
 */
export function envConfigValue(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value ? value : undefined;
}
