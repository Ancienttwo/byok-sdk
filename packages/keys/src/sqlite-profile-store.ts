import type { DatabaseSync } from 'node:sqlite';

import {
  type ProviderProfileStore,
  providerNotConfigured,
} from './profile-store';
import {
  MODEL_PROVIDER_IDS,
  type ModelProviderId,
  type ModelProviderProfile,
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
  provider_id  TEXT PRIMARY KEY CHECK (provider_id IN ('openai', 'deepseek', 'anthropic', 'custom')),
  kind         TEXT NOT NULL CHECK (kind = 'model'),
  adapter      TEXT NOT NULL CHECK (adapter IN ('openai_compatible', 'anthropic')),
  display_name TEXT NOT NULL,
  base_url     TEXT NOT NULL,
  auth_mode    TEXT NOT NULL CHECK (auth_mode IN ('bearer', 'x_api_key', 'none')),
  model        TEXT NOT NULL,
  enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
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
  created_at: string;
  display_name: string;
  enabled: number;
  kind: string;
  model: string;
  provider_id: string;
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
    this.#database = openSqliteDatabase(options.path);
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

  /**
   * Idempotent, as {@link ProviderProfileStore.close} requires: `node:sqlite`
   * throws "database is not open" on a second `close()`, and a store is
   * routinely closed both by the code that finished with it and by a test's
   * teardown.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  delete(providerId: ModelProviderId): boolean {
    const result = this.#database
      .prepare('DELETE FROM provider_profile WHERE provider_id = ?')
      .run(providerId);
    return Number(result.changes) === 1;
  }

  get(providerId: ModelProviderId): ModelProviderProfile | undefined {
    const row = this.#database
      .prepare('SELECT * FROM provider_profile WHERE provider_id = ?')
      .get(providerId) as ProfileRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  getEnabled(): ModelProviderProfile | undefined {
    const row = this.#database
      .prepare('SELECT * FROM provider_profile WHERE enabled = 1')
      .get() as ProfileRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  list(): ModelProviderProfile[] {
    const rows = this.#database
      .prepare('SELECT * FROM provider_profile ORDER BY provider_id ASC')
      .all() as unknown as ProfileRow[];
    return rows.map(parseRow);
  }

  save(profile: ModelProviderProfile): ModelProviderProfile {
    const validated = parseModelProviderProfile({
      ...profile,
      created_at: this.get(profile.provider_id)?.created_at ?? profile.created_at,
    });
    this.#transaction(() => {
      if (validated.enabled) {
        this.#database
          .prepare(
            'UPDATE provider_profile SET enabled = 0 WHERE provider_id <> ?',
          )
          .run(validated.provider_id);
      }
      this.#database
        .prepare(
          `INSERT INTO provider_profile (
             provider_id, kind, adapter, display_name, base_url,
             auth_mode, model, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id) DO UPDATE SET
             adapter = excluded.adapter,
             display_name = excluded.display_name,
             base_url = excluded.base_url,
             auth_mode = excluded.auth_mode,
             model = excluded.model,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`,
        )
        .run(
          validated.provider_id,
          validated.kind,
          validated.adapter,
          validated.display_name,
          validated.base_url,
          validated.auth_mode,
          validated.model,
          validated.enabled ? 1 : 0,
          validated.created_at,
          validated.updated_at,
        );
    });
    return this.get(validated.provider_id) as ModelProviderProfile;
  }

  setEnabled(providerId: ModelProviderId): ModelProviderProfile {
    const existing = this.get(providerId);
    if (existing === undefined) throw providerNotConfigured(providerId);
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
 * the schema, so it is converted rather than coerced loosely.
 */
function parseRow(row: ProfileRow): ModelProviderProfile {
  return parseModelProviderProfile({
    ...row,
    enabled: row.enabled === 1,
  });
}

/** Exported for the store's own tests to enumerate the CHECK-constrained ids. */
export const SQLITE_PROFILE_PROVIDER_IDS = MODEL_PROVIDER_IDS;
