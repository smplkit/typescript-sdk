/**
 * Active-record models for `client.account.*` resources.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** @internal */
export interface AccountSettingsModelClient {
  _save(data: Record<string, any>): Promise<AccountSettings>;
}

/**
 * Active-record account-settings model.
 *
 * The wire format is opaque JSON. Documented keys are exposed as typed
 * properties; unknown keys live in {@link raw}. `save()` writes the full
 * settings object back.
 */
export class AccountSettings {
  /** @internal */
  private _data: Record<string, any>;

  /** @internal */
  readonly _client: AccountSettingsModelClient | null;

  /** @internal */
  constructor(client: AccountSettingsModelClient | null, data: Record<string, any>) {
    this._client = client;
    this._data = { ...data };
  }

  /** The full settings dict. Mutations are persisted on save(). */
  get raw(): Record<string, any> {
    return this._data;
  }

  set raw(value: Record<string, any>) {
    this._data = { ...value };
  }

  /** Canonical ordering of STANDARD environments. Empty array if unset. */
  get environmentOrder(): string[] {
    const val = this._data["environment_order"];
    return Array.isArray(val) ? [...val] : [];
  }

  set environmentOrder(value: string[]) {
    this._data["environment_order"] = [...value];
  }

  async save(): Promise<void> {
    if (this._client === null) {
      throw new Error("AccountSettings was constructed without a client; cannot save");
    }
    const saved = await this._client._save(this._data);
    this._apply(saved);
  }

  /** @internal */
  _apply(other: AccountSettings): void {
    this._data = { ...other._data };
  }

  toString(): string {
    return `AccountSettings(${JSON.stringify(this._data)})`;
  }
}
