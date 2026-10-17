import { fileURLToPath } from 'node:url';
import { createMutableClock } from '@byok-sdk/core';
import { runAgentMessageDraftConformance } from '@byok-sdk/conformance';
import { describe, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresAgentMessageDraftStore } from '../stores/agent-message-draft';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';
if (SKIP_DATAPLANE) {
  describe.skip(`Agent message draft [postgres] — ${SKIP_REASON}`, () => { it('needs a dataplane substrate', () => undefined); });
} else {
  runAgentMessageDraftConformance('postgres', {
    async create() {
      const scope = await createDataplaneScope();
      await migrate(scope.pool, fileURLToPath(new URL('../../../../deploy/sql', import.meta.url)));
      const clock = createMutableClock();
      return { store: new PostgresAgentMessageDraftStore(scope.pool, clock), clock,
        advanceTime: ms => clock.advance(ms), dispose: () => scope.dispose() };
    },
  });
}
