/**
 * Where this package's own migration files are.
 *
 * `migrate(pool, directory)` takes a directory rather than defaulting to one,
 * because a runner that guesses where a host keeps deployment assets can
 * silently migrate nothing. That contract is unchanged — this function just
 * means the answer no longer has to come from a git checkout the installed
 * package cannot see. The build copies `deploy/sql/*.sql` into `dist/sql/`
 * (`scripts/copy-migrations.mjs`), so the files sit next to the compiled entry
 * point and resolve relative to it.
 *
 * Resolution is relative to THIS module's own URL, never to `process.cwd()` or
 * a `require.resolve` of the package name: an installed copy is the only thing
 * in reach, and `fileURLToPath` is what turns a `file:///C:/...` URL into a path
 * Windows can open.
 */
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the migration directory shipped inside this package, ready
 * to hand to {@link migrate}. The directory exists in an installed package and
 * in this repository after a build; it does not exist in an unbuilt checkout,
 * where `deploy/sql/` is the thing to read.
 */
export function migrationsDir(): string {
  return fileURLToPath(new URL('./sql', import.meta.url));
}
