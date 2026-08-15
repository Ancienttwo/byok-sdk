/**
 * The build projection, asserted where it actually has to hold: in `dist/`.
 *
 * `migrationsDir()` resolves relative to its own module URL, so calling it from
 * `src/` answers about `src/` — true, and useless. What ships is the bundle, so
 * these cases import the built entry point and compare what it points at with
 * `deploy/sql`, filename set and bytes, in both directions. A migration added
 * upstream and not copied, a stale file left behind by a non-clean copy, and an
 * edited copy all fail here — the same property the release smoke asserts on
 * the tarball, one step earlier and without a pack.
 *
 * Needs a build first, like the rest of this workspace (`bun run build` runs
 * before `bun run test` in CI for the same reason). Missing `dist/` is a hard
 * failure rather than a skip: a silently skipped projection check is exactly
 * the hole this file exists to close.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIST_ENTRY = new URL('../../dist/index.js', import.meta.url);
const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

/**
 * `.sql` only — `deploy/sql/` also holds a `.gitkeep`, and the runner itself
 * ignores every non-`.sql` entry, so the projection copies what the runner
 * reads rather than what the directory happens to contain.
 */
function digests(directory: string): Record<string, string> {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  return Object.fromEntries(
    entries.map((name) => [
      name,
      createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex'),
    ]),
  );
}

if (!existsSync(DIST_ENTRY)) {
  throw new Error(`build this package before running its tests: ${fileURLToPath(DIST_ENTRY)} is missing`);
}

const { migrationsDir } = (await import(DIST_ENTRY.href)) as { migrationsDir: () => string };

describe('migrationsDir', () => {
  it('returns an absolute path inside the built package', () => {
    const directory = migrationsDir();
    expect(path.isAbsolute(directory)).toBe(true);
    expect(directory).toBe(fileURLToPath(new URL('../../dist/sql', import.meta.url)));
    expect(statSync(directory).isDirectory()).toBe(true);
  });

  it('carries deploy/sql byte-for-byte, with nothing missing and nothing extra', () => {
    const expected = digests(DEPLOY_SQL);
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    expect(digests(migrationsDir())).toEqual(expected);
  });

  it('hands the runner a directory it can read', async () => {
    const { readMigrationFiles } = await import('../migrate');
    const files = await readMigrationFiles(migrationsDir());
    expect(files.map((file) => file.version)).toEqual(Object.keys(digests(DEPLOY_SQL)));
  });
});
