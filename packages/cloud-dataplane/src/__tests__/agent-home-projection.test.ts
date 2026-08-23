import { fileURLToPath } from 'node:url';
import {
  agentHomeProjectionRequestKey,
  readAgentHomeProjectionStatus,
  recordAgentHomeProjectionCompletion,
  type TenantBoundReceipts,
} from '@byok-sdk/cloud';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresRequestReceiptStore } from '../stores/receipts';
import {
  createDataplaneScope,
  SKIP_DATAPLANE,
  SKIP_REASON,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-agent-home-projection');
const OTHER_TENANT = tenantId('tenant-agent-home-projection-other');
const DEVICE = 'agent-home-projection-device';
const OTHER_DEVICE = 'agent-home-projection-other-device';
const REQUEST_ID = '10000000-0000-4000-8000-000000000210';
const HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const desired = {
  requestId: REQUEST_ID,
  agentRef: { agentId: 'durable-projection-agent', profileRevision: '7' },
  projectionHash: HASH,
  projection: { opaque: 'durable' },
} as const;

function tenantReceipts(store: PostgresRequestReceiptStore, tenant: typeof TENANT): TenantBoundReceipts {
  return {
    record: (input) => store.record(tenant, input),
    get: (key) => store.get(tenant, key),
  };
}

describe.skipIf(SKIP_DATAPLANE)(`Postgres Agent-home projection receipts — ${SKIP_REASON}`, () => {
  it('keeps exact request and first completion facts across a fresh composition, tenant boundary, and device boundary', async () => {
    const scope = await createDataplaneScope();
    let restarted: ReturnType<typeof scope.openRestartPool> | undefined;
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const receipts = new PostgresRequestReceiptStore(scope.pool, clock);
      const first = await receipts.record(TENANT, {
        key: agentHomeProjectionRequestKey(DEVICE, REQUEST_ID),
        body: JSON.stringify(desired),
      });
      expect(first.created).toBe(true);
      await expect(
        readAgentHomeProjectionStatus(tenantReceipts(receipts, TENANT), TENANT, DEVICE, {
          requestId: REQUEST_ID,
          agentRef: desired.agentRef,
          projectionHash: HASH,
        }),
      ).resolves.toMatchObject({ status: 'pending', requestId: REQUEST_ID, agentRef: desired.agentRef });

      const completed = await recordAgentHomeProjectionCompletion(
        tenantReceipts(receipts, TENANT),
        TENANT,
        DEVICE,
        { requestId: REQUEST_ID, agentRef: desired.agentRef, projectionHash: HASH, outcome: 'applied' },
      );
      expect(completed).toMatchObject({ status: 'applied', requestId: REQUEST_ID, deviceId: DEVICE });
      await expect(
        recordAgentHomeProjectionCompletion(
          tenantReceipts(receipts, TENANT),
          TENANT,
          DEVICE,
          { requestId: REQUEST_ID, agentRef: desired.agentRef, projectionHash: HASH, outcome: 'stale' },
        ),
      ).rejects.toMatchObject({ code: 'agent_home_projection_completion_conflict' });

      restarted = scope.openRestartPool();
      const afterRestart = new PostgresRequestReceiptStore(restarted, clock);
      await expect(
        readAgentHomeProjectionStatus(tenantReceipts(afterRestart, TENANT), TENANT, DEVICE, {
          requestId: REQUEST_ID,
          agentRef: desired.agentRef,
          projectionHash: HASH,
        }),
      ).resolves.toMatchObject({
        tenantId: TENANT,
        deviceId: DEVICE,
        requestId: REQUEST_ID,
        agentRef: desired.agentRef,
        projectionHash: HASH,
        status: 'applied',
      });
      await expect(
        readAgentHomeProjectionStatus(tenantReceipts(afterRestart, OTHER_TENANT), OTHER_TENANT, DEVICE, {
          requestId: REQUEST_ID,
          agentRef: desired.agentRef,
          projectionHash: HASH,
        }),
      ).resolves.toBeUndefined();
      await expect(
        readAgentHomeProjectionStatus(tenantReceipts(afterRestart, TENANT), TENANT, OTHER_DEVICE, {
          requestId: REQUEST_ID,
          agentRef: desired.agentRef,
          projectionHash: HASH,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await restarted?.end();
      await scope.dispose();
    }
  });
});
