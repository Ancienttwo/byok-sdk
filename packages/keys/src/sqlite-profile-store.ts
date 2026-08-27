import type { DatabaseSync } from 'node:sqlite';

import { ByokKeysError } from './errors';
import {
  type ProviderProfileStore,
  providerNotConfigured,
} from './profile-store';
import {
  MODEL_PROVIDER_KINDS,
  type ModelProviderProfile,
  type ProviderProfileRef,
  parseModelProviderProfile,
} from './provider-profile';
import {
  closeSqliteDatabaseAfterInitializationFailure,
  openSqliteDatabase,
  secureSqliteFilePermissions,
} from './sqlite-support';

export interface SqliteProviderProfileStoreOptions {
  /**
   * Database file path. `:memory:` exercises the SQLite code path without a
   * temp file, but defeats the point of this store (restart-safety) exactly as
   * it does for `@byok-sdk/server`'s `SqliteTaskStore`.
   */
  path: string;
  /** Open an existing profile database without creating or mutating it. */
  readOnly?: boolean;
}

/**
 * Ported from `providers.ts:109-140`, narrowed to the model branch. The
 * source's table also carried `market_data` / `mcp_http` rows and a `tool_name`
 * column; that branch stays in aip-main-open per
 * `docs/researches/HANDOFF-byok-keys.md` §4.5, so the CHECK constraints here
 * are the model half only.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_profile (
  profile_ref   TEXT PRIMARY KEY,
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai', 'deepseek', 'anthropic', 'custom')),
  kind          TEXT NOT NULL CHECK (kind = 'model'),
  adapter       TEXT NOT NULL CHECK (adapter IN ('openai_compatible', 'anthropic')),
  display_name  TEXT NOT NULL,
  base_url      TEXT NOT NULL,
  auth_mode     TEXT NOT NULL CHECK (auth_mode IN ('bearer', 'x_api_key', 'none')),
  model         TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
`;

/**
 * The "at most one enabled profile" invariant, enforced by the database itself
 * rather than only by {@link SqliteProviderProfileStore.save}
 * (`providers.ts:140-144`). A partial unique index means a bug in the write
 * path surfaces as a constraint violation instead of silently producing two
 * defaults.
 */
const ENABLED_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS provider_profile_one_enabled
ON provider_profile(kind)
WHERE enabled = 1;
`;

interface ProfileRow {
  adapter: string;
  auth_mode: string;
  base_url: string;
  capabilities: string;
  created_at: string;
  display_name: string;
  enabled: number;
  kind: string;
  model: string;
  profile_ref: string;
  provider_kind: string;
  updated_at: string;
}

/**
 * SQLite-backed {@link ProviderProfileStore}, following `@byok-sdk/server`'s
 * `SqliteTaskStore` shape. Holds no secret: the API key lives in the injected
 * `SecretStore`, and `registry.golden.test.ts` asserts the plaintext key never
 * appears in this file's bytes.
 */
export class SqliteProviderProfileStore implements ProviderProfileStore {
  readonly #database: DatabaseSync;
  #closed = false;

  constructor(options: SqliteProviderProfileStoreOptions) {
    this.#database = openSqliteDatabase(options.path, {
      readOnly: options.readOnly ?? false,
    });
    if (!options.readOnly) {
      try {
        this.#database.exec(SCHEMA);
        this.#database.exec(ENABLED_INDEX);
        secureSqliteFilePermissions(options.path);
      } catch (error) {
        closeSqliteDatabaseAfterInitializationFailure(
          this.#database,
          error,
          'SqliteProviderProfileStore initialization failed and its native handle could not be closed',
        );
      }
    }
  }

  /**
   * Idempotent, as {@link ProviderProfileStore.close} requires: `node:sqlite`
   * throws "database is not open" on a second `close()`, and a store is
   * routinely closed both by the code that finished with it and by a test's
   * teardown.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  async delete(profileRef: ProviderProfileRef): Promise<boolean> {
    const result = this.#database
      .prepare('DELETE FROM provider_profile WHERE profile_ref = ?')
      .run(profileRef);
    return Number(result.changes) === 1;
  }

  async get(profileRef: ProviderProfileRef): Promise<ModelProviderProfile | undefined> {
    const row = this.#database
      .prepare('SELECT * FROM provider_profile WHERE profile_ref = ?')
      .get(profileRef) as ProfileRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  async getEnabled(): Promise<ModelProviderProfile | undefined> {
    const row = this.#database
      .prepare('SELECT * FROM provider_profile WHERE enabled = 1')
      .get() as ProfileRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  async list(): Promise<ModelProviderProfile[]> {
    const rows = this.#database
      .prepare('SELECT * FROM provider_profile ORDER BY profile_ref ASC')
      .all() as unknown as ProfileRow[];
    return rows.map(parseRow);
  }

  async save(profile: ModelProviderProfile): Promise<ModelProviderProfile> {
    const existing = await this.get(profile.profile_ref);
    const validated = parseModelProviderProfile({
      ...profile,
      created_at: existing?.created_at ?? profile.created_at,
    });
    this.#transaction(() => {
      if (validated.enabled) {
        this.#database
          .prepare(
            'UPDATE provider_profile SET enabled = 0 WHERE profile_ref <> ?',
          )
          .run(validated.profile_ref);
      }
      this.#database
        .prepare(
          `INSERT INTO provider_profile (
             profile_ref, provider_kind, kind, adapter, display_name, base_url,
             auth_mode, model, capabilities, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_ref) DO UPDATE SET
             provider_kind = excluded.provider_kind,
             adapter = excluded.adapter,
             display_name = excluded.display_name,
             base_url = excluded.base_url,
             auth_mode = excluded.auth_mode,
             model = excluded.model,
             capabilities = excluded.capabilities,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        )
        .run(
          validated.profile_ref,
          validated.provider_kind,
          validated.kind,
          validated.adapter,
          validated.display_name,
          validated.base_url,
          validated.auth_mode,
          validated.model,
          JSON.stringify(validated.capabilities),
          validated.enabled ? 1 : 0,
          validated.created_at,
          validated.updated_at,
        );
    });
    return (await this.get(validated.profile_ref)) as ModelProviderProfile;
  }

  async setEnabled(profileRef: ProviderProfileRef): Promise<ModelProviderProfile> {
    const existing = await this.get(profileRef);
    if (existing === undefined) throw providerNotConfigured(profileRef);
    return this.save({ ...existing, enabled: true });
  }

  /** `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, per `providers.ts:1252-1263`. */
  #transaction(body: () => void): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      body();
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * Rows go back through the same zod schema the write path used, so a row that
 * a different process wrote — or an older schema left behind — is rejected
 * rather than trusted. `enabled` is an INTEGER in SQLite and a real boolean in
 * the schema, and `capabilities` is a JSON array in a TEXT column, so both are
 * decoded explicitly and a row that fails to decode is refused rather than
 * quietly downgraded to an empty capability set.
 */
function parseRow(row: ProfileRow): ModelProviderProfile {
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(row.capabilities);
  } catch (cause) {
    throw new ByokKeysError(
      'PROVIDER_PROFILE_INVALID',
      'Provider profile capabilities column is not valid JSON',
      { cause },
    );
  }
  return parseModelProviderProfile({
    ...row,
    capabilities,
    enabled: row.enabled === 1,
  });
}

/** Exported for the store's own tests to enumerate the CHECK-constrained kinds. */
export const SQLITE_PROFILE_PROVIDER_KINDS = MODEL_PROVIDER_KINDS;
