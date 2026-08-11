import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sqliteMocks = vi.hoisted(() => ({
  openSqliteDatabase: vi.fn(),
  secureSqliteFilePermissions: vi.fn(),
}));

vi.mock('./sqlite-support', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sqlite-support')>()),
  openSqliteDatabase: sqliteMocks.openSqliteDatabase,
  secureSqliteFilePermissions: sqliteMocks.secureSqliteFilePermissions,
}));

const sqliteSupport = await vi.importActual<typeof import('./sqlite-support')>('./sqlite-support');
const { SqliteProviderProfileStore } = await import('./sqlite-profile-store');

const directories: string[] = [];

function tempDbPath(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return join(directory, 'provider-profile.db');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe.skipIf(!sqliteSupport.isSqliteAvailable())('keys SQLite open lifecycle', () => {
  it.each(['after-open', 'after-wal', 'after-synchronous'] as const)(
    'closes the native handle when initialization fails at %s',
    (faultStep) => {
      let opened = 0;
      let closed = 0;

      expect(() =>
        sqliteSupport.openSqliteDatabase(tempDbPath(`byok-keys-sqlite-${faultStep}-`), undefined, {
          onStep(step) {
            if (step === 'after-open') opened += 1;
            if (step === faultStep) throw new Error(`injected fault at ${faultStep}`);
          },
          close(database) {
            closed += 1;
            database.close();
          },
        }),
      ).toThrow(`injected fault at ${faultStep}`);

      expect({ closed, opened }).toEqual({ closed: 1, opened: 1 });
    },
  );

  it('surfaces initialization and cleanup failures together', () => {
    const initializationError = new Error('injected initialization failure');
    const cleanupError = new Error('injected cleanup report failure');

    expect(() =>
      sqliteSupport.openSqliteDatabase(tempDbPath('byok-keys-sqlite-cleanup-failure-'), undefined, {
        onStep(step) {
          if (step === 'after-open') throw initializationError;
        },
        close(database) {
          database.close();
          throw cleanupError;
        },
      }),
    ).toThrow(
      expect.objectContaining({
        errors: [initializationError, cleanupError],
      }),
    );
  });
});

describe('SqliteProviderProfileStore construction lifecycle', () => {
  it('closes the native handle when schema initialization fails', () => {
    const error = new Error('profile schema failed');
    const close = vi.fn();
    const database = {
      close,
      exec: vi.fn(() => {
        throw error;
      }),
    } as unknown as DatabaseSync;
    sqliteMocks.openSqliteDatabase.mockReturnValueOnce(database);

    expect(() => new SqliteProviderProfileStore({ path: ':memory:' })).toThrow(error);
    expect(sqliteMocks.openSqliteDatabase).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
