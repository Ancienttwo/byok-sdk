/**
 * The no-silent-downgrade proof (architecture §12.7.2).
 *
 * This file has its own module mock, so it is deliberately separate from
 * `journal-sqlite.test.ts` — and deliberately NOT gated behind
 * `skipIf(!isSqliteAvailable())`. It has to run on EVERY Node version this SDK
 * supports, including the Node 20 hosts where `node:sqlite` genuinely does not
 * exist, because the behaviour under test is exactly what happens there: the
 * journal refuses to be constructed rather than standing in for itself with
 * something that cannot fsync.
 *
 * A skipped test here would skip on precisely the runtimes the rule exists
 * for.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../daemon/journal/sqlite-support', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon/journal/sqlite-support')>();
  return { ...actual, isSqliteAvailable: () => false };
});

const { SqliteLocalTaskJournal } = await import('../daemon/journal/sqlite-journal');
const { JournalUnavailableError } = await import('../daemon/journal/journal');

describe('hosted journal mode on a runtime without node:sqlite', () => {
  it('refuses to construct, with a typed error, before touching the filesystem', () => {
    // A storeDir that does not exist and must not be created: the refusal is
    // the whole behaviour, and a refusal that leaves directories behind is
    // evidence the guard ran too late.
    const storeDir = '/nonexistent-byok-journal-store-dir/should-never-be-created';

    let thrown: unknown;
    try {
      new SqliteLocalTaskJournal({ storeDir });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(JournalUnavailableError);
    expect((thrown as Error).message).toMatch(/node:sqlite/);
    // The rejected alternative is named in the error, so an operator who hits
    // this does not go looking for a file-journal fallback that deliberately
    // does not exist.
    expect((thrown as Error).message).toMatch(/plain-file journal is not an acceptable substitute/);
  });
});
