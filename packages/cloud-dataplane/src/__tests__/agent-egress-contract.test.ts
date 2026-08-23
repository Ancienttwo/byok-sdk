import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresAgentEgressStore } from '../stores/agent-egress';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-agent-egress');
const OTHER_TENANT = tenantId('tenant-agent-egress-other');
const CONTENT_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function payload(eventId = '10000000-0000-4000-8000-000000000030') {
  return {
    agentRef: { agentId: 'agent-postgres', profileRevision: 'profile-postgres' },
    sessionRef: 'session-postgres',
    policyRevision: 'policy-postgres',
    eventId,
    cursor: 11,
    payload: { kind: 'status', value: 'ready' },
    contentHash: CONTENT_HASH,
    byteCount: 33,
  };
}

describe.skipIf(SKIP_DATAPLANE)(`Postgres Agent egress contract — ${SKIP_REASON}`, () => {
  it('keeps the first exact egress receipt across replay, tenant boundary, and restarted adapter', async () => {
    const scope = await createDataplaneScope();
    let restarted: ReturnType<typeof scope.openRestartPool> | undefined;
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const store = new PostgresAgentEgressStore(scope.pool, clock);
      const input = payload();
      const first = await store.record(TENANT, {
        deviceId: 'device-postgres',
        payload: input,
        receiptId: '10000000-0000-4000-8000-000000000031',
      });
      expect(first.created).toBe(true);
      expect(first.record).toMatchObject({
        tenantId: TENANT,
        deviceId: 'device-postgres',
        payload: input,
        receiptId: '10000000-0000-4000-8000-000000000031',
      });

      clock.advance(1_000);
      const replay = await store.record(TENANT, {
        deviceId: 'device-postgres',
        payload: input,
        receiptId: '10000000-0000-4000-8000-000000000032',
      });
      expect(replay).toEqual({ record: first.record, created: false });
      expect(await store.get(OTHER_TENANT, 'device-postgres', input.eventId)).toBeUndefined();

      restarted = scope.openRestartPool();
      const afterRestart = new PostgresAgentEgressStore(restarted, clock);
      expect(await afterRestart.get(TENANT, 'device-postgres', input.eventId)).toEqual(first.record);
    } finally {
      await restarted?.end();
      await scope.dispose();
    }
  });
});
