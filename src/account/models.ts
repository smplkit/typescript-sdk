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

  /**
   * The full settings object. Mutations are persisted on `save()`. Assigning
   * replaces the entire settings object.
   */
  get raw(): Record<string, any> {
    return this._data;
  }

  set raw(value: Record<string, any>) {
    this._data = { ...value };
  }

  /**
   * Canonical ordering of STANDARD environments. Empty array if unset. Assign a
   * list of environment ids to set the ordering.
   */
  get environmentOrder(): string[] {
    const val = this._data["environment_order"];
    return Array.isArray(val) ? [...val] : [];
  }

  set environmentOrder(value: string[]) {
    this._data["environment_order"] = [...value];
  }

  /**
   * Write the full settings object back to the account.
   *
   * @throws {@link !Error} If this model was constructed without a client (e.g.
   *   built by hand rather than returned from `get()`).
   */
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

  /**
   * A debug string showing the full settings object.
   *
   * @returns A human-readable representation of these account settings.
   */
  toString(): string {
    return `AccountSettings(${JSON.stringify(this._data)})`;
  }
}
