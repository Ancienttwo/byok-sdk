import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * #1123: `BYOK_REQUIRE_SQLITE=1` is the CI half of the SQLite gate. A suite
 * that skips itself when `node:sqlite` cannot be loaded must let that flag
 * turn the skip into a failure, or a green CI run can cover an unavailable
 * runtime without running the SQLite assertions at all.
 *
 * #1155 converted the existing suites to that contract. This scan keeps new
 * suites from quietly reintroducing the old `describe.skip`-only gate: a
 * failure here means "add `|| process.env.BYOK_REQUIRE_SQLITE === '1'` to the
 * skip condition", not "delete the suite".
 */
const packagesRoot = fileURLToPath(new URL('../../packages/', import.meta.url));

test('every SQLite-gated suite honors BYOK_REQUIRE_SQLITE', () => {
  const offenders = [];
  for (const packageName of readdirSync(packagesRoot)) {
    const sourceRoot = join(packagesRoot, packageName, 'src');
    let files;
    try {
      files = readdirSync(sourceRoot, { recursive: true });
    } catch {
      continue;
    }
    for (const file of files.filter(name => typeof name === 'string' && name.endsWith('.test.ts'))) {
      const text = readFileSync(join(sourceRoot, file), 'utf8');
      // A skip gate is a module-level `describe.skip`/`describe.skipIf` that
      // consults SQLite availability; suites that merely assert the helper's
      // behaviour (`sqlite-support.test.ts`, `journal-unavailable.test.ts`)
      // must keep running on every runtime and are not gates.
      if (!text.includes('isSqliteAvailable()')) continue;
      if (!/describe\.skip/.test(text)) continue;
      if (text.includes('BYOK_REQUIRE_SQLITE')) continue;
      offenders.push(`packages/${packageName}/src/${file}`);
    }
  }
  assert.deepEqual(offenders, [],
    `SQLite-gated suites must consult BYOK_REQUIRE_SQLITE so an unavailable runtime fails instead of skipping: ${offenders.join(', ')}`);
});
