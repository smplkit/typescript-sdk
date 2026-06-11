/**
 * The Smpl Account client — account-level settings on `client.account`.
 *
 * `AccountClient` exposes the authenticated account's own configuration,
 * mirroring the product UI's Account area:
 *
 * - `account.settings` — get/save the account settings object
 *
 * The settings endpoint isn't JSON:API — its body is a raw JSON object — so the
 * settings sub-client uses `fetch` directly rather than going through a
 * generated client.
 *
 * The client supports two construction shapes:
 *
 * - **Wired** into {@link SmplClient} — built from the app base URL and api key
 *   the top-level client has already resolved. This is the common path.
 * - **Standalone** — `new AccountClient({ apiKey, baseUrl, ... })` resolves the
 *   app base URL itself. There are no pooled transports to tear down (each
 *   settings call opens and closes its own short-lived `fetch`), so `close()`
 *   is a no-op kept for interface symmetry.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { SmplkitConnectionError, throwForStatus } from "../errors.js";
import { resolveManagementConfig, serviceUrl } from "../config.js";
import { AccountSettings } from "./models.js";

/**
 * Resolve the `(appBaseUrl, apiKey, extraHeaders)` for the settings client.
 *
 * `baseUrl`/`apiKey` are used directly when both are supplied (the path the
 * top-level client takes after it has already resolved them); otherwise the
 * management config resolver fills in whatever is missing.
 */
function resolveAccountTarget(options: AccountClientOptions): {
  appUrl: string;
  apiKey: string;
  headers: Record<string, string>;
} {
  const cfg = resolveManagementConfig(options);
  const apiKey = options.apiKey ?? cfg.apiKey;
  const appUrl = options.baseUrl ?? serviceUrl(cfg.scheme, "app", cfg.baseDomain);
  const headers: Record<string, string> = { ...(options.extraHeaders ?? {}) };
  return { appUrl: appUrl.replace(/\/+$/, ""), apiKey, headers };
}

/**
 * Account-settings get/save (`client.account.settings`).
 *
 * The endpoint isn't JSON:API — body is a raw JSON object — so we use `fetch`
 * directly rather than going through a generated client.
 */
export class SettingsClient {
  private readonly _headers: Record<string, string>;

  /** @internal */
  constructor(
    private readonly _appBaseUrl: string,
    apiKey: string,
    extraHeaders?: Record<string, string>,
  ) {
    this._headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(extraHeaders ?? {}),
    };
  }

  async get(): Promise<AccountSettings> {
    const url = `${this._appBaseUrl}/api/v1/accounts/current/settings`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers: this._headers });
    } catch (err) {
      throw new SmplkitConnectionError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throwForStatus(resp.status, body);
    }
    const data = await resp.json();
    return new AccountSettings(this, data ?? {});
  }

  /** @internal */
  async _save(data: Record<string, any>): Promise<AccountSettings> {
    const url = `${this._appBaseUrl}/api/v1/accounts/current/settings`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "PUT",
        headers: this._headers,
        body: JSON.stringify(data),
      });
    } catch (err) {
      throw new SmplkitConnectionError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throwForStatus(resp.status, body);
    }
    const saved = await resp.json();
    return new AccountSettings(this, saved ?? {});
  }
}

/** Configuration options for the {@link AccountClient}. */
export interface AccountClientOptions {
  /** API key. When omitted, resolved from `SMPLKIT_API_KEY` or `~/.smplkit`. */
  apiKey?: string;
  /**
   * Full app-service base URL. Usually resolved from `baseDomain`/`scheme`;
   * supplied directly by the top-level clients which have already computed it.
   */
  baseUrl?: string;
  /** Named `~/.smplkit` profile section. */
  profile?: string;
  /** Base domain for API requests (default `"smplkit.com"`). */
  baseDomain?: string;
  /** URL scheme (default `"https"`). */
  scheme?: string;
  /** Enable SDK debug logging. */
  debug?: boolean;
  /** Extra headers attached to every request. */
  extraHeaders?: Record<string, string>;
}

/**
 * The Smpl Account client.
 *
 * Exposes the authenticated account's own configuration, reachable as
 * `client.account` ({@link SmplClient}) or constructed directly:
 *
 * @example
 * ```typescript
 * import { AccountClient } from "@smplkit/sdk";
 *
 * const account = new AccountClient({ apiKey: "sk_..." });
 * const settings = await account.settings.get();
 * settings.environmentOrder = ["production", "staging"];
 * await settings.save();
 * ```
 *
 * Sub-client: `settings` (get/save). Pure CRUD — no `install()` required.
 */
export class AccountClient {
  readonly settings: SettingsClient;

  constructor(options: AccountClientOptions = {}) {
    const { appUrl, apiKey, headers } = resolveAccountTarget(options);
    this.settings = new SettingsClient(
      appUrl,
      apiKey,
      Object.keys(headers).length > 0 ? headers : undefined,
    );
  }

  /** No-op — the settings client opens a short-lived `fetch` per call. */
  close(): void {}
}
