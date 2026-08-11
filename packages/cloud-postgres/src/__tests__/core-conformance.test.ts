/**
 * The Postgres composition running the complete core conformance suite.
 *
 * A factory, and nothing else — the same shape as the cloud-local sibling next
 * to it and the in-memory entries in `@byok-sdk/conformance`. Not one assertion in
 * `runCoreConformance` knows which composition it is running against, and the
 * `packages/conformance/` tree is zero-diff in this slice by design: an
 * assertion that had to be weakened or branched for Postgres would be evidence
 * of a port-contract bug to escalate, never a test to adjust (design §11's red
 * line for this cut).
 *
 * Each test gets a fresh schema, migrated from empty by the real runner over
 * the real `deploy/sql/` files. "Fresh install + migrate-up" (sprint S4A.5) is
 * therefore a property of every single case rather than a step someone
 * remembers, and the DDL under review is the DDL under test.
 *
 * The clock is a mutable one the suite drives. Presence expiry, activity expiry
 * and reservation expiry are all contract behavior, and asserting them against
 * a wall clock means sleeping or accepting flakes — so `advanceTime` moves this
 * clock and every store reads it.
 */
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { runCoreConformance, type CoreCompositionFactory } from '@byok-sdk/conformance';
import { migrate } from '../migrate';
import { createPostgresCoreStores } from '../stores/core/index';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

const postgresFactory: CoreCompositionFactory = {
  async create() {
    const scope = await createDataplaneScope();
    await migrate(scope.pool, DEPLOY_SQL);

    const clock = createMutableClock();
    const stores = createPostgresCoreStores({ pool: scope.pool, clock });

    return {
      stores,
      now: () => clock.now().toISOString(),
      advanceTime: (ms: number) => {
        clock.advance(ms);
      },
      dispose: () => scope.dispose(),
    };
  },
};

if (SKIP_DATAPLANE) {
  // `runCoreConformance` opens its own `describe`, so the skip has to be
  // declared here rather than wrapped around it — and it says why.
  describe.skip(`core conformance [postgres] — ${SKIP_REASON}`, () => {
    it('needs a dataplane substrate', () => undefined);
  });
} else {
  runCoreConformance('postgres', postgresFactory);
}
