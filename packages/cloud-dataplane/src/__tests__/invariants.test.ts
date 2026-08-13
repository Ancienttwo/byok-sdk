/**
 * Executes `tests/sql/control_plane_invariants.sql` against a freshly migrated
 * schema and asserts it does not raise.
 *
 * That is the whole job. The assertions themselves live in the SQL file and
 * only there (docs/researches/s4a-dataplane-design.md §9): an operator runs the
 * identical file against a production database with `psql -f`, and restating
 * any of its rules here would create a second copy that can disagree with the
 * one operators actually run.
 *
 * The second case is not a restatement of a rule — it is a mutation check.
 * A file of `DO $$` blocks that assert nothing passes exactly as loudly as one
 * that asserts everything, and the difference is invisible in a green run. So
 * one violating index is introduced into a throwaway schema and the file is
 * expected to reject it. Which rule fired, and what the whitelist contains, are
 * questions this file deliberately does not ask.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const INVARIANTS_SQL = readFileSync(
  new URL('../../../../tests/sql/control_plane_invariants.sql', import.meta.url),
  'utf8',
);

describe.skipIf(SKIP_DATAPLANE)('control plane invariants', () => {
  it('hold on a freshly migrated schema', async () => {
    const scope = await createDataplaneScope(2);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      await expect(scope.pool.query(INVARIANTS_SQL)).resolves.toBeDefined();
    } finally {
      await scope.dispose();
    }
  });

  it('reject a schema that violates them', async () => {
    const scope = await createDataplaneScope(2);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      // A naked unique key is the shape §12.6.2 layer 3 exists to forbid: it is
      // what turns "look up by id, then check the tenant" into a reachable code
      // path.
      await scope.pool.query('CREATE UNIQUE INDEX naked_item_idx ON board_item (item_id)');
      await expect(scope.pool.query(INVARIANTS_SQL)).rejects.toThrow();
    } finally {
      await scope.dispose();
    }
  });
});
