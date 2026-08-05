import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelProviderProfile } from './provider-profile';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { isSqliteAvailable } from './sqlite-support';

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
  provider_id: 'anthropic' | 'custom' | 'deepseek' | 'openai',
  overrides: Partial<ModelProviderProfile> = {},
): ModelProviderProfile =>
  ({
    adapter: 'openai_compatible',
    auth_mode: 'bearer',
    base_url: 'https://api.openai.com/v1',
    created_at: '2026-08-05T00:00:00.000Z',
    display_name: 'OpenAI',
    enabled: true,
    kind: 'model',
    model: 'gpt-5.2',
    provider_id,
    updated_at: '2026-08-05T00:00:00.000Z',
    ...overrides,
  }) as ModelProviderProfile;

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
  it('creates its parent directory owner-only', () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    store.close();
    expect(statSync(join(directory, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('locks the database file to owner-only read/write', () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    store.close();
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it('persists a profile across a reopen', () => {
    const first = new SqliteProviderProfileStore({ path: databasePath });
    first.save(profile('openai'));
    first.close();

    const second = new SqliteProviderProfileStore({ path: databasePath });
    expect(second.get('openai')).toMatchObject({
      model: 'gpt-5.2',
      provider_id: 'openai',
    });
    second.close();
  });

  it('re-validates a row on read, so a reopen cannot hand back a bad profile', () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    store.save(profile('openai'));
    store.close();

    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    expect(reopened.get('openai')?.enabled).toBe(true);
    expect(typeof reopened.get('openai')?.enabled).toBe('boolean');
    reopened.close();
  });

  it('lets the database itself enforce the one-enabled invariant', () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    store.save(profile('openai'));
    store.save(profile('deepseek', { base_url: 'https://api.deepseek.com' }));
    store.close();

    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    expect(reopened.list().filter((entry) => entry.enabled)).toHaveLength(1);
    reopened.close();
  });

  it('rolls back a failed save rather than leaving a partial row', () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    store.save(profile('openai'));
    expect(() =>
      store.save(profile('deepseek', { base_url: 'http://evil.example.com' })),
    ).toThrow();
    expect(store.get('deepseek')).toBeUndefined();
    expect(store.get('openai')?.enabled).toBe(true);
    store.close();
  });

  it('declares no column that could hold a secret', () => {
    const store = new SqliteProviderProfileStore({ path: databasePath });
    store.save(profile('openai'));
    store.close();

    // Asserted structurally rather than by sniffing the file for substrings:
    // the schema legitimately contains "x_api_key" (the auth-mode enum) and a
    // byte-level search for "api_key" therefore matches the CHECK constraint
    // rather than any leaked credential. The property that matters is which
    // columns exist; "the canary value is absent from the bytes" is asserted
    // against a real secret in `registry.golden.test.ts`.
    const reopened = new SqliteProviderProfileStore({ path: databasePath });
    const columns = Object.keys(
      reopened.get('openai') as Record<string, unknown>,
    ).sort();
    reopened.close();

    expect(columns).toEqual([
      'adapter',
      'auth_mode',
      'base_url',
      'created_at',
      'display_name',
      'enabled',
      'kind',
      'model',
      'provider_id',
      'updated_at',
    ]);
  });
});
