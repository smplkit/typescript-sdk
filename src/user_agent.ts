/**
 * Default User-Agent identity for every outbound request the SDK makes.
 *
 * Some edges in front of the platform (e.g. CloudFront's managed WAF rules)
 * reject requests that carry no User-Agent header, and several runtimes —
 * Cloudflare Workers most notably — send none by default. So every HTTP
 * request and WebSocket handshake the wrapper initiates carries
 * `smplkit-sdk-ts/<version>` unless the caller supplied a User-Agent of
 * their own (matched case-insensitively), in which case the caller's value
 * always wins.
 *
 * The version is injected at build time: `tsup.config.ts` `define`s
 * `__SMPLKIT_SDK_VERSION__` from package.json (the release workflow stamps
 * the release version into package.json before the publish build), and
 * `vitest.config.ts` injects the same for tests. Any other loader running
 * un-built source falls back to "0.0.0" — package.json's committed
 * placeholder version.
 *
 * This module has no imports so the `@smplkit/sdk/*` edge subpath entries
 * stay free of Node built-ins and of `ws`.
 *
 * @internal This module is not part of the public API.
 */

declare const __SMPLKIT_SDK_VERSION__: string | undefined;

/** @internal The SDK version embedded at build time. */
export const SDK_VERSION: string =
  typeof __SMPLKIT_SDK_VERSION__ === "string" ? __SMPLKIT_SDK_VERSION__ : "0.0.0";

/** @internal The default User-Agent sent when the caller supplies none. */
export const SDK_USER_AGENT = `smplkit-sdk-ts/${SDK_VERSION}`;

/**
 * Return `headers` with the SDK's default User-Agent added — unless the
 * caller already supplied one under any casing (e.g. via `extraHeaders`),
 * in which case `headers` is returned unchanged so the caller's value wins.
 *
 * @internal
 */
export function withDefaultUserAgent(headers: Record<string, string>): Record<string, string> {
  const callerSet = Object.keys(headers).some((key) => key.toLowerCase() === "user-agent");
  return callerSet ? headers : { ...headers, "User-Agent": SDK_USER_AGENT };
}
