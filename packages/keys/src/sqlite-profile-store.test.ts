import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import type { ModelProviderProfile } from './provider-profile';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable, openSqliteDatabase } from './sqlite-support';

// node:sqlite requires Node 22.5+, and shipped behind --experimental-sqlite
// until later in the 22.x line — so "Node >= 22.5" alone doesn't mean the
// module actually loads. Gate on ACTUAL availability (attempts the real
// require — see sqlite-support.ts's isSqliteAvailable), not a version-number
// heuristic, so this correctly skips on any runtime where node:sqlite isn't
// really usable (the CI Node 20 leg, or an intermediate flagged 22.x) and
// still runs on one where it is.
const sqliteReady = isSqliteAvailable();

/**
 * On-disk behaviour only — the shared contract suite in `profile-store.test.ts`
 * already covers query semantics against `:memory:` for both implementations.
 * Every file here lives in a `mkdtempSync` directory removed in `afterEach`, so
 * nothing is left on the machine.
 */
const profile = (
  profile_ref: 'anthropic' | 'custom' | 'deepseek' | 'groq' | 'openai',
  overrides: Partial<ModelProviderProfile> = {},
): ModelProviderProfile =>
  ({
    // A vendor kind must speak its catalog adapter, so the anthropic row is
    // built in its own dialect rather than as an OpenAI-compatible one.
    ...(profile_ref === 'anthropic'
      ? {
          adapter: 'anthropic',
          auth_mode: 'x_api_key',
          base_url: 'https://api.anthropic.com/v1',
          display_name: 'Anthropic',
        }
      : {
          adapter: 'openai_compatible',
          auth_mode: 'bearer',
          base_url: 'https://api.openai.com/v1',
          display_name: 'OpenAI',
        }),
    capabilities: [],
    created_at: '2026-08-05T00:00:00.000Z',
    enabled: true,
    kind: 'model',
    model: 'gpt-5.2',
    profile_ref,
    provider_kind: profile_ref,
    updated_at: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }) as ModelProviderProfile;

/**
 * The `provider_profile` DDL this package emitted before the vendor catalog
 * derived the CHECK lists, copied verbatim so the stale-schema guard is proven
 * against a real earlier statement rather than an invented one.
 */
const PRE_CATALOG_SCHEMA = `
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

const expectSchemaStale = (open: () => SqliteProviderProfileStore): void => {
  let thrown: unknown;
  try {
    open();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ByokKeysError);
  expect((thrown as ByokKeysError).code).toBe('PROVIDER_STORE_SCHEMA_STALE');
};

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'byok-keys-sqlite-'));
  databasePath = join(directory, 'nested', 'provider-profile.sqlite');
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

describe.skipIf(!sqliteReady)('SqliteProviderProfileStore on disk', () => {
  it('creates its parent directory owner-only', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.close();
    expect(statSync(join(directory, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('locks the database file to owner-only read/write', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.close();
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it('persists a profile across a reopen', async () => {
    const first = new SqliteProviderProfileStore({ path: databasePath });
    await first.save(profile('openai'));
    await first.close();

    const second = new SqliteProviderProfileStore({ path: databasePath });
    await expect(second.get('openai')).resolves.toMatchObject({
      model: 'gpt-5.2',
      profile_ref: 'openai',
    });
    await second.close();
  });

  it('opens an existing profile database read-only and never creates a missing one', async () => {
    const writer = new SqliteProviderProfileStore({ path: databasePath });
    await writer.save(profile('openai'));
    await writer.close();

    const reader = new SqliteProviderProfileStore({ path: databasePath, readOnly: true });
    expect((await reader.get('openai'))?.model).toBe('gpt-5.2');
    await reader.close();

    const missingPath = join(directory, 'missing', 'profiles.sqlite');
    expect(() => new SqliteProviderProfileStore({ path: missingPath, readOnly: true })).toThrow();
    expect(existsSync(missingPath)).toBe(false);
  });

  it('re-validates a row on read, so a reopen cannot hand back a bad profile', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.save(profile('openai'));
    await store.close();

    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    expect((await reopened.get('openai'))?.enabled).toBe(true);
    expect(typeof (await reopened.get('openai'))?.enabled).toBe('boolean');
    await reopened.close();
  });

  it('lets the database itself enforce the one-enabled invariant', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.save(profile('openai'));
    await store.save(profile('deepseek', { base_url: 'https://api.deepseek.com' }));
    await store.close();

    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    expect((await reopened.list()).filter((entry) => entry.enabled)).toHaveLength(1);
    await reopened.close();
  });

  it('keeps two custom profiles as separate rows on disk', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.save(
      profile('custom', {
        base_url: 'https://openrouter.ai/api/v1',
        profile_ref: 'openrouter-primary',
      } as Partial<ModelProviderProfile>),
    );
    await store.save(
      profile('custom', {
        base_url: 'https://openrouter.ai/api/v1',
        enabled: false,
        profile_ref: 'openrouter-backup',
      } as Partial<ModelProviderProfile>),
    );
    await store.close();

    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    expect((await reopened.list()).map((entry) => entry.profile_ref)).toEqual([
      'openrouter-backup',
      'openrouter-primary',
    ]);
    await reopened.close();
  });

  it('rolls back a failed save rather than leaving a partial row', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.save(profile('openai'));
    await expect(
      store.save(profile('deepseek', { base_url: 'http://evil.example.com' })),
    ).rejects.toThrow();
    await expect(store.get('deepseek')).resolves.toBeUndefined();
    expect((await store.get('openai'))?.enabled).toBe(true);
    await store.close();
  });

  it('round-trips a catalog vendor kind the pre-catalog CHECK did not allow', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.save(
      profile('groq', { base_url: 'https://api.groq.com/openai/v1' }),
    );
    await store.close();

    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    await expect(reopened.get('groq')).resolves.toMatchObject({
      base_url: 'https://api.groq.com/openai/v1',
      provider_kind: 'groq',
    });
    await reopened.close();
  });

  it('fails closed on a store created by an earlier schema instead of migrating it', async () => {
    const legacy = openSqliteDatabase(databasePath);
    legacy.exec(PRE_CATALOG_SCHEMA);
    legacy.close();

    expectSchemaStale(
      () => new SqliteProviderProfileStore({ path: databasePath }),
    );
    expectSchemaStale(
      () => new SqliteProviderProfileStore({ path: databasePath, readOnly: true }),
    );

    // The failed opens released their native handles, so the file is still an
    // ordinary file the fixture can delete.
    rmSync(databasePath, { force: true });
    expect(existsSync(databasePath)).toBe(false);
  });

  it('reopens a store this version created without a false stale-schema alarm', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.save(profile('openai'));
    await store.close();

    const writable = new SqliteProviderProfileStore({ path: databasePath });
    expect((await writable.get('openai'))?.provider_kind).toBe('openai');
    await writable.close();

    const reader = new SqliteProviderProfileStore({
      path: databasePath,
      readOnly: true,
    });
    expect((await reader.get('openai'))?.provider_kind).toBe('openai');
    await reader.close();
  });

  it('declares no column that could hold a secret', async () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    await store.save(profile('openai'));
    await store.close();

    // Asserted structurally rather than by sniffing the file for substrings:
    // the schema legitimately contains "x_api_key" (the auth-mode enum) and a
    // byte-level search for "api_key" therefore matches the CHECK constraint
    // rather than any leaked credential. The property that matters is which
    // columns exist; "the canary value is absent from the bytes" is asserted
    // against a real secret in `registry.golden.test.ts`.
    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    const columns = Object.keys(
      (await reopened.get('openai')) as Record<string, unknown>,
    ).sort();
    await reopened.close();

    expect(columns).toEqual([
      'adapter',
      'auth_mode',
      'base_url',
      'capabilities',
      'created_at',
      'display_name',
      'enabled',
      'kind',
      'model',
      'profile_ref',
      'provider_kind',
      'updated_at',
    ]);
  });
});
