import { describe, expect, it } from 'vitest';
import { isSqliteAvailable, isSqliteCapableNodeVersion, openSqliteDatabase, SqliteUnavailableError } from '../sqlite-support';

/**
 * `SqliteTaskStore`/`SqliteBlobStore` require Node.js 22.5+ (`node:sqlite`'s
 * minimum). This dev/CI machine is already on a qualifying Node version, so
 * the real "module genuinely unavailable" path can't be triggered end to
 * end here — these tests instead exercise the two pieces that make the
 * guard clear and reliable: the version-string predicate itself (pure,
 * deterministic, no process/module mocking required) and the error shape
 * every caller actually sees.
 */
describe('SQLite availability guard', () => {
  it('isSqliteCapableNodeVersion accepts 22.5+ and rejects anything older', () => {
    expect(isSqliteCapableNodeVersion('22.5.0')).toBe(true);
    expect(isSqliteCapableNodeVersion('22.22.3')).toBe(true); // this machine
    expect(isSqliteCapableNodeVersion('22.10.5')).toBe(true);
    expect(isSqliteCapableNodeVersion('23.0.0')).toBe(true);
    expect(isSqliteCapableNodeVersion('24.1.2')).toBe(true);

    expect(isSqliteCapableNodeVersion('22.4.9')).toBe(false);
    expect(isSqliteCapableNodeVersion('22.0.0')).toBe(false);
    expect(isSqliteCapableNodeVersion('20.11.0')).toBe(false);
    expect(isSqliteCapableNodeVersion('18.19.0')).toBe(false);
  });

  it('treats an unparsable version string as capable (require() stays the authoritative gate)', () => {
    expect(isSqliteCapableNodeVersion('not-a-version')).toBe(true);
    expect(isSqliteCapableNodeVersion('')).toBe(true);
  });

  it('SqliteUnavailableError carries a clear, actionable message and preserves the original cause', () => {
    const cause = new Error('Cannot find module node:sqlite');
    const err = new SqliteUnavailableError(cause);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SqliteUnavailableError');
    expect(err.message).toMatch(/node:sqlite is unavailable/i);
    expect(err.message).toMatch(/22\.5/);
    expect(err.message).toMatch(/InMemoryTaskStore/);
    expect(err.message).toMatch(/LocalDiskBlobStore/);
    expect(err.cause).toBe(cause);
  });

  /**
   * `isSqliteCapableNodeVersion` is a version-string heuristic only: Node
   * 22.5–~22.12 satisfies it yet still required `--experimental-sqlite` to
   * actually load the module, so a test suite gating its `skipIf` on THAT
   * function alone would wrongly attempt (and fail, not skip) SQLite tests
   * on such a runtime. `isSqliteAvailable` is the fix — it attempts the real
   * module load and reports whether that actually succeeded, so it agrees
   * with reality regardless of flag state. This is what
   * `sqlite-task-store.test.ts`/`sqlite-blob-store.test.ts` gate on.
   */
  it('isSqliteAvailable agrees with reality: whenever it reports true, openSqliteDatabase actually works, and whenever it reports false, openSqliteDatabase throws SqliteUnavailableError', () => {
    // Deliberately branches on the live result rather than hardcoding one
    // outcome: this asserts the two independent code paths
    // (isSqliteAvailable's try/catch around loadSqliteModule, and
    // openSqliteDatabase's own call into the same loader) stay consistent
    // with each other on whatever runtime this actually executes on —
    // including the in-between Node 22.x range where node:sqlite exists but
    // needs `--experimental-sqlite`, which this same assertion covers by
    // exercising the `false` branch there instead of skipping.
    if (isSqliteAvailable()) {
      const db = openSqliteDatabase(':memory:');
      db.close();
    } else {
      expect(() => openSqliteDatabase(':memory:')).toThrow(SqliteUnavailableError);
    }
  });
});
