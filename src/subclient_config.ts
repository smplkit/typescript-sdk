/**
 * Shared config resolution for standalone sub-clients — pure module.
 *
 * Every standalone-constructible sub-client (audit, config, flags, logging,
 * jobs, platform, account) resolves its credentials and target URLs here, so
 * all of them behave exactly like {@link SmplClient}: defaults → `~/.smplkit`
 * file → `SMPLKIT_*` environment variables → constructor options.
 *
 * The `~/.smplkit` FILE step lives in `./config.js`, whose import graph
 * carries Node built-ins (`node:fs` / `node:os` / `node:path`). Sub-client
 * modules must stay importable from edge runtimes via the `@smplkit/sdk/*`
 * subpath entries, so that resolver is injected by the package ROOT entry
 * (`src/index.ts`) rather than imported statically. Both entries resolve the
 * same way otherwise; the edge entries merely skip the `~/.smplkit` file
 * step, which has no meaning in an isolate anyway.
 */

import { SmplError } from "./errors.js";
import { envConfigValue, serviceUrl } from "./service_url.js";

/** The options slice every standalone sub-client feeds into resolution. */
export interface SubclientConfigOptions {
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
  baseDomain?: string;
  scheme?: string;
  environment?: string;
  service?: string;
}

/** @internal The slice of the resolved config the injected resolver returns. */
export interface InjectedClientConfig {
  apiKey: string;
  scheme: string;
  baseDomain: string;
  environment: string | null;
  service?: string | null;
}

/** @internal */
export type SubclientConfigResolver = (options: SubclientConfigOptions) => InjectedClientConfig;

let _resolver: SubclientConfigResolver | null = null;

/** @internal Wired by the package-root entry; the edge entries leave it unset. */
export function _setSubclientConfigResolver(resolver: SubclientConfigResolver): void {
  _resolver = resolver;
}

/** Fully resolved sub-client target: credentials, URLs, and scoping. */
export interface ResolvedSubclientConfig {
  apiKey: string;
  /** Base URL of the sub-client's own service. */
  baseUrl: string;
  scheme: string;
  baseDomain: string;
  environment: string | undefined;
  service: string | undefined;
}

/**
 * Resolve a standalone sub-client's config — like {@link SmplClient}.
 *
 * All options are optional. When `apiKey`, `baseUrl`, and `environment` are
 * all supplied explicitly they are used directly (the path a top-level client
 * takes after it has already resolved them once). Otherwise, on package-root
 * imports the injected config resolver runs the full 4-step resolution
 * (defaults → `~/.smplkit` file → environment variables → constructor
 * options). Via the `@smplkit/sdk/*` edge entries the same resolution applies
 * minus the file step: defaults → `SMPLKIT_API_KEY` / `SMPLKIT_BASE_DOMAIN` /
 * `SMPLKIT_SCHEME` / `SMPLKIT_ENVIRONMENT` / `SMPLKIT_SERVICE` environment
 * variables → constructor options.
 *
 * @param subdomain - The service subdomain the sub-client talks to (e.g.
 *   `"audit"`, `"flags"`); composed with the resolved scheme/base domain when
 *   no explicit `baseUrl` is given.
 * @internal
 */
export function resolveSubclientConfig(
  subdomain: string,
  options: SubclientConfigOptions,
): ResolvedSubclientConfig {
  if (
    options.apiKey !== undefined &&
    options.baseUrl !== undefined &&
    options.environment !== undefined
  ) {
    return {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      scheme: options.scheme ?? "https",
      baseDomain: options.baseDomain ?? "smplkit.com",
      environment: options.environment,
      service: options.service,
    };
  }
  if (_resolver !== null) {
    const cfg = _resolver(options);
    return {
      apiKey: options.apiKey ?? cfg.apiKey,
      baseUrl: options.baseUrl ?? serviceUrl(cfg.scheme, subdomain, cfg.baseDomain),
      scheme: cfg.scheme,
      baseDomain: cfg.baseDomain,
      environment: options.environment ?? cfg.environment ?? undefined,
      service: options.service ?? cfg.service ?? undefined,
    };
  }
  const apiKey = options.apiKey ?? envConfigValue("SMPLKIT_API_KEY");
  if (apiKey === undefined) {
    throw new SmplError(
      "No API key provided. Pass apiKey to the constructor, set the SMPLKIT_API_KEY environment " +
        'variable, or import the client from the package root ("@smplkit/sdk") to also resolve ' +
        "it from ~/.smplkit.",
    );
  }
  const scheme = options.scheme ?? envConfigValue("SMPLKIT_SCHEME") ?? "https";
  const baseDomain = options.baseDomain ?? envConfigValue("SMPLKIT_BASE_DOMAIN") ?? "smplkit.com";
  return {
    apiKey,
    baseUrl: options.baseUrl ?? serviceUrl(scheme, subdomain, baseDomain),
    scheme,
    baseDomain,
    environment: options.environment ?? envConfigValue("SMPLKIT_ENVIRONMENT"),
    service: options.service ?? envConfigValue("SMPLKIT_SERVICE"),
  };
}
