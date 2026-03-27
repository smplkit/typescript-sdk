/**
 * Authentication handling for API key auth.
 *
 * @internal This module is not part of the public API.
 */

/**
 * Build the Authorization header value for Bearer token auth.
 *
 * @param apiKey - The API key to use for authentication.
 * @returns The header value string in the form `Bearer {apiKey}`.
 */
export function buildAuthHeader(apiKey: string): string {
  return `Bearer ${apiKey}`;
}
