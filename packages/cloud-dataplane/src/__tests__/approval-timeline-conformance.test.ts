import { fileURLToPath } from 'node:url';
import { createMutableClock } from '@byok-sdk/core';
import {
  runApprovalTimelineConformance,
  type ApprovalTimelineCompositionFactory,
} from '@byok-sdk/conformance';
import { describe, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresApprovalTimelineStore } from '../stores/approval-timeline';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));

const factory: ApprovalTimelineCompositionFactory = {
  async create() {
    const scope = await createDataplaneScope();
    await migrate(scope.pool, DEPLOY_SQL);
    const clock = createMutableClock();
    return {
      store: new PostgresApprovalTimelineStore(scope.pool, clock),
      advanceTime: (ms) => clock.advance(ms),
      dispose: () => scope.dispose(),
    };
  },
};

if (SKIP_DATAPLANE) {
  describe.skip(`approval timeline store conformance [postgres] — ${SKIP_REASON}`, () => {
    it('needs a dataplane substrate', () => undefined);
  });
} else {
  runApprovalTimelineConformance('postgres', factory);
}
