import { describe, expect, it } from 'vitest';
import { sqliteOpenPath } from '../daemon/journal/sqlite-support';

/**
 * #1097: a >MAX_PATH store made SQLite's open fail, and the journal read that
 * failure as corruption: it quarantined a healthy database and the service
 * never came back up. The SQLite VFS needs the extended-length prefix; the
 * rest of the process keeps the plain path.
 */
describe('sqliteOpenPath (#1097)', () => {
  it('leaves a posix path alone', () => {
    expect(sqliteOpenPath('/var/lib/byok/journal.db', 'linux')).toBe('/var/lib/byok/journal.db');
  });

  it('keeps a short Windows path plain', () => {
    expect(sqliteOpenPath('C:\\byok\\journal.db', 'win32')).toBe('C:\\byok\\journal.db');
  });

  it('prefixes a long Windows path exactly once', () => {
    const long = 'D:' + '\\a'.repeat(120) + '\\journal.db';
    expect(long.length).toBeGreaterThan(240);
    const prefixed = sqliteOpenPath(long, 'win32');
    expect(prefixed).toBe('\\\\?\\' + long);
    expect(sqliteOpenPath(prefixed, 'win32')).toBe(prefixed);
  });
});
