import { describe, expect, it } from 'vitest';
import { isSqliteCapableNodeVersion, SqliteUnavailableError } from '../sqlite-support';

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
});
